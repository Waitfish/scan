/**
 * @file 类型定义
 */

export interface FileItem {
  /** 文件绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 文件创建时间 */
  createTime: Date;
  /** 文件修改时间 */
  modifyTime: Date;
  /** 文件大小（字节） */
  size: number;
}

export interface ScanOptions {
  /** 扫描的根目录 */
  rootDir: string;
  /** 文件名匹配正则表达式 */
  pattern: string;
  /** 扫描深度，-1表示扫描到没有下级目录为止 */
  depth: number;
  /** 进度回调函数 */
  onProgress?: (progress: ScanProgress) => void;
  /** 最大文件大小（字节），超过此大小的文件将被忽略，默认 500MB */
  maxFileSize?: number;
}

export interface ScanProgress {
  /** 当前扫描的目录 */
  currentDir: string;
  /** 已扫描的文件总数 */
  scannedFiles: number;
  /** 已扫描的目录总数 */
  scannedDirs: number;
  /** 找到的匹配文件数 */
  matchedFiles: number;
  /** 被忽略的大文件数 */
  ignoredLargeFiles: number;
} 