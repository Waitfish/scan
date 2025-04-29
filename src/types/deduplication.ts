/**
 * @file 去重相关类型定义
 */

import { FileItem } from './index';

/**
 * 去重结果类型
 */
export enum DeduplicationType {
  /** 没有重复 */
  NOT_DUPLICATE = 'not_duplicate',
  /** 与历史任务重复 */
  HISTORICAL_DUPLICATE = 'historical_duplicate',
  /** 任务内重复 */
  TASK_DUPLICATE = 'task_duplicate'
}

/**
 * 去重结果接口
 */
export interface DeduplicationResult {
  /** 是否为重复文件 */
  isDuplicate: boolean;
  /** 重复类型 */
  type: DeduplicationType;
  /** 文件项 */
  fileItem: FileItem;
}

/**
 * 去重器配置选项
 */
export interface DeduplicatorOptions {
  /** 是否启用去重 */
  enabled: boolean;
  /** 是否启用历史记录去重 */
  useHistoricalDeduplication: boolean;
  /** 是否启用任务内去重 */
  useTaskDeduplication: boolean;
  /** 历史记录文件路径 */
  historyFilePath?: string;
  /** 自动保存历史记录的间隔（毫秒），0表示不自动保存 */
  autoSaveInterval?: number;
}

/**
 * 历史上传记录文件格式
 * 一个包含已上传文件MD5值的字符串数组
 */
export type HistoricalUploadsRecord = string[]; 