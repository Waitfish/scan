/**
 * @file 扫描器相关类型定义（重构版）
 */

import { FileItem, MatchRule, FailureItem, ScanProgress } from './index';

/**
 * 扫描选项（重构版）- 移除了稳定性检测、MD5计算、打包和传输相关选项
 */
export interface ScanOptions {
  /** 扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则列表 */
  matchRules: MatchRule[];
  /** 扫描深度，-1表示扫描到没有下级目录为止 */
  depth?: number;
  /** 最大文件大小（字节），超过此大小的文件将被忽略，默认 500MB */
  maxFileSize?: number;
  /** 要跳过的目录名列表（相对于扫描目录的路径） */
  skipDirs?: string[];
  /** 是否扫描嵌套压缩文件，默认为true */
  scanNestedArchives?: boolean;
  /** 最大嵌套层级，默认为5 */
  maxNestedLevel?: number;
  /** 任务唯一标识符 */
  taskId?: string;
  /** 基本进度回调函数 */
  onProgress?: (progress: ScanProgress) => void;
  /** 文件匹配回调函数 - 用于队列处理 */
  onFileMatched?: (file: FileItem, progress: ScanProgress) => void;
  /** 失败信息回调函数 - 用于队列处理 */
  onFailure?: (failure: FailureItem, progress: ScanProgress) => void;
}

/**
 * 扫描结果（重构版）- 只包含扫描相关结果，移除处理结果
 */
export interface ScanResult {
  /** 成功匹配的文件列表 */
  matchedFiles: FileItem[];
  /** 扫描过程中发生的失败列表 */
  failures: FailureItem[];
  /** 扫描统计信息 */
  stats: {
    /** 总扫描文件数 */
    totalScanned: number;
    /** 总匹配文件数 */
    totalMatched: number;
    /** 总失败数 */
    totalFailures: number;
    /** 扫描的压缩包数 */
    archivesScanned: number;
    /** 扫描的嵌套压缩包数 */
    nestedArchivesScanned: number;
  };
  /** 任务唯一标识符 */
  taskId?: string;
  /** 扫描唯一标识符 */
  scanId: string;
  /** 扫描开始时间 */
  startTime: Date;
  /** 扫描结束时间 */
  endTime: Date;
  /** 扫描耗时（毫秒） */
  elapsedTimeMs: number;
} 