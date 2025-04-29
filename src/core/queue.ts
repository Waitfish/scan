/**
 * @file 队列管理系统
 * 用于处理扫描过程中的文件队列，包括匹配队列、稳定性检测队列、MD5计算队列、打包队列和传输队列
 */

import { FileItem, FailureItem } from '../types';
import { QueueConfig, QueueType, StabilityConfig, ArchiveTracker, QueueStats } from '../types/queue';

// 重试队列项
interface RetryQueueItem {
  file: FileItem;
  attempts: number;
  lastAttempt: number;
  targetQueue: QueueType;
}

/**
 * 队列处理状态
 */
export enum QueueItemStatus {
  /** 等待中 */
  WAITING = 'waiting',
  /** 正在处理 */
  PROCESSING = 'processing',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 失败 */
  FAILED = 'failed',
  /** 重试中 */
  RETRYING = 'retrying'
}

/**
 * 队列项
 */
export interface QueueItem {
  /** 文件项 */
  file: FileItem;
  /** 状态 */
  status: QueueItemStatus;
  /** 处理尝试次数 */
  attempts: number;
  /** 最后尝试时间 */
  lastAttempt?: Date;
  /** 错误信息（如果有） */
  error?: string;
  /** 创建时间 */
  createdAt: Date;
  /** 完成时间 */
  completedAt?: Date;
}

/**
 * 文件处理队列系统
 * 用于管理扫描文件的处理过程，支持多阶段队列和重试机制
 */
export class FileProcessingQueue {
  // 各阶段队列
  private matchedQueue: FileItem[] = [];               // 扫描匹配的文件
  private fileStabilityQueue: FileItem[] = [];         // 等待文件稳定性检测的文件
  private archiveStabilityQueue: FileItem[] = [];      // 等待压缩包稳定性检测的文件
  private md5Queue: FileItem[] = [];                   // 等待MD5计算的文件
  private packagingQueue: FileItem[] = [];             // 等待打包的文件
  private transportQueue: FileItem[] = [];             // 等待传输的文件
  
  // 特殊队列
  private retryQueue: Map<string, RetryQueueItem> = new Map(); // 重试队列
  private completedFiles: Map<string, FileItem> = new Map();  // 已完成的文件
  private failedFiles: Map<string, FileItem> = new Map();     // 失败的文件
  
  // 路径映射，用于快速查找文件
  private pathMap: Map<string, FileItem> = new Map();
  
  // 处理中的文件数量
  private processing: Map<QueueType, Set<string>> = new Map([
    ['fileStability', new Set<string>()],
    ['archiveStability', new Set<string>()],
    ['md5', new Set<string>()],
    ['packaging', new Set<string>()],
    ['transport', new Set<string>()],
  ]);
  
  // 压缩包追踪器
  private archiveTracker: ArchiveTracker = {
    archiveToFiles: new Map<string, Set<FileItem>>(),
    isQueued: new Map<string, boolean>(),
    status: new Map<string, 'waiting' | 'processing' | 'stable' | 'unstable' | 'failed'>()
  };
  
  // 配置
  private queueConfig: QueueConfig;
  private stabilityConfig: StabilityConfig;
  
  /**
   * 构造函数
   * @param queueConfig 队列配置
   * @param stabilityConfig 稳定性检测配置
   */
  constructor(queueConfig: QueueConfig, stabilityConfig: StabilityConfig = {}) {
    this.queueConfig = {
      enabled: true,
      maxConcurrentFileChecks: 5,
      maxConcurrentArchiveChecks: 3,
      maxConcurrentMd5: 5,
      maxConcurrentTransfers: 2,
      stabilityRetryDelay: 2000,
      maxStabilityRetries: 3,
      ...queueConfig
    };
    
    this.stabilityConfig = {
      base: {
        enabled: true,
        checkInterval: 500,
        maxRetries: 3,
        ...stabilityConfig.base
      },
      file: {
        enabled: true,
        checkInterval: 500,
        maxRetries: 3,
        largeFileThreshold: 100 * 1024 * 1024, // 100MB
        skipReadForLargeFiles: true,
        ...stabilityConfig.file
      },
      archive: {
        enabled: true,
        checkInterval: 1000,
      maxRetries: 3,
        keepTempFiles: false,
        ...stabilityConfig.archive
      }
    };
    
    // 确保 processing Map 被初始化
    this.initializeProcessingMap();
  }
  
  private initializeProcessingMap(): void {
    this.processing = new Map([
      ['fileStability', new Set<string>()],
      ['archiveStability', new Set<string>()],
      ['md5', new Set<string>()],
      ['packaging', new Set<string>()],
      ['transport', new Set<string>()],
    ]);
  }
  
  /**
   * 将文件添加到匹配队列
   * @param file 文件项
   */
  public addToMatchedQueue(file: FileItem): void {
    this.matchedQueue.push(file);
    this.pathMap.set(file.path, file);
    
    // 如果是压缩包内的文件，添加到压缩包追踪器
    if (file.origin === 'archive' && file.archivePath) {
      this.trackArchiveFile(file);
    }
  }
  
  /**
   * 追踪压缩包内文件
   * @param file 压缩包内文件
   */
  private trackArchiveFile(file: FileItem): void {
    if (!file.archivePath) return;
    
    // 获取或创建此压缩包关联的文件集合
    if (!this.archiveTracker.archiveToFiles.has(file.archivePath)) {
      this.archiveTracker.archiveToFiles.set(file.archivePath, new Set());
      this.archiveTracker.status.set(file.archivePath, 'waiting');
      this.archiveTracker.isQueued.set(file.archivePath, false);
    }
    
    // 将文件添加到压缩包关联集合
    this.archiveTracker.archiveToFiles.get(file.archivePath)!.add(file);
  }
  
  /**
   * 处理匹配队列，根据文件来源将文件分配到对应队列
   */
  public processMatchedQueue(): void {
    // 处理普通文件
    const regularFiles = this.matchedQueue.filter(file => 
      file.origin !== 'archive' || !file.archivePath
    );
    
    // 将普通文件添加到文件稳定性队列
    regularFiles.forEach(file => {
      this.fileStabilityQueue.push(file);
    });
    
    // 处理压缩包文件
    const archiveFiles = this.matchedQueue.filter(file => 
      file.origin === 'archive' && file.archivePath
    );
    
    // 将压缩包文件添加到压缩包追踪器
    archiveFiles.forEach(file => {
      this.trackArchiveFile(file);
    });
    
    // 将需要检测稳定性的压缩包添加到队列
    for (const [archivePath, isQueued] of this.archiveTracker.isQueued.entries()) {
      if (!isQueued && this.archiveTracker.status.get(archivePath) === 'waiting') {
        // 创建一个代表整个压缩包的FileItem
        const archiveStats = this.getArchiveStats(archivePath);
        if (archiveStats) {
          const archiveItem: FileItem = {
            path: archivePath,
            name: archivePath.split('/').pop() || '',
            createTime: archiveStats.createTime,
            modifyTime: archiveStats.modifyTime,
            size: archiveStats.size,
            origin: 'filesystem',
            nestedLevel: 0
          };
          
          // 添加到压缩包稳定性队列
          this.archiveStabilityQueue.push(archiveItem);
          this.archiveTracker.isQueued.set(archivePath, true);
        }
      }
    }
    
    // 清空匹配队列
    this.matchedQueue = [];
  }
  
  /**
   * 获取压缩包统计信息
   * @param archivePath 压缩包路径
   * @returns 压缩包文件统计信息
   */
  private getArchiveStats(archivePath: string): { createTime: Date, modifyTime: Date, size: number } | null {
    const filesInArchive = this.archiveTracker.archiveToFiles.get(archivePath);
    if (!filesInArchive || filesInArchive.size === 0) return null;
    
    // 使用第一个文件的时间戳和大小
    const firstFile = Array.from(filesInArchive)[0];
    return {
      createTime: firstFile.createTime,
      modifyTime: firstFile.modifyTime,
      size: firstFile.size
    };
  }
  
  /**
   * 将文件添加到指定队列
   * @param queueType 队列类型
   * @param file 文件项
   */
  public addToQueue(queueType: QueueType, file: FileItem): void {
    switch (queueType) {
      case 'fileStability':
        this.fileStabilityQueue.push(file);
        break;
      case 'archiveStability':
        this.archiveStabilityQueue.push(file);
        break;
      case 'md5':
        this.md5Queue.push(file);
        break;
      case 'packaging':
        this.packagingQueue.push(file);
        break;
      case 'transport':
        this.transportQueue.push(file);
        break;
    }
    
    // 确保文件在路径映射中
    if (!this.pathMap.has(file.path)) {
      this.pathMap.set(file.path, file);
    }
  }
  
  /**
   * 文件稳定性检测成功后，将关联的压缩包内文件添加到MD5队列
   * @param archivePath 压缩包路径
   */
  public processStableArchive(archivePath: string): void {
    // 标记压缩包为稳定
    this.archiveTracker.status.set(archivePath, 'stable');
    
    // 获取此压缩包内的所有文件
    const filesInArchive = this.archiveTracker.archiveToFiles.get(archivePath);
    if (!filesInArchive) return;
    
    // 将所有文件添加到MD5队列
    filesInArchive.forEach(file => {
      this.md5Queue.push(file);
    });
  }
  
  /**
   * 压缩包稳定性检测失败，将关联的文件标记为失败
   * @param archivePath 压缩包路径
   * @param error 错误信息
   */
  public processUnstableArchive(archivePath: string, error: string): void {
    // 标记压缩包为不稳定
    this.archiveTracker.status.set(archivePath, 'unstable');
    
    // 获取此压缩包内的所有文件
    const filesInArchive = this.archiveTracker.archiveToFiles.get(archivePath);
    if (!filesInArchive) return;
    
    // 为所有文件创建失败项
    const failureItem: FailureItem = {
      type: 'archiveStability',
      path: archivePath,
      error: `压缩包不稳定: ${error}`,
      affectedFiles: Array.from(filesInArchive).map(f => f.path)
    };
    
    // 将所有文件标记为失败
    filesInArchive.forEach(file => {
      this.markAsFailed(file.path, failureItem);
    });
  }
  
  /**
   * 将文件添加到重试队列
   * @param file 文件项
   * @param targetQueue 目标队列类型
   */
  public addToRetryQueue(file: FileItem, targetQueue: QueueType): void {
    const existingItem = this.retryQueue.get(file.path);
    
    const retryItem: RetryQueueItem = existingItem ? {
      ...existingItem,
      attempts: existingItem.attempts + 1,
      lastAttempt: Date.now()
    } : {
      file,
      attempts: 1,
      lastAttempt: Date.now(),
      targetQueue
    };
    
    // 检查是否超过最大重试次数
    const maxRetries = this.getMaxRetriesForQueue(targetQueue);
    
    if (retryItem.attempts > maxRetries) {
      // 超过最大重试次数，标记为失败
      const failureItem: FailureItem = {
        type: this.getFailureTypeForQueue(targetQueue),
        path: file.path,
        error: `超过最大重试次数(${maxRetries})，停止重试`
      };
      
      if (file.origin === 'archive' && file.archivePath) {
        failureItem.entryPath = file.internalPath;
      }
      
      this.markAsFailed(file.path, failureItem);
    } else {
      // 未超过最大重试次数，添加到重试队列
    this.retryQueue.set(file.path, retryItem);
    
    // 确保文件在路径映射中
    if (!this.pathMap.has(file.path)) {
      this.pathMap.set(file.path, file);
      }
    }
  }
  
  /**
   * 根据队列类型获取对应的最大重试次数
   * @param queueType 队列类型
   */
  private getMaxRetriesForQueue(queueType: QueueType): number {
    switch (queueType) {
      case 'fileStability':
        return this.stabilityConfig.file?.maxRetries || 3;
      case 'archiveStability':
        return this.stabilityConfig.archive?.maxRetries || 3;
      default:
        return this.queueConfig.maxStabilityRetries || 3;
    }
  }
  
  /**
   * 根据队列类型获取对应的失败类型
   * @param queueType 队列类型
   */
  private getFailureTypeForQueue(queueType: QueueType): FailureItem['type'] {
    switch (queueType) {
      case 'fileStability':
        return 'stability';
      case 'archiveStability':
        return 'archiveStability';
      case 'md5':
        return 'md5';
      case 'packaging':
        return 'packaging';
      case 'transport':
        return 'transport';
      default:
        return 'scanError';
    }
  }
  
  /**
   * 增加文件的重试次数
   * @param filePath 文件路径
   */
  public incrementRetryCount(filePath: string): void {
    const retryItem = this.retryQueue.get(filePath);
    if (retryItem) {
      retryItem.attempts++;
      retryItem.lastAttempt = Date.now();
      this.retryQueue.set(filePath, retryItem);
    }
  }
  
  /**
   * 从队列中移除文件
   * @param queueType 队列类型
   * @param filePath 文件路径
   */
  private removeFromQueue(queueType: QueueType, filePath: string): void {
    let queue: FileItem[] = [];
    
    switch (queueType) {
      case 'fileStability':
        queue = this.fileStabilityQueue;
        break;
      case 'archiveStability':
        queue = this.archiveStabilityQueue;
        break;
      case 'md5':
        queue = this.md5Queue;
        break;
      case 'packaging':
        queue = this.packagingQueue;
        break;
      case 'transport':
        queue = this.transportQueue;
        break;
    }
    
    const index = queue.findIndex(item => item.path === filePath);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    
    // 从处理中集合移除
    const processingSet = this.processing.get(queueType);
    if (processingSet) {
      processingSet.delete(filePath);
    }
  }
  
  /**
   * 标记文件为完成状态
   * @param filePath 文件路径
   */
  public markAsCompleted(filePath: string): void {
    const file = this.pathMap.get(filePath);
    if (file) {
      // 从所有队列移除
      this.removeFromQueue('fileStability', filePath);
      this.removeFromQueue('archiveStability', filePath);
      this.removeFromQueue('md5', filePath);
      this.removeFromQueue('packaging', filePath);
      this.removeFromQueue('transport', filePath);
      
      // 从重试队列移除
      this.retryQueue.delete(filePath);
      
      // 添加到已完成集合
      this.completedFiles.set(filePath, file);
    }
  }
  
  /**
   * 标记文件为失败状态
   * @param filePath 文件路径
   * @param failureItem 可选的失败信息
   */
  public markAsFailed(filePath: string, failureItem?: FailureItem): void {
    const file = this.pathMap.get(filePath);
    if (file) {
      // 从所有队列移除
      this.removeFromQueue('fileStability', filePath);
      this.removeFromQueue('archiveStability', filePath);
      this.removeFromQueue('md5', filePath);
      this.removeFromQueue('packaging', filePath);
      this.removeFromQueue('transport', filePath);
      
      // 从重试队列移除
      this.retryQueue.delete(filePath);
      
      // 添加到失败集合
      this.failedFiles.set(filePath, file);
      
      // 如果是压缩包，更新压缩包状态
      if (failureItem && failureItem.type === 'archiveStability' && file.origin === 'filesystem') {
        this.archiveTracker.status.set(filePath, 'failed');
      }
    }
  }
  
  /**
   * 获取指定队列的处理中文件集合
   * @param queueType 队列类型
   */
  public getProcessingSet(queueType: QueueType): Set<string> | undefined {
    return this.processing.get(queueType);
  }
  
  /**
   * 批量处理队列中的下一批文件
   * @param targetQueue 目标队列类型
   * @param batchSize 批处理大小
   * @param processor 处理函数
   */
  public processNextBatch(
    targetQueue: QueueType, 
    batchSize: number, 
    processor: (files: FileItem[]) => void
  ): void {
    const originalQueue = this.getOriginalQueue(targetQueue);
    if (!originalQueue) {
      console.error(`无效的队列类型: ${targetQueue}`);
        return;
    }
    
    // 调整批处理大小，确保不超过配置的并发数
    const maxConcurrent = this.getMaxConcurrentForQueue(targetQueue);
    const processingSet = this.processing.get(targetQueue) || new Set();
    const availableSlots = Math.max(0, maxConcurrent - processingSet.size);
    const actualBatchSize = Math.min(batchSize, availableSlots, originalQueue.length); // 使用原始队列长度
    
    // 从原始队列获取批次
    const batch = originalQueue.slice(0, actualBatchSize);
    if (batch.length === 0) return;
    
    // 从原始队列移除 (现在从头部移除)
    originalQueue.splice(0, actualBatchSize); // 从原始队列移除处理中的项
    
    // 标记为处理中
    batch.forEach(file => {
      // processing Set 应该已经被初始化
      this.processing.get(targetQueue)!.add(file.path);
    });
    
    // 调用处理函数
    processor(batch);
  }

  private getOriginalQueue(queueType: QueueType): FileItem[] | null {
    switch (queueType) {
        case 'fileStability': return this.fileStabilityQueue;
        case 'archiveStability': return this.archiveStabilityQueue;
        case 'md5': return this.md5Queue;
        case 'packaging': return this.packagingQueue;
        case 'transport': return this.transportQueue;
        default: return null;
    }
  }
  
  /**
   * 获取队列的最大并发数
   * @param queueType 队列类型
   */
  private getMaxConcurrentForQueue(queueType: QueueType): number {
    switch (queueType) {
      case 'fileStability':
        return this.queueConfig.maxConcurrentFileChecks || 5;
      case 'archiveStability':
        return this.queueConfig.maxConcurrentArchiveChecks || 3;
      case 'md5':
        return this.queueConfig.maxConcurrentMd5 || 5;
      case 'packaging':
        return this.queueConfig.maxConcurrentPackaging || 10;
      case 'transport':
        return this.queueConfig.maxConcurrentTransfers || 2;
      default:
        return 5; // 默认值
    }
  }
  
  /**
   * 处理重试队列
   * @param processor 处理函数
   */
  public processRetryQueue(
    processor: (files: FileItem[], targetQueue: QueueType) => void
  ): void {
    const currentTime = Date.now();
    const readyToRetry: RetryQueueItem[] = [];
    const failedItems: string[] = [];
    
    // 检查重试队列中的文件
    for (const [filePath, item] of this.retryQueue.entries()) {
      // 检查是否超过最大重试次数
      const maxRetries = this.getMaxRetriesForQueue(item.targetQueue);
      if (item.attempts >= maxRetries) {
        failedItems.push(filePath);
        continue;
      }
      
      // 检查是否满足重试延迟
      const timeSinceLastAttempt = currentTime - item.lastAttempt;
      const retryDelay = this.queueConfig.stabilityRetryDelay || 2000;
      
      if (timeSinceLastAttempt >= retryDelay) {
        readyToRetry.push(item);
      }
    }
    
    // 处理失败的文件
    failedItems.forEach(filePath => {
      const item = this.retryQueue.get(filePath);
      if (item) {
        const failureItem: FailureItem = {
          type: this.getFailureTypeForQueue(item.targetQueue),
          path: filePath,
          error: `超过最大重试次数(${this.getMaxRetriesForQueue(item.targetQueue)})，停止重试`
        };
        
        this.markAsFailed(filePath, failureItem);
      }
    });
    
    // 如果没有准备好重试的文件，直接返回
    if (readyToRetry.length === 0) return;
    
    // 按目标队列分组
    const queueMap = new Map<QueueType, FileItem[]>();
    readyToRetry.forEach(item => {
      if (!queueMap.has(item.targetQueue)) {
        queueMap.set(item.targetQueue, []);
      }
      
      // 从重试队列移除
      this.retryQueue.delete(item.file.path);
      
      // 添加到分组
      queueMap.get(item.targetQueue)!.push(item.file);
    });
    
    // 对每个目标队列调用处理函数
    for (const [targetQueue, files] of queueMap.entries()) {
      processor(files, targetQueue);
    }
  }
  
  /**
   * 获取队列统计信息
   */
  public getQueueStats(): QueueStats {
    const waiting = 
      this.fileStabilityQueue.length +
      this.archiveStabilityQueue.length +
      this.md5Queue.length +
      this.packagingQueue.length +
      this.transportQueue.length;
    
    const processing = 
      (this.processing.get('fileStability')?.size || 0) +
      (this.processing.get('archiveStability')?.size || 0) +
      (this.processing.get('md5')?.size || 0) +
      (this.processing.get('packaging')?.size || 0) +
      (this.processing.get('transport')?.size || 0);
    
    return {
      waiting,
      processing,
      completed: this.completedFiles.size,
      failed: this.failedFiles.size,
      retrying: this.retryQueue.size,
      total: waiting + processing + this.completedFiles.size + this.failedFiles.size + this.retryQueue.size
    };
  }
  
  /**
   * 获取详细队列统计信息
   */
  public getDetailedQueueStats() {
    return {
      fileStability: {
        waiting: this.fileStabilityQueue.length,
        processing: this.processing.get('fileStability')?.size || 0
      },
      archiveStability: {
        waiting: this.archiveStabilityQueue.length,
        processing: this.processing.get('archiveStability')?.size || 0
      },
      md5: {
        waiting: this.md5Queue.length,
        processing: this.processing.get('md5')?.size || 0
      },
      packaging: {
        waiting: this.packagingQueue.length,
        processing: this.processing.get('packaging')?.size || 0
      },
      transport: {
        waiting: this.transportQueue.length,
        processing: this.processing.get('transport')?.size || 0
      },
      retrying: this.retryQueue.size,
      completed: this.completedFiles.size,
      failed: this.failedFiles.size,
      total: this.getQueueStats().total
    };
  }
  
  /**
   * 清空所有队列
   */
  public clear(): void {
    this.matchedQueue = [];
    this.fileStabilityQueue = [];
    this.archiveStabilityQueue = [];
    this.md5Queue = [];
    this.packagingQueue = [];
    this.transportQueue = [];
    this.retryQueue.clear();
    this.completedFiles.clear();
    this.failedFiles.clear();
    this.pathMap.clear();
    
    // 清空压缩包追踪器
    this.archiveTracker.archiveToFiles.clear();
    this.archiveTracker.isQueued.clear();
    this.archiveTracker.status.clear();
    
    // 重新初始化处理中集合
    this.initializeProcessingMap();
  }
  
  /**
   * 检查所有处理是否已完成
   */
  public isAllProcessed(): boolean {
    // 检查所有普通队列是否为空
    if (
      this.matchedQueue.length > 0 ||
      this.fileStabilityQueue.length > 0 ||
      this.archiveStabilityQueue.length > 0 ||
      this.md5Queue.length > 0 ||
      this.packagingQueue.length > 0 ||
      this.transportQueue.length > 0 ||
      this.retryQueue.size > 0
    ) {
      return false;
    }
    
    // 检查是否有处理中的任务
    for (const set of this.processing.values()) {
      if (set.size > 0) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 获取所有已完成的文件
   */
  public getCompletedFiles(): FileItem[] {
    return Array.from(this.completedFiles.values());
  }
  
  /**
   * 获取所有失败的文件
   */
  public getFailedFiles(): FileItem[] {
    return Array.from(this.failedFiles.values());
  }
  
  /**
   * 获取队列中的所有文件
   * @param queueType 队列类型
   * @returns 文件列表
   */
  public getFilesInQueue(queueType: QueueType): FileItem[] {
    switch (queueType) {
      case 'fileStability':
        return [...this.fileStabilityQueue];
      case 'archiveStability':
        return [...this.archiveStabilityQueue];
      case 'md5':
        return [...this.md5Queue];
      case 'packaging':
        return [...this.packagingQueue];
      case 'transport':
        return [...this.transportQueue];
      default:
        return [];
    }
  }
  
  /**
   * 获取压缩包追踪器
   * @returns 压缩包追踪器
   */
  public getArchiveTracker(): ArchiveTracker {
    return this.archiveTracker;
  }
} 