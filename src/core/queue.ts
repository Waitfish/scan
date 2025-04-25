/**
 * @file 队列管理系统
 * 用于管理文件处理队列和任务调度
 */

import { FileItem, QueueOptions } from '../types';

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
 */
export class FileProcessingQueue {
  /** 待处理队列 */
  private queue: QueueItem[] = [];
  /** 正在处理的项目 */
  private processing: Map<string, QueueItem> = new Map();
  /** 已完成的项目 */
  private completed: QueueItem[] = [];
  /** 失败的项目 */
  private failed: QueueItem[] = [];
  /** 重试队列 */
  private retryQueue: QueueItem[] = [];
  /** 是否正在处理中 */
  private isProcessing = false;
  /** 队列选项 */
  private options: QueueOptions;
  
  /**
   * 构造函数
   * @param options 队列选项
   */
  constructor(options: Partial<QueueOptions> = {}) {
    // 设置默认选项
    this.options = {
      enabled: true,
      maxConcurrentChecks: 5,
      maxConcurrentTransfers: 3,
      stabilityRetryDelay: 30000,
      ...options
    };
  }
  
  /**
   * 将文件添加到队列
   * @param file 文件项
   * @returns 队列项ID（文件路径）
   */
  addFile(file: FileItem): string {
    const queueItem: QueueItem = {
      file,
      status: QueueItemStatus.WAITING,
      attempts: 0,
      createdAt: new Date()
    };
    
    this.queue.push(queueItem);
    return file.path;
  }
  
  /**
   * 获取队列统计信息
   */
  getStats() {
    return {
      waiting: this.queue.length,
      processing: this.processing.size,
      completed: this.completed.length,
      failed: this.failed.length,
      retrying: this.retryQueue.length,
      total: this.queue.length + this.processing.size + this.completed.length + this.failed.length + this.retryQueue.length
    };
  }
  
  /**
   * 启动队列处理
   * @param processor 处理函数
   */
  async startProcessing(processor: (file: FileItem) => Promise<boolean>): Promise<void> {
    if (this.isProcessing || !this.options.enabled) {
      return;
    }
    
    this.isProcessing = true;
    
    // 简单的处理逻辑 - 将在后续开发中完善
    while (this.queue.length > 0 && this.isProcessing) {
      const item = this.queue.shift();
      if (!item) continue;
      
      try {
        item.status = QueueItemStatus.PROCESSING;
        item.attempts++;
        item.lastAttempt = new Date();
        this.processing.set(item.file.path, item);
        
        const success = await processor(item.file);
        
        if (success) {
          item.status = QueueItemStatus.COMPLETED;
          item.completedAt = new Date();
          this.completed.push(item);
        } else {
          item.status = QueueItemStatus.FAILED;
          this.failed.push(item);
        }
      } catch (error: any) {
        item.status = QueueItemStatus.FAILED;
        item.error = error.message || String(error);
        this.failed.push(item);
      } finally {
        this.processing.delete(item.file.path);
      }
    }
    
    this.isProcessing = false;
  }
  
  /**
   * 停止队列处理
   */
  stopProcessing(): void {
    this.isProcessing = false;
  }
} 