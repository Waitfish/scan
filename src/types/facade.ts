import { FileItem, MatchRule, ScanProgress, FailureItem, TransportOptions as CoreTransportOptions } from './index';

/** 定义简化版的 Transport 配置接口 (不包含 enabled, retryCount, timeout, debug, packageSize) */
export type ScanAndTransportTransportConfig = Omit<CoreTransportOptions, 'enabled' | 'retryCount' | 'timeout' | 'debug' | 'packageSize'>;

/** 定义打包触发条件接口 */
export interface PackagingTriggerOptions {
  /** 触发打包的文件数量阈值 */
  maxFiles: number;
  /** 触发打包的文件总大小阈值 (单位 MB) */
  maxSizeMB: number;
}

/** 定义 scanAndTransport 配置接口 */
export interface ScanAndTransportConfig {
  // --- 必需参数 ---
  /** 要扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则 */
  rules: MatchRule[];
  /** 传输目标服务器基本信息 */
  transport: ScanAndTransportTransportConfig;

  // --- 可选参数 ---
  /** 本地临时存储打包文件的目录 (默认: './temp/packages') */
  outputDir?: string;
  /** 打包文件的命名模式 (默认: 'package_{date}_{index}') */
  packageNamePattern?: string;
  /** 进度回调函数，提供详细进度 */
  onProgress?: (progress: ScanProgress, matchedFile?: FileItem) => void;
  /** 最大扫描文件大小，单位字节 (默认: 500 * 1024 * 1024) */
  maxFileSize?: number;
  /** 需要跳过的目录列表 (默认: []) */
  skipDirs?: string[];
  /** 扫描深度, -1表示无限深度 (默认: -1) */
  depth?: number;
  /** 是否扫描嵌套压缩包 (默认: true) */
  scanNestedArchives?: boolean;
  /** 最大嵌套扫描层数 (默认: 5) */
  maxNestedLevel?: number;
  /** 打包触发条件 (默认: { maxFiles: 500, maxSizeMB: 2048 }) */
  packagingTrigger?: PackagingTriggerOptions;
  /** 日志文件路径 (默认: './scan_transport_log_{时间戳}.log') */
  logFilePath?: string;
}

/** 定义 scanAndTransport 返回结果接口 */
export interface ScanAndTransportResult {
  /** 整个过程是否基本成功 (即使有部分文件失败) */
  success: boolean;
  /** 成功处理并打包的文件列表 (包含MD5等元数据，用于下次跳过) */
  processedFiles: FileItem[];
  /** 整个流程中所有失败的条目列表 (包含路径和错误，用于重试) */
  failedItems: FailureItem[];
  /** 本地生成的包文件路径列表 */
  packagePaths: string[];
  /** 每个包的传输结果摘要 */
  transportSummary: {
    success: boolean;
    filePath: string;
    remotePath: string;
    error?: string;
  }[];
  /** 实际使用的日志文件路径 */
  logFilePath: string;
}

// 导出类型，确保它们可以被外部引用
export { FileItem, MatchRule, ScanProgress, FailureItem }; 