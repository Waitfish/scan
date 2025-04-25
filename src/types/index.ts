/**
 * @file 类型定义
 */

export interface FileItem {
  /** 文件绝对路径 (对于压缩包内文件，指压缩包的路径) */
  path: string;
  /** 文件名 (对于压缩包内文件，指内部文件的名称) */
  name: string;
  /** 文件创建时间 (对于压缩包内文件，使用压缩包的创建时间) */
  createTime: Date;
  /** 文件修改时间 (对于压缩包内文件，使用压缩包的修改时间) */
  modifyTime: Date;
  /** 文件大小（字节）(对于压缩包内文件，指未压缩的大小) */
  size: number;
  /** 文件来源: 'filesystem' 或 'archive' */
  origin?: 'filesystem' | 'archive';
  /** 如果来源是 'archive'，则为压缩包的绝对路径 */
  archivePath?: string;
  /** 如果来源是 'archive'，则为文件在压缩包内的相对路径 */
  internalPath?: string;
  /** 嵌套层级，0表示非嵌套（文件系统文件），1表示一层压缩包，以此类推 */
  nestedLevel?: number;
  /** 完整的嵌套路径表示，例如：outer.zip/inner.zip/file.txt */
  nestedPath?: string;
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
  /** 是否扫描嵌套压缩文件，默认为false */
  scanNestedArchives?: boolean;
  /** 最大嵌套层级，默认为5 */
  maxNestedLevel?: number;
}

export interface ScanProgress {
  /** 当前扫描的目录 */
  currentDir: string;
  /** 已扫描的文件总数 (包括压缩包内扫描的) */
  scannedFiles: number;
  /** 已扫描的目录总数 */
  scannedDirs: number;
  /** 已扫描的压缩包总数 */
  archivesScanned: number;
  /** 找到的匹配文件总数 */
  matchedFiles: number;
  /** 被忽略的大文件数 */
  ignoredLargeFiles: number;
  /** 被跳过的目录数 */
  skippedDirs: number;
  /** 已扫描的嵌套压缩包总数 */
  nestedArchivesScanned?: number;
  /** 当前正在处理的嵌套层级 */
  currentNestedLevel?: number;
}

/**
 * 表示扫描过程中发生的失败信息
 */
export interface FailureItem {
  /** 失败类型 */
  type: 'directoryAccess' | 'fileStat' | 'archiveOpen' | 'archiveEntry' | 'rarOpen' | 'nestedArchive';
  /** 发生失败的文件、目录或压缩包的路径 */
  path: string;
  /** 如果是压缩包内条目处理失败，这里是内部路径 */
  entryPath?: string;
  /** 具体的错误信息 */
  error: string;
  /** 嵌套层级 */
  nestedLevel?: number;
}

/**
 * scanFiles 函数的返回结果
 */
export interface ScanResult {
  /** 成功匹配的文件列表 */
  results: FileItem[];
  /** 扫描过程中发生的失败列表 */
  failures: FailureItem[];
} 