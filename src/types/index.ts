/**
 * @file 类型定义
 */

import { PackagingTriggerOptions } from './facade'; // Import from facade temporarily
// 重构后的接口导入
import { ScanOptions as NewScanOptions, ScanResult as NewScanResult } from './scanner';
import { QueueConfig, StabilityConfig } from './queue';

// 导出重构后的接口
export { 
  NewScanOptions, 
  NewScanResult,
  QueueConfig,
  StabilityConfig
};

// 原有接口定义 (后续重构将逐步移除)
export interface FileItem {
  /** 文件绝对路径 (对于压缩包内文件，指压缩包的路径) */
  path: string;
  /** 文件名 (对于压缩包内文件，指内部文件的名称) */
  name: string;
  /** 文件原始名称（未重命名前的名称，用于处理文件名冲突时记录） */
  originalName?: string;
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
  /** 文件的md5值 */
  md5?: string;
  /** 额外元数据，用于存储其他信息如稳定性检测的结果 */
  metadata?: {
    /** 文件修改时间的ISO字符串，用于稳定性检测 */
    mtime?: string;
    /** 其他元数据 */
    [key: string]: any;
  };
}

/** 文件匹配规则：[后缀列表, 文件名正则] */
export type MatchRule = [string[], string];

/**
 * 文件稳定性检测选项
 * @deprecated 将在重构后删除，请使用 QueueConfig 和 StabilityConfig 接口替代
 */
export interface StabilityCheckOptions {
  /** 是否启用文件稳定性检测 */
  enabled: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  retryInterval: number;
  /** 检测间隔（毫秒） */
  checkInterval: number;
  /** 大文件阈值（字节） */
  largeFileThreshold: number;
  /** 是否对大文件跳过读取检测 */
  skipReadForLargeFiles: boolean;
}

/**
 * 队列系统选项
 * @deprecated 将在重构后删除，请使用 QueueConfig 接口替代
 */
export interface QueueOptions {
  /** 是否启用队列系统 */
  enabled: boolean;
  /** 最大并发检测数量 */
  maxConcurrentChecks: number;
  /** 最大并发传输数量 */
  maxConcurrentTransfers: number;
  /** 稳定性检测重试延迟（毫秒） */
  stabilityRetryDelay: number;
}

/**
 * 传输配置选项
 */
export interface TransportOptions {
  /** 是否启用传输 */
  enabled: boolean;
  /** 传输协议 */
  protocol: 'ftp' | 'sftp' | 'ftps';
  /** 服务器主机 */
  host: string;
  /** 服务器端口 */
  port: number;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** 远程目录路径 */
  remotePath: string;
  /** 每个压缩包最多包含的文件数 */
  packageSize: number;
  /** 重试次数 */
  retryCount: number;
  /** 超时时间(毫秒) */
  timeout: number;
  /** 是否开启调试模式 */
  debug?: boolean;
}

/**
 * @deprecated 将在重构后删除，请使用 NewScanOptions 替代
 */
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
  /** 文件稳定性检测选项 */
  stabilityCheck?: StabilityCheckOptions;
  /** 队列系统选项 */
  queue?: QueueOptions;
  /** 传输选项 */
  transport?: TransportOptions;
  /** 是否计算MD5值 */
  calculateMd5?: boolean;
  /** 是否创建压缩包 */
  createPackage?: boolean;
  /** 压缩包命名模式（支持日期变量如{date}） */
  packageNamePattern?: string;
  /** 打包文件输出目录 */
  outputDir?: string;
  /** 打包触发选项 */
  packagingTrigger?: PackagingTriggerOptions;
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
  /** 已处理的文件MD5计算数 */
  processedMd5Count?: number;
  /** 已打包的文件数 */
  packagedFilesCount?: number;
  /** 已传输的文件数 */
  transportedFilesCount?: number;
  /** 队列状态 */
  queueStats?: {
    waiting: number;
    processing: number;
    completed: number;
    failed: number;
    retrying: number;
    total: number;
  };
}

/**
 * 表示扫描过程中发生的失败信息
 */
export interface FailureItem {
  /** 失败类型 */
  type: 'directoryAccess' | 'fileStat' | 'archiveOpen' | 'archiveEntry' | 
        'rarOpen' | 'nestedArchive' | 'stability' | 'md5' | 'packaging' | 
        'transport' | 'scanError' | 'archiveStability' | 'extractArchive' |
        'ignoredLargeFile';
  /** 发生失败的文件、目录或压缩包的路径 */
  path: string;
  /** 如果是压缩包内条目处理失败，这里是内部路径 */
  // TODO: 改成和FileItem 一样的
  entryPath?: string;
  /** 具体的错误信息 */
  error: string;
  /** 嵌套层级 */
  nestedLevel?: number;
  /** 受影响的文件列表 (用于压缩包稳定性失败) */
  affectedFiles?: string[];
}

/**
 * 文件元数据项
 */
export interface FileMetadata {
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件创建时间（ISO字符串） */
  createTime?: string;
  /** 文件修改时间（ISO字符串） */
  modifyTime?: string;
  /** 文件MD5校验和（如果包含） */
  md5?: string;
}

/**
 * FileItem的序列化版本（用于元数据存储）
 */
export type SerializedFileItem = Omit<FileItem, 'createTime' | 'modifyTime'> & {
  /** 序列化后的创建时间 */
  createTime?: string;
  /** 序列化后的修改时间 */
  modifyTime?: string;
};

/**
 * 错误元数据项
 */
export interface ErrorMetadata {
  /** 文件名 */
  file: string;
  /** 错误消息 */
  error: string;
}

/**
 * 包元数据
 */
export interface PackageMetadata {
  /** 创建时间（ISO字符串） */
  createdAt: string;
  /** 包含的文件列表 */
  files: SerializedFileItem[];
  /** 元数据版本 */
  version?: string;
  /** 包唯一标识符 */
  packageId?: string;
  /** 标签列表 */
  tags?: string[];
  /** 使用的校验算法 */
  checksumAlgorithm?: string;
  /** 错误记录（如果有） */
  errors?: ErrorMetadata[];
  /** 打包过程中的警告信息 */
  warnings?: string[];
}

/**
 * scanFiles 函数的返回结果
 * @deprecated 将在重构后删除，请使用 NewScanResult 替代
 */
export interface ScanResult {
  /** 成功匹配的文件列表 */
  results: FileItem[];
  /** 扫描过程中发生的失败列表 */
  failures: FailureItem[];
  /** 处理的文件数据（添加MD5后） */
  processedFiles?: FileItem[];
  /** 创建的包文件列表 */
  packages?: string[];
  /** 传输结果 */
  transportResults?: {
    success: boolean;
    filePath: string;
    remotePath: string;
    error?: string;
  }[];
} 