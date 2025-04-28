/**
 * @file 队列系统相关类型定义
 */

import { FileItem, FailureItem } from './index';

/** 定义文件处理队列配置 */
export interface QueueConfig {
  /** 是否启用队列处理 (默认: true) */
  enabled?: boolean;
  /** 最大并发文件稳定性检测数量 (默认: 5) */
  maxConcurrentFileChecks?: number;
  /** 最大并发压缩包稳定性检测数量 (默认: 3) */
  maxConcurrentArchiveChecks?: number;
  /** 最大并发MD5计算数量 (默认: 5) */
  maxConcurrentMd5?: number;
  /** 最大并发传输数量 (默认: 2) */
  maxConcurrentTransfers?: number;
  /** 稳定性检测重试延迟（毫秒）(默认: 2000) */
  stabilityRetryDelay?: number;
  /** 最大稳定性检测重试次数 (默认: 3) */
  maxStabilityRetries?: number;
}

/** 基础稳定性检测配置 */
export interface BaseStabilityConfig {
  /** 是否启用稳定性检测 (默认: true) */
  enabled?: boolean;
  /** 检测间隔（毫秒）(默认: 500) */
  checkInterval?: number;
  /** 最大重试次数 (默认: 3) */
  maxRetries?: number;
}

/** 文件稳定性检测配置 */
export interface FileStabilityConfig extends BaseStabilityConfig {
  /** 大文件阈值（字节）(默认: 100MB) */
  largeFileThreshold?: number;
  /** 是否对大文件跳过读取检测 (默认: true) */
  skipReadForLargeFiles?: boolean;
}

/** 压缩包稳定性检测配置 */
export interface ArchiveStabilityConfig extends BaseStabilityConfig {
  /**
   * 是否在提取内容时跳过大文件
   */
  skipLargeFiles?: boolean;
  
  /**
   * 大文件阈值（字节）
   */
  largeFileThreshold?: number;
  
  /**
   * 对于大文件是否跳过文件读取检查
   */
  skipReadForLargeFiles?: boolean;
  /** 解压后要保留的临时文件? (默认: false) */
  keepTempFiles?: boolean;
  /** 临时文件目录 (默认: 系统临时目录) */
  tempDir?: string;
}

/** 定义稳定性检测配置 */
export interface StabilityConfig {
  /** 基础配置 */
  base?: BaseStabilityConfig;
  /** 文件稳定性配置 */
  file?: FileStabilityConfig;
  /** 压缩包稳定性配置 */
  archive?: ArchiveStabilityConfig;
}

/** 队列状态 */
export interface QueueStats {
  /** 等待处理的文件数 */
  waiting: number;
  /** 正在处理的文件数 */
  processing: number;
  /** 已完成处理的文件数 */
  completed: number;
  /** 处理失败的文件数 */
  failed: number;
  /** 正在重试的文件数 */
  retrying: number;
  /** 总文件数 */
  total: number;
}

/** 队列类型 */
export type QueueType = 
  | 'fileStability'      // 普通文件稳定性检测队列
  | 'archiveStability'   // 压缩包稳定性检测队列
  | 'md5'                // MD5计算队列 
  | 'packaging'          // 打包队列
  | 'transport';         // 传输队列

/** 队列处理回调 */
export type QueueProcessCallback = (files: FileItem[]) => Promise<void>;

/** 队列失败回调 */
export type QueueFailureCallback = (failure: FailureItem) => void;

/** 压缩包追踪映射 */
export interface ArchiveTracker {
  /** 压缩包路径到相关联文件的映射 */
  archiveToFiles: Map<string, Set<FileItem>>;
  /** 是否已经加入队列 */
  isQueued: Map<string, boolean>;
  /** 处理状态 */
  status: Map<string, 'waiting' | 'processing' | 'stable' | 'unstable' | 'failed'>;
} 