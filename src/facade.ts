import { ScanAndTransportConfig, ScanAndTransportResult, PackagingTriggerOptions } from './types/facade-v2';
import { FileItem, FailureItem, TransportOptions } from './types';
import { ScanOptions } from './types/scanner';
import { StabilityConfig, QueueConfig } from './types/queue';
import * as path from 'path';
import { scanFiles } from './core/scanner';
import { FileProcessingQueue } from './core/queue';
import * as fs from 'fs-extra';
import * as os from 'os';
import { createBatchPackage } from './core/packaging';
// 导入core模块下的关键功能
import { waitForFileStability } from './core/stability';
import { calculateFileMd5 } from './core/md5';
import { extractArchiveContents } from './core/archive';
import { transferFile } from './core/transport';
// un-rar需要单独安装，这里先注释掉，如果项目需要支持rar格式，需要安装这个库
// import * as unrar from 'un-rar';

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
const DEFAULT_RESULTS_DIR = './results';
const DEFAULT_PACKAGE_NAME_PATTERN = 'package_{date}_{index}';
const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const DEFAULT_SKIP_DIRS: string[] = [];
const DEFAULT_DEPTH = -1;
const DEFAULT_SCAN_NESTED_ARCHIVES = true;
const DEFAULT_MAX_NESTED_LEVEL = 5;
const DEFAULT_PACKAGING_TRIGGER: PackagingTriggerOptions = { maxFiles: 500, maxSizeMB: 2048 };
const DEFAULT_STABILITY_CONFIG: StabilityConfig = {
  base: {
    enabled: true,
    checkInterval: 500,
    maxRetries: 3
  },
  file: {
    enabled: true,
    checkInterval: 500,
    maxRetries: 3,
    largeFileThreshold: 100 * 1024 * 1024, // 100MB
    skipReadForLargeFiles: true
  },
  archive: {
    enabled: true,
    checkInterval: 1000,
    maxRetries: 3,
    keepTempFiles: false,
    // Add missing properties based on potential usage in stability worker
    skipLargeFiles: false,
    largeFileThreshold: undefined
  }
};
const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  enabled: true,
  maxConcurrentFileChecks: 5,
  maxConcurrentArchiveChecks: 3,
  maxConcurrentMd5: 5,
  maxConcurrentTransfers: 2,
  stabilityRetryDelay: 2000
};
const DEFAULT_TRANSPORT_RETRY_COUNT = 3;
const DEFAULT_TRANSPORT_TIMEOUT = 60000; // 60 秒

// 全局停止标志
let stopWorkers = false;

// 生成带时间戳的默认日志文件名
/* istanbul ignore next */ // 忽略测试覆盖率，因为它在测试中被单独测试
export function getDefaultLogFilePath(): string {
  const now = new Date();
  const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  return path.resolve(`./scan_transport_log_${timestamp}.log`);
}

/**
 * 生成结果文件路径
 * @param resultsDir 结果目录
 * @param taskId 任务ID
 * @param scanId 扫描ID
 */
function getResultFilePath(resultsDir: string, taskId: string, scanId: string): string {
  return path.join(resultsDir, `${taskId}-${scanId}.json`);
}

/**
 * 保存结果到文件
 * @param filePath 文件路径
 * @param data 要保存的数据
 */
async function saveResultToFile(filePath: string, data: any): Promise<void> {
  try {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, data, { spaces: 2 });
  } catch (error: any) {
    console.error(`Failed to save result to file ${filePath}: ${error.message}`);
    throw error;
  }
}

// --- Worker 函数实现 ---

// 2. Define isQueueTrulyIdle helper function
function isQueueTrulyIdle(queue: FileProcessingQueue): boolean {
  const stats = queue.getDetailedQueueStats();
  const packagingProcessing = queue.getProcessingSet('packaging')?.size ?? 0; // Packaging has no dedicated processing stat
  const transportProcessing = queue.getProcessingSet('transport')?.size ?? 0; // Check processing set for transport

  return (
    stats.fileStability.waiting === 0 && stats.fileStability.processing === 0 &&
    stats.archiveStability.waiting === 0 && stats.archiveStability.processing === 0 &&
    stats.md5.waiting === 0 && stats.md5.processing === 0 &&
    stats.packaging.waiting === 0 && packagingProcessing === 0 && // Check packaging queue and processing set
    stats.transport.waiting === 0 && transportProcessing === 0 // Check transport queue and processing set
  );
}

async function runStabilityWorker(
  queue: FileProcessingQueue,
  config: ScanAndTransportConfig,
  queueConfig: QueueConfig,
  logFilePath: string,
  onComplete: (file: FileItem, success: boolean, failureInfo?: FailureItem) => Promise<void>
): Promise<void> {
  await logToFile(logFilePath, "[Stability Worker] Started.");
  const stabilityConfig = { ...DEFAULT_STABILITY_CONFIG, ...config.stability }; // Merge stability config

  const processFile = async (file: FileItem, queueName: 'fileStability' | 'archiveStability') => {
    const isArchive = queueName === 'archiveStability';
    // Use merged stabilityConfig
    const stabilityConf = isArchive ? stabilityConfig.archive : stabilityConfig.file;
    const stabilityOptions = {
      enabled: true,
      maxRetries: stabilityConf?.maxRetries ?? DEFAULT_STABILITY_CONFIG.base!.maxRetries,
      checkInterval: stabilityConf?.checkInterval ?? DEFAULT_STABILITY_CONFIG.base!.checkInterval,
      largeFileThreshold: (stabilityConf as any)?.largeFileThreshold, // Use type assertion if needed
      skipReadForLargeFiles: (stabilityConf as any)?.skipReadForLargeFiles ?? DEFAULT_STABILITY_CONFIG.file!.skipReadForLargeFiles
    };

    try {
      await logToFile(logFilePath, `[Stability Worker] 检测 ${isArchive ? '压缩' : ''}文件稳定性: ${file.path}`);
      const isStable = await waitForFileStability(file.path, stabilityOptions);

      if (isStable) {
        const stats = await fs.stat(file.path);
        file.size = stats.size;
        if (!file.metadata) file.metadata = {};
        file.metadata.mtime = stats.mtime.toISOString();

        if (isArchive) {
          await logToFile(logFilePath, `[Stability Worker] 解压压缩文件: ${file.path}`);
          const tempOutputDir = path.join(
            os.tmpdir(),
            `scan-archive-extract-${config.taskId || 'task'}-${path.basename(file.path, path.extname(file.path))}-${Date.now()}`
          );
          try {
            const archiveStabilityConf = stabilityConfig.archive; // Get archive specific config
            const extractResult = await extractArchiveContents(file.path, tempOutputDir, {
              preservePermissions: false,
              // Pass merged config values correctly
              skipLargeFiles: archiveStabilityConf?.skipLargeFiles,
              largeFileThreshold: archiveStabilityConf?.largeFileThreshold
            });
            file.metadata.extractedPath = tempOutputDir;
            file.metadata.extractedFiles = extractResult.extractedFiles;
            if (extractResult.skippedLargeFiles && extractResult.skippedLargeFiles.length > 0) {
                file.metadata.skippedLargeFiles = extractResult.skippedLargeFiles;
            }
             await logToFile(logFilePath, `[Stability Worker] 压缩文件稳定性检测和提取完成: ${file.path}`);
             // 压缩文件稳定且解压成功 -> 进入 MD5 队列
             queue.addToQueue('md5', file);
             queue.getProcessingSet('archiveStability')?.delete(file.path); // Remove from processing *after* adding to next queue

          } catch (extractError: any) {
             await logToFile(logFilePath, `[Stability Worker] 压缩文件提取失败: ${file.path}, 错误: ${extractError.message}`);
             // Use valid FailureType
             const failureInfo: FailureItem = { type: 'extractArchive', path: file.path, error: `提取失败: ${extractError.message}` };
             queue.getProcessingSet('archiveStability')?.delete(file.path);
             await onComplete(file, false, failureInfo);
             return; // 提取失败则结束此文件处理
          }
        } else {
             await logToFile(logFilePath, `[Stability Worker] 文件稳定性检测完成: ${file.path}`);
             // 普通文件稳定 -> 进入 MD5 队列
             queue.addToQueue('md5', file);
             queue.getProcessingSet('fileStability')?.delete(file.path);
        }

      } else {
        await logToFile(logFilePath, `[Stability Worker] ${isArchive ? '压缩' : ''}文件稳定性检测失败 (超时/不稳定): ${file.path}`);
        // Use valid FailureType
        const failureInfo: FailureItem = { type: 'stability', path: file.path, error: '文件不稳定或检查超时' };
        if (isArchive) queue.getProcessingSet('archiveStability')?.delete(file.path);
        else queue.getProcessingSet('fileStability')?.delete(file.path);
        await onComplete(file, false, failureInfo);
      }
    } catch (error: any) {
      await logToFile(logFilePath, `[Stability Worker] ${isArchive ? '压缩' : ''}文件稳定性检测过程发生异常: ${file.path}, 错误: ${error.message}`);
      // Use valid FailureType
      const failureInfo: FailureItem = { type: 'stability', path: file.path, error: `稳定性检查异常: ${error.message}` };
      if (isArchive) queue.getProcessingSet('archiveStability')?.delete(file.path);
      else queue.getProcessingSet('fileStability')?.delete(file.path);
      await onComplete(file, false, failureInfo);
    }
  };

  // Read concurrency from the merged queueConfig passed as argument
  const fileConcurrency = queueConfig.maxConcurrentFileChecks;
  const archiveConcurrency = queueConfig.maxConcurrentArchiveChecks;

  while (!stopWorkers) {
    let processedInLoop = 0;
    let fileQueueEmpty = false;
    let archiveQueueEmpty = false;

    // 处理普通文件稳定性 (Use correct queue methods)
    const fileQueue = queue.getFilesInQueue('fileStability');
    const fileProcessingCount = queue.getProcessingSet('fileStability')?.size ?? 0;
    if (fileQueue.length === 0) fileQueueEmpty = true;

    if (fileQueue.length > 0 && fileProcessingCount < fileConcurrency!) {
      const availableSlots = fileConcurrency! - fileProcessingCount;
      const filesToProcess = fileQueue.slice(0, availableSlots);
      filesToProcess.forEach(file => {
          if (!queue.getProcessingSet('fileStability')?.has(file.path)) {
              queue.getProcessingSet('fileStability')?.add(file.path);
              processFile(file, 'fileStability').catch(e => { // Add catch for unhandled rejections
                   logToFile(logFilePath, `[Stability Worker] Unhandled error processing file ${file.path}: ${e.message}`)
                   queue.getProcessingSet('fileStability')?.delete(file.path);
                   // Consider calling onComplete here as well
              });
              processedInLoop++;
          }
      });
    }

    // 处理压缩文件稳定性 (Use correct queue methods)
    const archiveQueue = queue.getFilesInQueue('archiveStability');
    const archiveProcessingCount = queue.getProcessingSet('archiveStability')?.size ?? 0;
    if (archiveQueue.length === 0) archiveQueueEmpty = true;

    if (archiveQueue.length > 0 && archiveProcessingCount < archiveConcurrency!) {
       const availableSlots = archiveConcurrency! - archiveProcessingCount;
       const filesToProcess = archiveQueue.slice(0, availableSlots);
       filesToProcess.forEach(file => {
           if (!queue.getProcessingSet('archiveStability')?.has(file.path)) {
              queue.getProcessingSet('archiveStability')?.add(file.path);
              processFile(file, 'archiveStability').catch(e => { // Add catch
                  logToFile(logFilePath, `[Stability Worker] Unhandled error processing archive ${file.path}: ${e.message}`)
                  queue.getProcessingSet('archiveStability')?.delete(file.path);
              });
              processedInLoop++;
           }
       });
    }

    if (processedInLoop === 0) {
        // Use queue's getDetailedQueueStats for idle check
        const stats = queue.getDetailedQueueStats();
        if (fileQueueEmpty && fileProcessingCount === 0 &&
            archiveQueueEmpty && archiveProcessingCount === 0 &&
            // Check if downstream queues are also idle or empty
            (stats.md5.waiting === 0 && stats.md5.processing === 0) &&
            (stats.packaging.waiting === 0) && // Packaging is serial, only check waiting
            (stats.transport.waiting === 0 && stats.transport.processing === 0))
        {
            await logToFile(logFilePath, "[Stability Worker] Queues empty and upstream done/idle, waiting for global stop.");
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait longer if idle
    } else {
        await new Promise(resolve => setTimeout(resolve, 50)); // Shorter wait if active
    }
  }

  await logToFile(logFilePath, "[Stability Worker] Stopped.");
}

async function runMd5Worker(
  queue: FileProcessingQueue,
  config: ScanAndTransportConfig,
  queueConfig: QueueConfig,
  logFilePath: string,
  onComplete: (file: FileItem, success: boolean, failureInfo?: FailureItem) => Promise<void>
): Promise<void> {
  await logToFile(logFilePath, "[MD5 Worker] Started.");
  const calculateMd5Enabled = config.calculateMd5 !== false; // Default true

  const processFile = async (file: FileItem) => {
    try {
      let processedFile = file;
      if (calculateMd5Enabled) {
        await logToFile(logFilePath, `[MD5 Worker] 计算 MD5: ${file.path}`);
        processedFile = await calculateFileMd5(file);
        await logToFile(logFilePath, `[MD5 Worker] MD5 计算完成: ${file.path}, MD5: ${processedFile.metadata?.md5}`);
      } else {
        await logToFile(logFilePath, `[MD5 Worker] 跳过 MD5 计算 (已禁用): ${file.path}`);
      }

      // 成功 (计算完成或跳过) -> 进入 Packaging 队列
      queue.addToQueue('packaging', processedFile);
      // Let onComplete handle final state change

    } catch (error: any) {
      await logToFile(logFilePath, `[MD5 Worker] MD5 计算失败: ${file.path}, 错误: ${error.message}`);
      // Use valid FailureType
      const failureInfo: FailureItem = { type: 'md5', path: file.path, error: `MD5 计算失败: ${error.message}` };
      await onComplete(file, false, failureInfo);
      // onComplete should trigger removal via markAsFailed
    } finally {
        queue.getProcessingSet('md5')?.delete(file.path); // Remove from processing set
    }
  };

  const concurrency = queueConfig.maxConcurrentMd5;

  while (!stopWorkers) {
    let processedInLoop = 0;
    // Use correct queue methods
    const md5Queue = queue.getFilesInQueue('md5');
    const processingCount = queue.getProcessingSet('md5')?.size ?? 0;

    if (md5Queue.length > 0 && processingCount < concurrency!) {
      const availableSlots = concurrency! - processingCount;
      const filesToProcess = md5Queue.slice(0, availableSlots);

      filesToProcess.forEach(file => {
        if (!queue.getProcessingSet('md5')?.has(file.path)) {
            queue.getProcessingSet('md5')?.add(file.path);
            processFile(file).catch(e => { // Add catch
                logToFile(logFilePath, `[MD5 Worker] Unhandled error processing ${file.path}: ${e.message}`)
                queue.getProcessingSet('md5')?.delete(file.path);
            });
            processedInLoop++;
        }
      });
    }

    // Use getDetailedQueueStats for idle check
    const stats = queue.getDetailedQueueStats();
    if (md5Queue.length === 0 && processingCount === 0 &&
        // Check if upstream (stability) queues are empty/idle
        (stats.fileStability.waiting === 0 && stats.fileStability.processing === 0) &&
        (stats.archiveStability.waiting === 0 && stats.archiveStability.processing === 0) &&
        // Check if downstream queues are also empty/idle
        (stats.packaging.waiting === 0) &&
        (stats.transport.waiting === 0 && stats.transport.processing === 0))
    {
        await logToFile(logFilePath, "[MD5 Worker] Queue empty and upstream done/idle, waiting for global stop.");
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await logToFile(logFilePath, "[MD5 Worker] Stopped.");
}

async function runPackagingWorker(
  queue: FileProcessingQueue,
  config: ScanAndTransportConfig,
  logFilePath: string,
  packagePaths: string[],
  onComplete: (file: FileItem, success: boolean, failureInfo?: FailureItem) => Promise<void>,
  taskId: string,
  scanId: string,
  outputDir: string,
  packageNamePattern: string
): Promise<void> {
  await logToFile(logFilePath, "[Packaging Worker] Started.");
  // Remove queue.on call
  // let stopWorker = false;
  // queue.on('stop', () => { stopWorker = true; });
  const workerId = '[Packaging Worker]';
  let packageIndex = 0;
  // Use DEFAULT_PACKAGING_TRIGGER correctly
  const mergedPackagingTrigger = { ...DEFAULT_PACKAGING_TRIGGER, ...config.packagingTrigger };
  const packageSizeThresholdBytes = (mergedPackagingTrigger.maxSizeMB ?? 0) * 1024 * 1024;
  const packageFileThreshold = mergedPackagingTrigger.maxFiles ?? 0;
  const packageCheckInterval = 1000; // Check every second

  const pendingPackageFiles: FileItem[] = [];
  let currentPackageSizeBytes = 0;
  let lastActivityTime = Date.now();

  try {
      await fs.ensureDir(outputDir);
  } catch (dirError: any) {
      await logToFile(logFilePath, `${workerId} CRITICAL: Failed to create output directory ${outputDir}: ${dirError.message}. Worker stopping.`);
      return; // Stop if cannot create output dir
  }

  const getPackagePath = (index: number): string => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Restore original naming
      const name = packageNamePattern
          .replace('{date}', timestamp)
          .replace('{index}', String(index))
          .replace('{taskId}', taskId)
          .replace('{scanId}', scanId);
      return path.join(outputDir, `${name}.zip`);
  };

  // Add suppressOnComplete parameter
  const createAndProcessPackage = async (
      filesToPackInput: FileItem[], // Rename input parameter
      isFinalPackage: boolean = false,
      suppressOnComplete: boolean = false
  ): Promise<void> => {
      // --- Deduplicate files based on path --- START
      const uniqueFileMap = new Map<string, FileItem>();
      for (const file of filesToPackInput) {
          if (!uniqueFileMap.has(file.path)) {
              uniqueFileMap.set(file.path, file);
          }
      }
      const filesToPack = Array.from(uniqueFileMap.values()); // Use the deduplicated list
      // --- Deduplicate files based on path --- END

      if (filesToPack.length === 0) {
          await logToFile(logFilePath, `${workerId} No unique files to pack after deduplication. Original input count: ${filesToPackInput.length}`);
          // Handle completion for original files if needed (similar to previous attempt)
          if (!suppressOnComplete) {
              for (const originalFile of filesToPackInput) {
                  // Consider marking as completed if they were just duplicates
                  await onComplete(originalFile, true); 
              }
          }
          return;
      }
  
      const packagePath = getPackagePath(packageIndex++);
      const totalSizeMB = filesToPack.reduce((sum, file) => sum + (file.size || 0), 0) / (1024 * 1024);
      await logToFile(logFilePath, `${workerId} Creating ${isFinalPackage ? 'final ' : ''}package: ${path.basename(packagePath)}, Files: ${filesToPack.length} (Unique), Size: ${totalSizeMB.toFixed(2)}MB`);
      const originalFilePaths = filesToPack.map(f => f.path); // Use unique list for metadata
  
      // Log the unique files being attempted to pack
      const filePathsToPack = filesToPack.map(f => f.path);
      await logToFile(logFilePath, `${workerId} Attempting to pack unique files: ${JSON.stringify(filePathsToPack)}`);
  
      try {
          // Use the unique list `filesToPack` here
          const packResult = await createBatchPackage(filesToPack, packagePath, {
              includeMd5: config.calculateMd5 !== false,
              includeMetadata: true,
              packageTags: [`task:${taskId}`, `scan:${scanId}`]
          });
  
          if (packResult.success) {
              packagePaths.push(packagePath);
              await logToFile(logFilePath, `${workerId} Package created successfully: ${packagePath}`);
  
              const packageStats = await fs.stat(packagePath);
              const packageFileItem: FileItem = {
                  path: packagePath,
                  name: path.basename(packagePath),
                  size: packageStats.size,
                  createTime: packageStats.birthtime,
                  modifyTime: packageStats.mtime,
                  origin: 'package',
                  metadata: {
                       packagedFiles: originalFilePaths,
                       fileCount: filesToPack.length, // Use unique count
                       originalSize: totalSizeMB * 1024 * 1024,
                       taskId: taskId,
                       scanId: scanId
                  }
              };
              queue.addToQueue('transport', packageFileItem);
              await logToFile(logFilePath, `${workerId} Package ${path.basename(packagePath)} added to transport queue.`);
  
             // Iterate over the UNIQUE list for completion
             if (!suppressOnComplete) {
                 for (const uniqueFile of filesToPack) {
                      await onComplete(uniqueFile, true);
                  }
              } else {
                  await logToFile(logFilePath, `${workerId} Suppressing onComplete for final package: ${path.basename(packagePath)}`);
              }
  
          } else {
              await logToFile(logFilePath, `${workerId} Failed to create package ${packagePath}: ${packResult.error}`);
              // Iterate over the UNIQUE list for failure marking
              for (const uniqueFile of filesToPack) {
                  await onComplete(uniqueFile, false, {
                      type: 'packaging',
                      path: uniqueFile.path,
                      error: `Failed to include in package ${packagePath}: ${packResult.error}`
                  });
              }
          }
      } catch (error: any) {
          await logToFile(logFilePath, `${workerId} Error creating package ${packagePath}: ${error.message}`);
          // Iterate over the UNIQUE list for failure marking
          for (const uniqueFile of filesToPack) {
              await onComplete(uniqueFile, false, {
                  type: 'packaging',
                  path: uniqueFile.path,
                  error: `Exception during packaging for ${packagePath}: ${error.message}`
              });
          }
      }
  };

  // Restore timer logic similar to original approach
  let checkUpstreamInterval: NodeJS.Timeout | null = null;
  // Define timer variable
  let timer: NodeJS.Timeout | null = null;

  const checkUpstreamAndFinalize = async () => {
      if (checkUpstreamInterval) clearTimeout(checkUpstreamInterval);
      checkUpstreamInterval = null;

      if (stopWorkers) return;

      // Restore upstream check logic using queue methods
      const packagingQueue = queue.getFilesInQueue('packaging');
      const md5Queue = queue.getFilesInQueue('md5');
      const md5Processing = queue.getProcessingSet('md5')?.size ?? 0;
      const isUpstreamIdle = md5Queue.length === 0 && md5Processing === 0;

      if (isUpstreamIdle && packagingQueue.length === 0 && pendingPackageFiles.length > 0) {
          const timeSinceLastActivity = Date.now() - lastActivityTime;
          if (timeSinceLastActivity > 2000) { // Inactivity threshold
              await logToFile(logFilePath, `${workerId} Upstream idle, queue empty, inactivity detected. Creating final package.`);
              const filesToPack = [...pendingPackageFiles];
              pendingPackageFiles.length = 0;
              currentPackageSizeBytes = 0;
              // Pass suppressOnComplete: true for the final package (Keep this)
              await createAndProcessPackage(filesToPack, true, true);
          } else {
              if (!stopWorkers) checkUpstreamInterval = setTimeout(checkUpstreamAndFinalize, 500); // Check sooner
          }
      } else {
         if (!stopWorkers) checkUpstreamInterval = setTimeout(checkUpstreamAndFinalize, packageCheckInterval); // Regular check
      }
  };
  // Assign to timer variable
  timer = setTimeout(checkUpstreamAndFinalize, packageCheckInterval);


  // Restore main loop using correct queue methods and stopWorkers flag
  while (!stopWorkers) {
      const packagingQueue = queue.getFilesInQueue('packaging');
      let file: FileItem | undefined = undefined;

      if (packagingQueue.length > 0) {
          file = packagingQueue.shift(); // Use shift to get and remove
      }

      if (file) {
          lastActivityTime = Date.now();
          pendingPackageFiles.push(file);
          currentPackageSizeBytes += file.size || 0;

          const shouldPackageBySize = packageSizeThresholdBytes > 0 && currentPackageSizeBytes >= packageSizeThresholdBytes;
          const shouldPackageByCount = packageFileThreshold > 0 && pendingPackageFiles.length >= packageFileThreshold;

          if (shouldPackageByCount || shouldPackageBySize) {
              await logToFile(logFilePath, `${workerId} Trigger met during file add (Files: ${shouldPackageByCount}, Size: ${shouldPackageBySize}). Creating package.`);
              const filesToPack = [...pendingPackageFiles];
              pendingPackageFiles.length = 0; // Clear pending
              currentPackageSizeBytes = 0;
              await createAndProcessPackage(filesToPack, false); // Regular package
              await new Promise(resolve => setImmediate(resolve)); // Yield
          }
      } else {
          // If queue empty, wait before next check
          await new Promise(resolve => setTimeout(resolve, 100));
      }
  }

  // --- Restore Cleanup --- (Keep suppressOnComplete logic)
  // Clear the correct timer
  if (timer) clearInterval(timer);
  await logToFile(logFilePath, `${workerId} Stop signal received. Starting cleanup.`);

  // Final package for any remaining files
  const remainingFiles = [...pendingPackageFiles];
  if (remainingFiles.length > 0) {
      await logToFile(logFilePath, `${workerId} Creating final package during cleanup for ${remainingFiles.length} files.`);
      // Pass suppressOnComplete: true for the final package
      await createAndProcessPackage(remainingFiles, true, true);
  }

  await logToFile(logFilePath, `${workerId} Stopped.`);
}

async function runTransportWorker(
  queue: FileProcessingQueue,
  config: ScanAndTransportConfig,
  queueConfig: QueueConfig,
  logFilePath: string,
  transportResults: { success: boolean; filePath: string; remotePath: string; error?: string }[],
  taskId: string,
  scanId: string
): Promise<void> {
  await logToFile(logFilePath, "[Transport Worker] Started.");

  if (!config.transport.enabled) {
    await logToFile(logFilePath, "[Transport Worker] Transport disabled, worker will idle.");
    // No loop needed if disabled
    while(!stopWorkers) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await logToFile(logFilePath, "[Transport Worker] Stopped (was disabled).");
    return;
  }

  const processFile = async (packageFile: FileItem) => {
    try {
      await logToFile(logFilePath, `[Transport Worker] 开始传输文件: ${packageFile.path}`);
      const remoteBasePath = config.transport.remotePath || '/';
      // Construct relative path for transport function
      const relativeRemotePath = path.posix.join(`${taskId}-${scanId}`, path.basename(packageFile.path));
      const expectedRemoteFullPath = path.posix.join(remoteBasePath, relativeRemotePath);

      // Build transport options EXPLICITLY using merged/default values
      const transportOptions: TransportOptions = {
          enabled: true,
          protocol: config.transport.protocol,
          host: config.transport.host,
          port: config.transport.port,
          username: config.transport.username,
          password: config.transport.password,
          remotePath: remoteBasePath, // Base path for connection
          // Use defaults for retry/timeout if not provided in config
          retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
          timeout: DEFAULT_TRANSPORT_TIMEOUT,
          debug: false,
          packageSize: 1,
      };

      // Perform the transfer using relative path
      const result = await transferFile(
        packageFile.path,
        relativeRemotePath, // Relative path for the specific file
        transportOptions
      );

      // Record the result
      transportResults.push({
          success: result.success,
          filePath: result.filePath,
          remotePath: result.remotePath || expectedRemoteFullPath, // Use result path, fallback to constructed
          error: result.error
      });

      if (result.success) {
          await logToFile(logFilePath, `[Transport Worker] 传输成功: ${packageFile.path} -> ${result.remotePath}`);
          // Signal completion for the *package file* (not the originals)
          queue.markAsCompleted(packageFile.path);
      } else {
          await logToFile(logFilePath, `[Transport Worker] 传输失败: ${packageFile.path}, 错误: ${result.error}`);
          // Use valid FailureType for the *package file*
          const failureInfo: FailureItem = { type: 'transport', path: packageFile.path, error: `传输失败: ${result.error}` };
          queue.markAsFailed(packageFile.path, failureInfo); // Mark package failed
      }

    } catch (error: any) {
        const errorMessage = error.message || '未知传输错误';
        await logToFile(logFilePath, `[Transport Worker] 传输过程发生异常: ${packageFile.path}, 错误: ${errorMessage}`);
        transportResults.push({
            success: false,
            filePath: packageFile.path,
            remotePath: path.posix.join(config.transport.remotePath || '/', `${taskId}-${scanId}`, path.basename(packageFile.path)),
            error: `传输异常: ${errorMessage}`
        });
        // Use valid FailureType for the *package file*
        const failureInfo: FailureItem = { type: 'transport', path: packageFile.path, error: `传输异常: ${errorMessage}` };
        queue.markAsFailed(packageFile.path, failureInfo);
    } finally {
        queue.getProcessingSet('transport')?.delete(packageFile.path);
    }
  };

  // Restore concurrency control and loop
  const concurrency = queueConfig.maxConcurrentTransfers;

  while (!stopWorkers) {
      let processedInLoop = 0;
      const transportQueue = queue.getFilesInQueue('transport');
      const processingCount = queue.getProcessingSet('transport')?.size ?? 0;

      if (transportQueue.length > 0 && processingCount < concurrency!) {
          const availableSlots = concurrency! - processingCount;
          const filesToProcess = transportQueue.slice(0, availableSlots);

          filesToProcess.forEach(file => {
              if (!queue.getProcessingSet('transport')?.has(file.path)) {
                  queue.getProcessingSet('transport')?.add(file.path);
                  processFile(file).catch(e => { // Add catch
                       logToFile(logFilePath, `[Transport Worker] Unhandled error processing ${file.path}: ${e.message}`)
                       queue.getProcessingSet('transport')?.delete(file.path);
                  });
                  processedInLoop++;
              }
          });
      }

      // Use getDetailedQueueStats for idle check
      const stats = queue.getDetailedQueueStats();
      if (transportQueue.length === 0 && processingCount === 0 &&
          // Check if upstream (packaging) is idle
          (stats.packaging.waiting === 0))
      {
          await logToFile(logFilePath, "[Transport Worker] Transport queue empty and packaging likely done, waiting for global stop.");
      }
      await new Promise(resolve => setTimeout(resolve, 500));
  }

  await logToFile(logFilePath, "[Transport Worker] Stopped.");
}

export async function scanAndTransport(config: ScanAndTransportConfig): Promise<ScanAndTransportResult> {
  const startTime = new Date();
  const taskId = config.taskId || `task-${Date.now()}`;
  const scanId = `scan-${Date.now()}`;
  stopWorkers = false; // Reset global stop flag at the beginning

  // --- Config Validation and Defaults ---
  if (!config.rootDir || !await fs.pathExists(config.rootDir)) {
     throw new Error('Invalid configuration: rootDir is required and must exist.');
  }
  const outputDir = path.resolve(config.outputDir ?? DEFAULT_OUTPUT_DIR);
  const resultsDir = path.resolve(config.resultsDir ?? DEFAULT_RESULTS_DIR);
  await fs.ensureDir(outputDir);
  await fs.ensureDir(resultsDir);

  const logFilePath = config.logFilePath ? path.resolve(config.logFilePath) : getDefaultLogFilePath();
  await fs.ensureFile(logFilePath);
  await logToFile(logFilePath, `--- ScanAndTransport Start (Pipeline Mode) ---`);
  // ... (log initial config)

  // --- Setup Queue and Stability Config --- (Restore correct merging and instantiation)
  const mergedQueueConfig: QueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    ...(config.queue ?? {}) // Ensure config.queue is handled if undefined
    // Remove maxConcurrentPackaging
  };
  const mergedStabilityConfig: StabilityConfig = {
      base: { ...DEFAULT_STABILITY_CONFIG.base, ...(config.stability?.base ?? {}) },
      file: { ...DEFAULT_STABILITY_CONFIG.file, ...(config.stability?.file ?? {}) },
      archive: { ...DEFAULT_STABILITY_CONFIG.archive, ...(config.stability?.archive ?? {}) }
  };
  // Instantiate queue correctly
  const queue = new FileProcessingQueue(mergedQueueConfig, mergedStabilityConfig);

  // --- Results Tracking --- (Restore original)
  const matchedFiles: FileItem[] = []; // Track initially matched files if needed
  const failedItems: FailureItem[] = [];
  const packagePaths: string[] = [];
  const transportResults: { success: boolean; filePath: string; remotePath: string; error?: string }[] = [];

  // --- Completion Tracking --- (Restore original)
  let totalFilesScanned = 0;
  let processedCount = 0;
  let failedCount = 0;

  // --- Define handleFileCompletion --- (Restore original logic, fix FailureType)
  const handleFileCompletion = async (file: FileItem, success: boolean, failureInfo?: FailureItem) => {
      const uniqueId = file.path; // Use path as the unique identifier

      // Ensure completion isn't resolved multiple times
      // This simple check might need refinement if racing conditions are complex
      if (processedCount + failedCount >= totalFilesScanned && totalFilesScanned > 0) {
          // Already completed, log if needed but don't change counts or resolve again
          await logToFile(logFilePath, `[Completion] Received completion for ${uniqueId} after primary completion signal.`);
          // Still mark in queue if necessary?
          if(success) queue.markAsCompleted(uniqueId);
          else queue.markAsFailed(uniqueId, failureInfo);
          return;
      }

      if (success) {
          processedCount++;
          // Remove entryPath
          await logToFile(logFilePath, `[Completion] 文件成功处理: ${file.path}. Progress: ${processedCount + failedCount}/${totalFilesScanned}`);
          queue.markAsCompleted(uniqueId);
      } else {
          failedCount++;
          if (failureInfo) {
              failedItems.push(failureInfo);
              // Remove entryPath
              await logToFile(logFilePath, `[Completion] 文件处理失败: ${failureInfo.path}. Error: ${failureInfo.error}. Progress: ${processedCount + failedCount}/${totalFilesScanned}`);
          } else {
              // Use a valid FailureType like 'scanError' if 'processing' is not valid
              const genericFailure: FailureItem = { type: 'scanError', path: file.path, error: 'Unknown processing error' };
              failedItems.push(genericFailure);
              await logToFile(logFilePath, `[Completion] 文件处理失败 (unknown): ${file.path}. Progress: ${processedCount + failedCount}/${totalFilesScanned}`);
          }
          queue.markAsFailed(uniqueId, failureInfo);
      }

      // Check completion condition (Restore original)
      if (totalFilesScanned > 0 && (processedCount + failedCount >= totalFilesScanned)) {
          await logToFile(logFilePath, `[Completion] 所有 ${totalFilesScanned} 文件已处理完毕 (Success: ${processedCount}, Failed: ${failedCount}).`);
          // No need to mark upstream done here, resolve is enough
          return; // Resolve the main promise
      } else if (totalFilesScanned === 0 && failedCount === 0 && processedCount === 0) {
          await logToFile(logFilePath, `[Completion] 未扫描到需要处理的文件.`);
          return; // Resolve if scan found nothing
      }
  };


  // --- Result Object --- (Define structure according to type)
  const result: ScanAndTransportResult = {
    success: false, // Will be updated in finally block
    processedFiles: [], // Note: Not populated in pipeline mode
    failedItems: failedItems,
    packagePaths: packagePaths,
    transportSummary: transportResults,
    logFilePath: logFilePath,
    taskId: taskId,
    scanId: scanId,
    resultFilePath: getResultFilePath(resultsDir, taskId, scanId),
    startTime: startTime,
    endTime: new Date(), // Placeholder, updated in finally
    elapsedTimeMs: 0 // Placeholder, updated in finally
  };

  // --- Worker Promises --- (Define before try block)
  let stabilityWorkerPromise: Promise<void> | undefined;
  let md5WorkerPromise: Promise<void> | undefined;
  let packagingWorkerPromise: Promise<void> | undefined;
  let transportWorkerPromise: Promise<void> | undefined;

  try {
    // --- Start Workers ---
    await logToFile(logFilePath, "启动处理 Workers...");
    stabilityWorkerPromise = runStabilityWorker(queue, config, mergedQueueConfig, logFilePath, handleFileCompletion);
    md5WorkerPromise = runMd5Worker(queue, config, mergedQueueConfig, logFilePath, handleFileCompletion);
    packagingWorkerPromise = runPackagingWorker(queue, config, logFilePath, packagePaths, handleFileCompletion, taskId, scanId, outputDir, config.packageNamePattern || DEFAULT_PACKAGE_NAME_PATTERN);
    transportWorkerPromise = runTransportWorker(queue, config, mergedQueueConfig, logFilePath, transportResults, taskId, scanId);

    // --- Start Scan --- (Restore scanFiles usage)
    const scanOptions: ScanOptions = {
      rootDir: path.resolve(config.rootDir),
      matchRules: config.rules,
      depth: config.depth ?? DEFAULT_DEPTH,
      maxFileSize: config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      skipDirs: (config.skipDirs ?? DEFAULT_SKIP_DIRS).map(dir => path.resolve(config.rootDir, dir)),
      scanNestedArchives: config.scanNestedArchives ?? DEFAULT_SCAN_NESTED_ARCHIVES,
      maxNestedLevel: config.maxNestedLevel ?? DEFAULT_MAX_NESTED_LEVEL,
      taskId: taskId,
      // Use ts-ignore to suppress type mismatch for onProgress
      // @ts-ignore
      onProgress: (progress: any, file: any) => {
        if (config.onProgress) {
          config.onProgress(progress, file);
        } else {
            // Default logging (can use progress if needed)
            // logToFile(logFilePath, `Scanning Dir: ${path.relative(config.rootDir, progress.currentDir) || '.'}...`);
        }
      },
      onFileMatched: (file, progress) => {
        matchedFiles.push(file); // Track matched files
        if (file.origin === 'archive') {
            queue.addToQueue('archiveStability', file);
        } else {
            queue.addToQueue('fileStability', file);
        }
        if (config.onProgress) { config.onProgress(progress, file); }
      },
      onFailure: (failure, progress) => {
        // Use valid FailureType 'scanError'
        const scanFailure: FailureItem = { ...failure, type: 'scanError' };
        failedItems.push(scanFailure);
        failedCount++;
        logToFile(logFilePath, `扫描失败: ${failure.path}, 类型: ${failure.type}, 错误: ${failure.error}`);
        if (config.onProgress) { config.onProgress(progress); }
      }
    };

    await logToFile(logFilePath, "开始扫描文件...");
    const scanResult = await scanFiles(scanOptions);
    totalFilesScanned = scanResult.matchedFiles.length;
    const scanErrorCount = failedItems.filter(f => f.type === 'scanError').length; // Count scan-specific errors
    await logToFile(logFilePath, `扫描完成，找到 ${totalFilesScanned} 个匹配文件，扫描失败 ${scanErrorCount} 个`);

    // --- Wait for Queue Idle ---
    let shouldExitEarly = false;
    await logToFile(logFilePath, "Briefly pausing to allow queue population...");
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay

    if (totalFilesScanned === 0) {
        await logToFile(logFilePath, "未找到匹配文件，无需等待队列。");
        shouldExitEarly = true;
    } else if (failedCount >= totalFilesScanned) {
         await logToFile(logFilePath, `所有扫描到的文件在扫描阶段已失败，任务完成。`);
         shouldExitEarly = true;
    }

    if (!shouldExitEarly) {
        await logToFile(logFilePath, "Scan complete. Waiting for all processing queues to become idle...");
        let idleCheckCounter = 0;
        while (!isQueueTrulyIdle(queue)) {
             idleCheckCounter++;
             if (idleCheckCounter % 20 === 0) {
                 const stats = queue.getDetailedQueueStats();
                 await logToFile(logFilePath, `Waiting for idle (${idleCheckCounter/2}s): ${JSON.stringify(stats)}`);
             }
             await new Promise(resolve => setTimeout(resolve, 500));
             if (stopWorkers) {
                 await logToFile(logFilePath, "Stop signal received while waiting for idle. Breaking wait loop.");
                 break;
             }
        }
        if (!stopWorkers) {
             await logToFile(logFilePath, "All processing queues are idle.");
        }
    }
  
    // --- Signal Workers to Stop --- (Keep this part)
    await logToFile(logFilePath, "Signaling workers to stop...");
    stopWorkers = true;
    // Remove queue.signalStop()

    // --- Wait for Workers to Fully Stop --- (Keep this part)
    await logToFile(logFilePath, "[Main] Waiting for all workers to finish cleanup and stop...");
    const workerPromises = [stabilityWorkerPromise, md5WorkerPromise, packagingWorkerPromise, transportWorkerPromise].filter(p => p !== undefined) as Promise<void>[];
    await Promise.all(workerPromises);
    await logToFile(logFilePath, "[Main] All workers have stopped.");

  } catch (error: any) {
    // Restore top-level error handling
    failedCount++;
    // Use 'scanError' or a more generic type if applicable
    failedItems.push({ type: 'scanError', path: config.rootDir, error: `顶层错误: ${error.message || String(error)}` });
    await logToFile(logFilePath, `*** 顶层错误: ${error.message || String(error)} ***`);
    console.error('Error during scanAndTransport:', error);
    if (failedCount >= totalFilesScanned || totalFilesScanned === 0) {
        // Ensure completion is resolved if an error occurs before normal completion
        return result;
    }
    stopWorkers = true;
  } finally {
    // --- Wait for Workers in Finally (Best Effort) --- (Keep this part)
    if (stopWorkers) {
        await logToFile(logFilePath, `[Main - Finally] Ensuring workers stop and waiting...`);
        const workerPromises = [stabilityWorkerPromise, md5WorkerPromise, packagingWorkerPromise, transportWorkerPromise].filter(p => p !== undefined) as Promise<void>[];
        try {
            await Promise.race([
                Promise.all(workerPromises),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Worker stop timeout")), 10000)) // 10 sec timeout
            ]);
            await logToFile(logFilePath, `[Main - Finally] All workers confirmed stopped.`);
        } catch (stopTimeoutError: any) {
             await logToFile(logFilePath, `[Main - Finally] Warning: ${stopTimeoutError.message}. Proceeding with results.`);
        }
    }

    // --- Finalize Results --- (Restore structure)
    const endTime = new Date();
    const elapsedTimeMs = endTime.getTime() - startTime.getTime();
    // Calculate final success based only on failedItems count vs total scanned
    const finalSuccess = failedItems.length === 0 && totalFilesScanned > 0;

    // Update the result object defined earlier
    result.success = finalSuccess;
    result.failedItems = failedItems;
    result.packagePaths = packagePaths;
    result.transportSummary = transportResults;
    result.endTime = endTime;
    result.elapsedTimeMs = elapsedTimeMs;
    // Remove properties not in ScanAndTransportResult type
    // result.rootDir, filesScanned, filesMatched, etc.

    await logToFile(logFilePath, `--- ScanAndTransport End (Pipeline Mode) ---`);
    await logToFile(logFilePath, `结束时间: ${endTime.toISOString()}`);
    await logToFile(logFilePath, `耗时: ${elapsedTimeMs}ms`);
    await logToFile(logFilePath, `成功: ${result.success}`);
    await logToFile(logFilePath, `失败项数: ${failedItems.length}`); // Based on collected failures
    await logToFile(logFilePath, `扫描匹配文件数: ${totalFilesScanned}`);
    await logToFile(logFilePath, `包数量: ${packagePaths.length}`);
    // Save results *before* trying to upload
    await saveResultToFile(result.resultFilePath, result);
    await logToFile(logFilePath, `结果已保存到: ${result.resultFilePath}`);

    // --- Upload Results/Logs --- (Fix transferFile call)
    if (config.transport?.enabled) {
       const transportConfig = config.transport;
       const remoteSubDir = `${taskId}-${scanId}`;
       try {
           // Upload Result File
           await logToFile(logFilePath, `准备上传结果文件: ${result.resultFilePath}`);
           // Construct relative path for transferFile
           const relativeResultPath = path.posix.join(remoteSubDir, path.basename(result.resultFilePath));
           // Ensure transportConfig used here includes necessary fields like packageSize
           const resultTransportOpts: TransportOptions = {
                // Copy known fields from transportConfig
                protocol: transportConfig.protocol,
                host: transportConfig.host,
                port: transportConfig.port,
                username: transportConfig.username,
                password: transportConfig.password,
                remotePath: transportConfig.remotePath,
                enabled: true,
                // Use defaults for potentially missing fields
                retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
                timeout: DEFAULT_TRANSPORT_TIMEOUT,
                debug: false,
                packageSize: 1 // Add required packageSize
           };
             // Correct transferFile call (use relative path)
             const resultUploadResult = await transferFile(result.resultFilePath, relativeResultPath, resultTransportOpts);
             if (resultUploadResult.success) {
                 // Log the full expected path for clarity
                 const fullRemotePath = path.posix.join(transportConfig.remotePath || '/', relativeResultPath);
                 await logToFile(logFilePath, `结果文件上传成功: ${fullRemotePath}`);
             } else {
                 await logToFile(logFilePath, `上传结果文件失败: ${resultUploadResult.error}`);
             }
       } catch (e: any) {
           await logToFile(logFilePath, `上传结果文件时发生异常: ${e.message}`);
       }
       try {
           // Upload Log File
           await logToFile(logFilePath, `准备上传日志文件: ${logFilePath}`);
           // Construct relative path for transferFile
           const relativeLogPath = path.posix.join(remoteSubDir, path.basename(logFilePath));
           // Ensure transportConfig used here includes necessary fields like packageSize
           const logTransportOpts: TransportOptions = {
                // Copy known fields from transportConfig
                protocol: transportConfig.protocol,
                host: transportConfig.host,
                port: transportConfig.port,
                username: transportConfig.username,
                password: transportConfig.password,
                remotePath: transportConfig.remotePath,
                enabled: true,
                // Use defaults for potentially missing fields
                retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
                timeout: DEFAULT_TRANSPORT_TIMEOUT,
                debug: false,
                packageSize: 1 // Add required packageSize
           };
             // Correct transferFile call (use relative path)
             const logUploadResult = await transferFile(logFilePath, relativeLogPath, logTransportOpts);
             if (logUploadResult.success) {
                 // Log the full expected path for clarity
                 const fullRemotePath = path.posix.join(transportConfig.remotePath || '/', relativeLogPath);
                 await logToFile(logFilePath, `日志文件上传成功: ${fullRemotePath}`);
             } else {
                 await logToFile(logFilePath, `上传日志文件失败: ${logUploadResult.error}`);
             }
       } catch (e: any) {
           await logToFile(logFilePath, `上传日志文件时发生异常: ${e.message}`);
       }
    }

    return result; // Return the final result object
  }
} 