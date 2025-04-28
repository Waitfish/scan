import { ScanAndTransportConfig, ScanAndTransportResult, PackagingTriggerOptions } from './types/facade';
import { ScanOptions, StabilityCheckOptions, QueueOptions, TransportOptions, ScanResult, FileItem, FailureItem } from './types';
import path from 'path'; // 需要导入 path 用于处理路径
import { scanFiles } from './core/scanner'; // Corrected import path
import fs from 'fs-extra'; // Import fs-extra for appendFile

// Simple asynchronous file logger
async function logToFile(filePath: string, message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    // Ensure directory exists (optional, but good practice)
    await fs.ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, logMessage);
  } catch (error: any) {
    // Log error to console if logging to file fails
    console.error(`Failed to write to log file ${filePath}: ${error.message}`);
  }
}

// 默认值定义
const DEFAULT_OUTPUT_DIR = './temp/packages';
const DEFAULT_PACKAGE_NAME_PATTERN = 'package_{date}_{index}';
const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const DEFAULT_SKIP_DIRS: string[] = [];
const DEFAULT_DEPTH = -1;
const DEFAULT_SCAN_NESTED_ARCHIVES = true;
const DEFAULT_MAX_NESTED_LEVEL = 5;
const DEFAULT_PACKAGING_TRIGGER: PackagingTriggerOptions = { maxFiles: 500, maxSizeMB: 2048 };
const DEFAULT_STABILITY_OPTIONS: StabilityCheckOptions = {
  enabled: true,
  maxRetries: 3,
  retryInterval: 1000, // 1 秒
  checkInterval: 500, // 0.5 秒
  largeFileThreshold: 100 * 1024 * 1024, // 100 MB
  skipReadForLargeFiles: true,
};
const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  enabled: true,
  maxConcurrentChecks: 5,
  maxConcurrentTransfers: 2,
  stabilityRetryDelay: 2000, // 2 秒
};
const DEFAULT_TRANSPORT_RETRY_COUNT = 3;
const DEFAULT_TRANSPORT_TIMEOUT = 60000; // 60 秒

// 生成带时间戳的默认日志文件名
/* istanbul ignore next */ // 忽略测试覆盖率，因为它在测试中被单独测试
export function getDefaultLogFilePath(): string { // Add export for testing
  const now = new Date();
  const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  return path.resolve(`./scan_transport_log_${timestamp}.log`);
}

/**
 * 执行扫描、打包和传输的简化流程函数
 * @param config 配置对象
 * @returns 包含处理结果和日志路径的对象
 */
export async function scanAndTransport(config: ScanAndTransportConfig): Promise<ScanAndTransportResult> {
  // 1. 合并配置与默认值
  const outputDir = path.resolve(config.outputDir ?? DEFAULT_OUTPUT_DIR);
  const packageNamePattern = config.packageNamePattern ?? DEFAULT_PACKAGE_NAME_PATTERN;
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const skipDirs = config.skipDirs ?? DEFAULT_SKIP_DIRS;
  const depth = config.depth ?? DEFAULT_DEPTH;
  const scanNestedArchives = config.scanNestedArchives ?? DEFAULT_SCAN_NESTED_ARCHIVES;
  const maxNestedLevel = config.maxNestedLevel ?? DEFAULT_MAX_NESTED_LEVEL;
  const packagingTrigger = { ...DEFAULT_PACKAGING_TRIGGER, ...config.packagingTrigger };
  const logFilePath = config.logFilePath ? path.resolve(config.logFilePath) : getDefaultLogFilePath();
  await logToFile(logFilePath, `--- ScanAndTransport Start ---`);
  await logToFile(logFilePath, `User Config: ${JSON.stringify(config)}`); // Log user config (careful with sensitive data like passwords in real apps)

  // 2. 构建完整的 TransportOptions
  const transportOptions: TransportOptions = {
    enabled: config.transport.enabled !== undefined ? config.transport.enabled : true,
    protocol: config.transport.protocol,
    host: config.transport.host,
    port: config.transport.port,
    username: config.transport.username,
    password: config.transport.password,
    remotePath: config.transport.remotePath,
    retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
    timeout: DEFAULT_TRANSPORT_TIMEOUT,
    packageSize: -1, // 设置一个无效值或让 scanFiles 处理
  };
  await logToFile(logFilePath, `Constructed TransportOptions: ${JSON.stringify(transportOptions)}`); // Log constructed options (careful with sensitive data)

  // 3. 构建完整的 ScanOptions
  const scanOptions: ScanOptions = {
    rootDir: path.resolve(config.rootDir),
    matchRules: config.rules,
    packageNamePattern: packageNamePattern,
    onProgress: config.onProgress,
    maxFileSize: maxFileSize,
    skipDirs: skipDirs.map(dir => path.resolve(config.rootDir, dir)),
    depth: depth,
    scanNestedArchives: scanNestedArchives,
    maxNestedLevel: maxNestedLevel,
    stabilityCheck: DEFAULT_STABILITY_OPTIONS,
    queue: DEFAULT_QUEUE_OPTIONS,
    transport: transportOptions,
    calculateMd5: true,
    createPackage: true,
    outputDir: outputDir,
    packagingTrigger: packagingTrigger
  };
  await logToFile(logFilePath, `Constructed ScanOptions: ${JSON.stringify(scanOptions)}`); // Log constructed options (careful with sensitive data)

  // TODO: 4. 初始化日志 (阶段 5)
  // console.log('Log file path will be:', logFilePath);
  // console.log('Calling scanFiles with options:', scanOptions);

  let scanResult: ScanResult | null = null;
  let success = false;
  let finalError: Error | null = null;

  try {
    await logToFile(logFilePath, `Calling scanFiles...`);
    // 5. 调用核心 scanFiles
    scanResult = await scanFiles(scanOptions);
    success = scanResult.failures.length === 0;
    await logToFile(logFilePath, `scanFiles finished. Success: ${success}. Failures: ${scanResult.failures.length}. Packages: ${scanResult.packages?.length ?? 0}.`);
    // console.log('scanFiles completed. Result:', scanResult);

  } catch (error: any) {
    console.error('Error calling scanFiles:', error);
    success = false;
    finalError = error;
    await logToFile(logFilePath, `ERROR during scanFiles: ${error.message}`);
  }

  // 6. 处理结果 (基础映射)
  // 确保 scanResult 存在才访问其属性，或者提供默认空数组
  const failedItemsFromScan = scanResult?.failures ?? [];
  const processedFilesFromScan = scanResult?.processedFiles ?? [];
  const packagesFromScan = scanResult?.packages ?? [];
  const transportResultsFromScan = scanResult?.transportResults ?? [];

  const result: ScanAndTransportResult = {
    success: success,
    processedFiles: processedFilesFromScan, // 阶段4细化
    failedItems: failedItemsFromScan, // 阶段4细化 (需要合并)
    packagePaths: packagesFromScan,
    transportSummary: transportResultsFromScan,
    logFilePath: logFilePath,
  };

  // 如果有未处理的顶层错误，将其加入 failedItems
  if (finalError) {
    // No longer needs type assertion as 'scanError' is now a valid type
    result.failedItems.push({
      type: 'scanError',
      path: config.rootDir,
      error: finalError.message,
    });
    await logToFile(logFilePath, `Top-level error added to failedItems: ${finalError.message}`);
  }

  // TODO: 记录日志 (阶段 5)

  await logToFile(logFilePath, `--- ScanAndTransport End --- Success: ${result.success}, Processed: ${result.processedFiles.length}, Failed: ${result.failedItems.length}, Packages: ${result.packagePaths.length}`);

  return result;
} 