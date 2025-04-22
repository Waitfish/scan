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

/** 文件匹配规则：[后缀列表, 文件名正则] */
export type MatchRule = [string[], string];

export interface ScanOptions {
  /** 扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则列表 */
  matchRules: MatchRule[];
  /** 扫描深度，-1表示扫描到没有下级目录为止 */
  depth: number;
  /** 进度回调函数 */
  onProgress?: (progress: ScanProgress, matchedFile?: FileItem) => void;
  /** 最大文件大小（字节），超过此大小的文件将被忽略，默认 500MB */
  maxFileSize?: number;
  /** 要跳过的目录名列表（相对于扫描目录的路径） */
  skipDirs?: string[];
}

export interface ScanProgress {
  /** 当前扫描的目录 */
  currentDir: string;
  /** 已扫描的文件总数 */
  scannedFiles: number;
  /** 已扫描的目录总数 */
  scannedDirs: number;
  /** 找到的匹配文件总数 */
  matchedFiles: number;
  /** 被忽略的大文件数 */
  ignoredLargeFiles: number;
  /** 被跳过的目录数 */
  skippedDirs: number;
} 