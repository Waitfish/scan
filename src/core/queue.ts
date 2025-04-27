/**
 * @file 队列管理系统
 * 用于处理扫描过程中的文件队列，包括匹配队列、稳定性检测队列、MD5计算队列、打包队列和传输队列
 */

import { FileItem, QueueOptions } from '../types';

// 队列类型
export type QueueType = 'matched' | 'stability' | 'md5' | 'packaging' | 'transport';

// 重试队列项
interface RetryQueueItem {
  file: FileItem;
  attempts: number;
  lastAttempt: number;
  targetQueue: QueueType;
}

// 队列配置选项
interface QueueConfigOptions {
  maxRetries?: number;
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
  private matchedQueue: FileItem[] = [];        // 扫描匹配的文件
  private stabilityQueue: FileItem[] = [];      // 等待稳定性检测的文件
  private md5Queue: FileItem[] = [];            // 等待MD5计算的文件
  private packagingQueue: FileItem[] = [];      // 等待打包的文件
  private transportQueue: FileItem[] = [];      // 等待传输的文件
  
  // 特殊队列
  private retryQueue: Map<string, RetryQueueItem> = new Map(); // 重试队列
  private completedFiles: Map<string, FileItem> = new Map();  // 已完成的文件
  private failedFiles: Map<string, FileItem> = new Map();     // 失败的文件
  
  // 路径映射，用于快速查找文件
  private pathMap: Map<string, FileItem> = new Map();
  
  // 处理中的文件数量
  private processing: Map<QueueType, Set<string>> = new Map();
  
  // 配置
  private options: QueueOptions;
  private config: QueueConfigOptions;
  
  /**
   * 构造函数
   * @param options 队列选项
   * @param config 队列配置
   */
  constructor(options: QueueOptions, config: QueueConfigOptions = {}) {
    this.options = options;
    this.config = {
      maxRetries: 3,
      ...config
    };
    
    // 初始化处理中集合
    this.processing.set('matched', new Set());
    this.processing.set('stability', new Set());
    this.processing.set('md5', new Set());
    this.processing.set('packaging', new Set());
    this.processing.set('transport', new Set());
  }
  
  /**
   * 将文件添加到匹配队列
   * @param file 文件项
   */
  public addToMatchedQueue(file: FileItem): void {
    this.matchedQueue.push(file);
    this.pathMap.set(file.path, file);
  }
  
  /**
   * 将文件添加到指定队列
   * @param queueType 队列类型
   * @param file 文件项
   */
  public addToQueue(queueType: QueueType, file: FileItem): void {
    switch (queueType) {
      case 'matched':
        this.matchedQueue.push(file);
        break;
      case 'stability':
        this.stabilityQueue.push(file);
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
   * 将文件添加到重试队列
   * @param file 文件项
   * @param targetQueue 目标队列类型
   */
  public addToRetryQueue(file: FileItem, targetQueue: QueueType): void {
    const retryItem = this.retryQueue.get(file.path) || {
      file,
      attempts: 0,
      lastAttempt: Date.now(),
      targetQueue
    };
    
    this.retryQueue.set(file.path, retryItem);
    
    // 确保文件在路径映射中
    if (!this.pathMap.has(file.path)) {
      this.pathMap.set(file.path, file);
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
      case 'matched':
        queue = this.matchedQueue;
        break;
      case 'stability':
        queue = this.stabilityQueue;
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
      this.removeFromQueue('matched', filePath);
      this.removeFromQueue('stability', filePath);
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
   */
  public markAsFailed(filePath: string): void {
    const file = this.pathMap.get(filePath);
    if (file) {
      // 从所有队列移除
      this.removeFromQueue('matched', filePath);
      this.removeFromQueue('stability', filePath);
      this.removeFromQueue('md5', filePath);
      this.removeFromQueue('packaging', filePath);
      this.removeFromQueue('transport', filePath);
      
      // 从重试队列移除
      this.retryQueue.delete(filePath);
      
      // 添加到失败集合
      this.failedFiles.set(filePath, file);
    }
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
    let sourceQueue: FileItem[] = [];
    
    // 根据目标队列确定源队列
    switch (targetQueue) {
      case 'stability':
        sourceQueue = this.matchedQueue;
        break;
      case 'md5':
        sourceQueue = this.stabilityQueue;
        break;
      case 'packaging':
        sourceQueue = this.md5Queue;
        break;
      case 'transport':
        sourceQueue = this.packagingQueue;
        break;
      case 'matched':
        // 匹配队列是初始队列，没有源队列
        return;
    }
    
    // 不能超过批处理大小
    const batch = sourceQueue.slice(0, batchSize);
    if (batch.length === 0) return;
    
    // 从源队列移除
    sourceQueue.splice(0, batch.length);
    
    // 添加到目标队列
    batch.forEach(file => {
      this.addToQueue(targetQueue, file);
      
      // 标记为处理中
      const processingSet = this.processing.get(targetQueue);
      if (processingSet) {
        processingSet.add(file.path);
      }
    });
    
    // 调用处理函数
    processor(batch);
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
      if (item.attempts >= this.config.maxRetries!) {
        failedItems.push(filePath);
        continue;
      }
      
      // 检查是否满足重试延迟
      const timeSinceLastAttempt = currentTime - item.lastAttempt;
      if (timeSinceLastAttempt >= this.options.stabilityRetryDelay) {
        readyToRetry.push(item);
      }
    }
    
    // 处理失败的文件
    failedItems.forEach(filePath => {
      this.markAsFailed(filePath);
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
  public getQueueStats() {
    return {
      matched: this.matchedQueue.length,
      stability: this.stabilityQueue.length,
      md5: this.md5Queue.length,
      packaging: this.packagingQueue.length,
      transport: this.transportQueue.length,
      retrying: this.retryQueue.size,
      completed: this.completedFiles.size,
      failed: this.failedFiles.size,
      total: this.matchedQueue.length +
             this.stabilityQueue.length +
             this.md5Queue.length +
             this.packagingQueue.length +
             this.transportQueue.length +
             this.retryQueue.size +
             this.completedFiles.size +
             this.failedFiles.size
    };
  }
  
  /**
   * 清空所有队列
   */
  public clear(): void {
    this.matchedQueue = [];
    this.stabilityQueue = [];
    this.md5Queue = [];
    this.packagingQueue = [];
    this.transportQueue = [];
    this.retryQueue.clear();
    this.completedFiles.clear();
    this.failedFiles.clear();
    this.pathMap.clear();
    
    // 清空处理中集合
    for (const set of this.processing.values()) {
      set.clear();
    }
  }
  
  /**
   * 检查所有处理是否已完成
   */
  public isAllProcessed(): boolean {
    // 检查所有普通队列是否为空
    if (
      this.matchedQueue.length > 0 ||
      this.stabilityQueue.length > 0 ||
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
} 