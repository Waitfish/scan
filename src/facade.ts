import { ScanAndTransportConfig, ScanAndTransportResult, PackagingTriggerOptions } from './types/facade-v2';
import { FileItem, FailureItem, TransportOptions } from './types';
import { ScanOptions } from './types/scanner';
import { StabilityConfig, QueueConfig } from './types/queue';
import * as path from 'path';
import { scanFiles } from './core/scanner';
import { FileProcessingQueue } from './core/queue';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';
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
const DEFAULT_PACKAGE_NAME_PATTERN = 'package_{taskId}_{index}';
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
    keepTempFiles: false
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

/**
 * 执行扫描、打包和传输的简化流程函数
 * @param config 配置对象
 * @returns 包含处理结果和日志路径的对象
 */
export async function scanAndTransport(config: ScanAndTransportConfig): Promise<ScanAndTransportResult> {
  // 记录开始时间
  const startTime = new Date();
  
  // 1. 合并配置与默认值
  const taskId = config.taskId || crypto.randomUUID(); // 使用提供的任务ID或生成新的
  const scanId = `scan_${startTime.getTime()}`; // 基于时间戳创建扫描ID
  
  const outputDir = path.resolve(config.outputDir ?? DEFAULT_OUTPUT_DIR);
  const resultsDir = path.resolve(config.resultsDir ?? DEFAULT_RESULTS_DIR);
  const packageNamePattern = config.packageNamePattern ?? DEFAULT_PACKAGE_NAME_PATTERN;
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const skipDirs = config.skipDirs ?? DEFAULT_SKIP_DIRS;
  const depth = config.depth ?? DEFAULT_DEPTH;
  const scanNestedArchives = config.scanNestedArchives ?? DEFAULT_SCAN_NESTED_ARCHIVES;
  const maxNestedLevel = config.maxNestedLevel ?? DEFAULT_MAX_NESTED_LEVEL;
  const packagingTrigger = { ...DEFAULT_PACKAGING_TRIGGER, ...config.packagingTrigger };
  const logFilePath = config.logFilePath ? path.resolve(config.logFilePath) : getDefaultLogFilePath();
  const calculateMd5 = config.calculateMd5 !== undefined ? config.calculateMd5 : true;

  // 2. 准备队列配置
  const queueConfig: QueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    ...config.queue
  };
  
  // 3. 准备稳定性配置
  const stabilityConfig: StabilityConfig = {
    ...DEFAULT_STABILITY_CONFIG,
    ...config.stability
  };
  
  // 4. 初始化日志
  await fs.ensureDir(path.dirname(logFilePath));
  await logToFile(logFilePath, `--- ScanAndTransport Start ---`);
  await logToFile(logFilePath, `任务ID: ${taskId}, 扫描ID: ${scanId}`);
  await logToFile(logFilePath, `开始时间: ${startTime.toISOString()}`);
  await logToFile(logFilePath, `配置: ${JSON.stringify({
    rootDir: config.rootDir,
    rulesCount: config.rules.length,
    outputDir,
    resultsDir,
    skipDirs,
    depth,
    maxFileSize,
    scanNestedArchives,
    calculateMd5
  })}`);

  // 5. 初始化文件处理队列
  const queue = new FileProcessingQueue(queueConfig, stabilityConfig);
  await logToFile(logFilePath, `队列系统初始化完成`);
  
  // 6. 收集结果和失败项
  const matchedFiles: FileItem[] = [];
  const processedFiles: FileItem[] = [];
  const failedItems: FailureItem[] = [];
  const packagePaths: string[] = [];
  const transportResults: {
    success: boolean;
    filePath: string;
    remotePath: string;
    error?: string;
  }[] = [];
  
  // 用于存储最终结果的对象
  const result: ScanAndTransportResult = {
    success: false,
    processedFiles: [],
    failedItems: [],
    packagePaths: [],
    transportSummary: [],
    logFilePath,
    taskId,
    scanId,
    resultFilePath: getResultFilePath(resultsDir, taskId, scanId),
    startTime,
    endTime: new Date(), // 临时值，将在处理完成后更新
    elapsedTimeMs: 0 // 临时值，将在处理完成后更新
  };
  
  try {
    // 7. 构建扫描选项
    const scanOptions: ScanOptions = {
      rootDir: path.resolve(config.rootDir),
      matchRules: config.rules,
      depth,
      maxFileSize,
      skipDirs: skipDirs.map(dir => path.resolve(config.rootDir, dir)),
      scanNestedArchives,
      maxNestedLevel,
      taskId,
      onProgress: (progress) => {
        // 更新进度信息
        if (config.onProgress) {
          config.onProgress(progress);
        }
      },
      onFileMatched: (file, progress) => {
        // 当文件匹配时，添加到队列管理系统
        matchedFiles.push(file);
        queue.addToMatchedQueue(file);
        
        // 如果有外部进度回调，调用它
        if (config.onProgress) {
          config.onProgress(progress, file);
        }
      },
      onFailure: (failure, progress) => {
        // 记录扫描失败项
        failedItems.push(failure);
        
        // 记录到日志
        logToFile(logFilePath, `扫描失败: ${failure.path}, 类型: ${failure.type}, 错误: ${failure.error}`);
        
        // 如果有外部进度回调，调用它
        if (config.onProgress) {
          config.onProgress(progress);
        }
      }
    };
    
    await logToFile(logFilePath, `开始扫描文件...`);
    
    // 8. 执行扫描
    const scanResult = await scanFiles(scanOptions);
    
    await logToFile(logFilePath, `扫描完成，找到 ${scanResult.matchedFiles.length} 个匹配文件`);
    await logToFile(logFilePath, `处理扫描队列...`);
    
    // 9. 处理匹配队列，将文件分配到合适的队列
    queue.processMatchedQueue();
    
    // 10. 处理文件稳定性队列
    await logToFile(logFilePath, `开始处理文件稳定性队列...`);
    await processFileStabilityQueue();
    await logToFile(logFilePath, `文件稳定性队列处理完成`);
    
    // 11. 处理压缩文件稳定性检测队列
    await logToFile(logFilePath, `开始处理压缩文件稳定性队列...`);
    await processArchiveStabilityQueue();
    await logToFile(logFilePath, `压缩文件稳定性队列处理完成`);
    
    // 12. 处理MD5计算队列
    await logToFile(logFilePath, `开始处理MD5计算队列...`);
    await processMd5Queue();
    await logToFile(logFilePath, `MD5计算队列处理初步完成`);

    // 获取打包队列长度
    const packagingQueueLength = queue.getFilesInQueue('packaging').length;
    await logToFile(logFilePath, `准备处理打包队列，初始队列长度: ${packagingQueueLength}`);
    
    // 13. 处理打包队列
    await processPackagingQueue();
    await logToFile(logFilePath, `打包队列处理完成 (函数已返回)`);
    
    // 14. 处理传输队列
    await logToFile(logFilePath, `开始处理传输队列...`);
    await processTransportQueue();
    await logToFile(logFilePath, `传输队列处理完成`);
    
    // 15. 处理重试队列中的文件
    await logToFile(logFilePath, `开始处理重试队列...`);
    await processRetryQueue();
    await logToFile(logFilePath, `重试队列处理完成`);
    
    // 16. 收集最终结果
    processedFiles.push(...queue.getCompletedFiles());
    failedItems.push(...queue.getFailedFiles().map(file => {
      return {
        type: 'stability' as const,
        path: file.path,
        error: `文件处理失败`
      } as FailureItem;
    }));
    
    // 设置成功标志（如果有失败项，则为false）
    result.success = failedItems.length === 0;
    
  } catch (error: any) {
    // 处理顶层错误
    const failureItem: FailureItem = {
      type: 'scanError',
      path: config.rootDir,
      error: error.message || String(error)
    };
    failedItems.push(failureItem);
    result.success = false;
    
    await logToFile(logFilePath, `错误: ${error.message || String(error)}`);
    console.error('Error during scanAndTransport:', error);
  } finally {
    // 记录结束时间
    const endTime = new Date();
    const elapsedTimeMs = endTime.getTime() - startTime.getTime();
    
    // 更新结果对象
    result.processedFiles = processedFiles;
    result.failedItems = failedItems;
    result.packagePaths = packagePaths;
    result.transportSummary = transportResults;
    result.endTime = endTime;
    result.elapsedTimeMs = elapsedTimeMs;
    
    // 记录结束信息到日志
    await logToFile(logFilePath, `--- ScanAndTransport End ---`);
    await logToFile(logFilePath, `结束时间: ${endTime.toISOString()}`);
    await logToFile(logFilePath, `耗时: ${elapsedTimeMs}ms`);
    await logToFile(logFilePath, `成功: ${result.success}`);
    await logToFile(logFilePath, `处理文件数: ${processedFiles.length}`);
    await logToFile(logFilePath, `失败数: ${failedItems.length}`);
    await logToFile(logFilePath, `包数量: ${packagePaths.length}`);
    
    try {
      // 保存结果到文件
      await saveResultToFile(result.resultFilePath, result);
      await logToFile(logFilePath, `结果已保存到: ${result.resultFilePath}`);

      // ---> 新增：上传结果文件 <--- 
      if (config.transport.enabled) {
        try {
          await logToFile(logFilePath, `准备上传结果文件: ${result.resultFilePath}`);
          const remoteResultDir = `${taskId}-${scanId}`;
          const remoteResultPath = path.join(remoteResultDir, path.basename(result.resultFilePath));
          
          // 构建完整的 TransportOptions 用于结果文件上传
          const resultTransportOptions: TransportOptions = {
            enabled: true,
            protocol: config.transport.protocol,
            host: config.transport.host,
            port: config.transport.port,
            username: config.transport.username,
            password: config.transport.password,
            remotePath: config.transport.remotePath, // 使用基础远程路径
            packageSize: 1, // 单文件
            retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
            timeout: DEFAULT_TRANSPORT_TIMEOUT,
            debug: false
          };
          
          // 上传结果文件
          const resultTransportResult = await transferFile(
            result.resultFilePath,
            remoteResultPath,
            resultTransportOptions
          );

          if (resultTransportResult.success) {
            await logToFile(logFilePath, `结果文件上传成功: ${resultTransportResult.remotePath}`);
          } else {
            await logToFile(logFilePath, `结果文件上传失败: ${resultTransportResult.error}`);
            console.error(`结果文件上传失败: ${resultTransportResult.error}`);
          }
        } catch (resultUploadError: any) {
          const errorMsg = `上传结果文件时发生异常: ${resultUploadError.message}`;
          await logToFile(logFilePath, errorMsg);
          console.error(errorMsg);
        }
      }
      // ---> 结束新增 <--- 

    } catch (error: any) {
      await logToFile(logFilePath, `保存结果失败: ${error.message}`);
      console.error('Error saving result file:', error);
    }

    // ---> 上传日志文件 <--- 
    if (config.transport.enabled) {
      try {
        await logToFile(logFilePath, `准备上传日志文件: ${logFilePath}`);
        const remoteLogDir = `${taskId}-${scanId}`;
        const remoteLogPath = path.join(remoteLogDir, path.basename(logFilePath));
        
        // 构建完整的 TransportOptions 用于日志上传
        const logTransportOptions: TransportOptions = {
          enabled: true, // 显式启用
          protocol: config.transport.protocol,
          host: config.transport.host,
          port: config.transport.port,
          username: config.transport.username,
          password: config.transport.password,
          remotePath: config.transport.remotePath, // 使用配置的基础远程路径
          packageSize: 1, // 对于单个文件不重要，设为1
          retryCount: DEFAULT_TRANSPORT_RETRY_COUNT, // 使用默认值
          timeout: DEFAULT_TRANSPORT_TIMEOUT, // 使用默认值
          debug: false // 设置默认值
        };
        
        // 使用构造好的选项上传日志文件
        const logTransportResult = await transferFile(
          logFilePath,
          remoteLogPath,
          logTransportOptions
        );

        if (logTransportResult.success) {
          await logToFile(logFilePath, `日志文件上传成功: ${logTransportResult.remotePath}`);
        } else {
          await logToFile(logFilePath, `日志文件上传失败: ${logTransportResult.error}`);
          // 可以选择将此失败添加到 failedItems，但这发生在 finally 块中，可能不会反映在最终结果对象中
          console.error(`日志文件上传失败: ${logTransportResult.error}`);
        }
      } catch (logUploadError: any) {
        const errorMsg = `上传日志文件时发生异常: ${logUploadError.message}`;
        await logToFile(logFilePath, errorMsg);
        console.error(errorMsg);
      }
    }
    // ---> 结束上传日志文件 <--- 

  }
  
  return result;
  
  // --- 辅助函数 ---
  
  /**
   * 处理文件稳定性检测队列
   */
  async function processFileStabilityQueue(): Promise<void> {
    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        await logToFile(logFilePath, `处理文件稳定性检测: ${files.length} 个文件`);
        
        // 实现文件稳定性检测逻辑
        for (const file of files) {
          try {
            await logToFile(logFilePath, `检测文件稳定性: ${file.path}`);
            
            // 使用core/stability.ts中的稳定性检测函数
            const stabilityOptions = {
              enabled: true,
              maxRetries: stabilityConfig?.file?.maxRetries || 3,
              retryInterval: stabilityConfig?.file?.checkInterval || 500,
              checkInterval: stabilityConfig?.file?.checkInterval || 500,
              largeFileThreshold: stabilityConfig?.file?.largeFileThreshold || 100 * 1024 * 1024,
              skipReadForLargeFiles: stabilityConfig?.file?.skipReadForLargeFiles || true
            };
            
            // 等待文件稳定
            const isStable = await waitForFileStability(file.path, stabilityOptions);
            
            if (isStable) {
              // 文件稳定，获取文件的最新信息
              const stats = await fs.stat(file.path);
              
              // 更新文件信息
              file.size = stats.size;
              if (!file.metadata) file.metadata = {};
              file.metadata.mtime = stats.mtime.toISOString();
              
              // 将文件标记为已完成处理并添加到MD5队列
              queue.markAsCompleted(file.path);
              queue.addToQueue('md5', file);
              processedFiles.push(file);
              await logToFile(logFilePath, `文件稳定性检测完成: ${file.path} (大小: ${stats.size} 字节)`);
            } else {
              // 文件不稳定，加入重试队列
              queue.addToRetryQueue(file, 'fileStability');
              await logToFile(logFilePath, `文件稳定性检测失败，加入重试队列: ${file.path}`);
            }
          } catch (error: any) {
            // 处理文件稳定性检测失败
            await logToFile(logFilePath, `文件稳定性检测失败: ${file.path}, 错误: ${error.message}`);
            failedItems.push({
              type: 'stability' as const,
              path: file.path,
              error: `文件稳定性检测失败: ${error.message}`
            });
            queue.markAsFailed(file.path);
          }
        }
        
        // ---> 新增：标记处理完成 <--- 
        files.forEach(file => {
          queue.getProcessingSet('fileStability')?.delete(file.path);
        });
        // ---> 结束新增 <--- 
        
        // 检查是否还有文件需要处理
        if (queue.getFilesInQueue('fileStability').length > 0 || 
            queue.getDetailedQueueStats().fileStability.processing > 0) {
          // 继续处理下一批
          queue.processNextBatch('fileStability', queueConfig.maxConcurrentFileChecks || 5, processor);
        } else {
          resolve();
        }
      };
      
      // 开始处理第一批
      queue.processNextBatch('fileStability', queueConfig.maxConcurrentFileChecks || 5, processor);
    });
  }
  
  /**
   * 处理压缩文件稳定性检测队列
   */
  async function processArchiveStabilityQueue(): Promise<void> {
    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        await logToFile(logFilePath, `处理压缩文件稳定性检测: ${files.length} 个文件`);
        
        for (const file of files) {
          try {
            await logToFile(logFilePath, `检测压缩文件稳定性: ${file.path}`);
            
            // 使用core/stability.ts中的稳定性检测函数
            const stabilityOptions = {
              enabled: true,
              maxRetries: stabilityConfig?.archive?.maxRetries || 3,
              retryInterval: stabilityConfig?.archive?.checkInterval || 500,
              checkInterval: stabilityConfig?.archive?.checkInterval || 500,
              largeFileThreshold: stabilityConfig?.archive?.largeFileThreshold || 100 * 1024 * 1024,
              skipReadForLargeFiles: stabilityConfig?.archive?.skipReadForLargeFiles || true
            };
            
            // 等待文件稳定
            const isStable = await waitForFileStability(file.path, stabilityOptions);
            
            if (isStable) {
              // 压缩文件稳定，获取文件的最新信息
              const stats = await fs.stat(file.path);
              
              // 更新文件信息
              file.size = stats.size;
              if (!file.metadata) file.metadata = {};
              file.metadata.mtime = stats.mtime.toISOString();
              
              // 检测压缩文件完整性并解压
              await logToFile(logFilePath, `解压压缩文件: ${file.path}`);
              
              // 为解压创建临时目录
              const tempOutputDir = path.join(
                os.tmpdir(),
                `scan-archive-extract-${taskId || Date.now()}`,
                path.basename(file.path, path.extname(file.path))
              );
              
              try {
                // 使用core/archive.ts中的函数提取压缩文件内容
                const extractResult = await extractArchiveContents(file.path, tempOutputDir, {
                  preservePermissions: false,
                  skipLargeFiles: stabilityConfig?.archive?.skipLargeFiles,
                  largeFileThreshold: stabilityConfig?.archive?.largeFileThreshold
                });
                
                // 更新文件元数据，添加提取的内容信息
                if (!file.metadata) file.metadata = {};
                file.metadata.extractedPath = tempOutputDir;
                file.metadata.extractedFiles = extractResult.extractedFiles;
                if (extractResult.skippedLargeFiles && extractResult.skippedLargeFiles.length > 0) {
                  file.metadata.skippedLargeFiles = extractResult.skippedLargeFiles;
                }
                
                // 将文件标记为已完成处理并添加到MD5队列
                queue.markAsCompleted(file.path);
                queue.addToQueue('md5', file);
                processedFiles.push(file);
                await logToFile(logFilePath, `压缩文件稳定性检测和提取完成: ${file.path} (大小: ${stats.size} 字节)`);
              } catch (error: any) {
                await logToFile(logFilePath, `压缩文件提取失败: ${file.path}, 错误: ${error.message}`);
                throw new Error(`压缩文件提取失败: ${error.message}`);
              }
            } else {
              // 文件不稳定，加入重试队列
              queue.addToRetryQueue(file, 'archiveStability');
              await logToFile(logFilePath, `压缩文件稳定性检测失败，加入重试队列: ${file.path}`);
            }
          } catch (error: any) {
            // 处理压缩文件稳定性检测失败
            await logToFile(logFilePath, `压缩文件稳定性检测失败: ${file.path}, 错误: ${error.message}`);
            failedItems.push({
              type: 'stability' as const,
              path: file.path,
              error: `压缩文件稳定性检测失败: ${error.message}`
            });
            queue.markAsFailed(file.path);
          }
        }
        
        // ---> 新增：标记处理完成 <--- 
        files.forEach(file => {
          queue.getProcessingSet('archiveStability')?.delete(file.path);
        });
        // ---> 结束新增 <--- 
        
        // 检查是否还有文件需要处理
        if (queue.getFilesInQueue('archiveStability').length > 0 || 
            queue.getDetailedQueueStats().archiveStability.processing > 0) {
          // 继续处理下一批
          queue.processNextBatch('archiveStability', queueConfig.maxConcurrentArchiveChecks || 2, processor);
        } else {
          resolve();
        }
      };
      
      // 开始处理第一批
      queue.processNextBatch('archiveStability', queueConfig.maxConcurrentArchiveChecks || 2, processor);
    });
  }
  
  /**
   * 处理MD5计算队列
   */
  async function processMd5Queue(): Promise<void> {
    // 添加调试日志
    const md5Files = queue.getFilesInQueue('md5');
    await logToFile(logFilePath, `MD5队列中文件数量: ${md5Files.length}`);
    if (md5Files.length > 0) {
      await logToFile(logFilePath, `MD5队列文件列表: ${md5Files.map(f => f.path).join(', ')}`);
    }

    if (!calculateMd5) {
      // 如果不需要计算MD5，则将文件直接添加到打包队列
      queue.getFilesInQueue('md5').forEach(file => {
        queue.addToQueue('packaging', file);
      });
      await logToFile(logFilePath, `MD5计算被禁用，直接添加到打包队列`);
      return Promise.resolve();
    }
    
    return new Promise<void>((resolve) => {
      try {
        const processor = async (files: FileItem[]) => {
          await logToFile(logFilePath, `计算MD5: ${files.length} 个文件`);
          
          // 单独处理每个文件
          for (const file of files) {
            try {
              // 计算MD5
              const updatedFile = await calculateFileMd5(file);
              
              // 将文件添加到打包队列
              queue.addToQueue('packaging', updatedFile);
              
              // 添加到处理过的文件列表
              processedFiles.push(updatedFile);
              
              await logToFile(logFilePath, `MD5计算完成: ${file.path}`);
            } catch (fileError: any) {
              // 处理单个文件MD5计算失败
              await logToFile(logFilePath, `MD5计算失败: ${file.path}, 错误: ${fileError.message}`);
              failedItems.push({
                type: 'md5',
                path: file.path,
                error: `MD5计算失败: ${fileError.message}`
              });
              queue.markAsFailed(file.path);
            }
          }

          // ---> 新增：标记处理完成 <--- 
          files.forEach(file => {
            queue.getProcessingSet('md5')?.delete(file.path);
          });
          // ---> 结束新增 <--- 
          
          // 检查是否还有文件需要处理
          if (queue.getFilesInQueue('md5').length > 0 || 
              queue.getDetailedQueueStats().md5.processing > 0) {
            // 继续处理下一批
            queue.processNextBatch('md5', queueConfig.maxConcurrentMd5 || 5, processor);
          } else {
            // 调试信息
            const packagingFiles = queue.getFilesInQueue('packaging');
            const message1 = `MD5处理完毕，打包队列中文件数量: ${packagingFiles.length}`;
            logToFile(logFilePath, message1)
              .then(() => {
                if (packagingFiles.length > 0) {
                  const message2 = `MD5处理完毕，打包队列文件列表: ${packagingFiles.map(f => f.path).join(', ')}`;
                  return logToFile(logFilePath, message2);
                }
                return Promise.resolve();
              })
              .then(() => resolve())
              .catch(() => resolve()); // 即使日志记录失败也继续执行
          }
        };
        
        // 开始处理第一批
        queue.processNextBatch('md5', queueConfig.maxConcurrentMd5 || 5, processor);
      } catch (error: any) {
        // 安全记录错误
        const errorMessage = `MD5队列处理时发生错误: ${error.message}`;
        logToFile(logFilePath, errorMessage)
          .then(() => {
            if (error.stack) {
              return logToFile(logFilePath, `错误堆栈: ${error.stack}`);
            }
            return Promise.resolve();
          })
          .then(() => resolve())
          .catch(() => resolve()); // 即使日志记录失败也继续执行
      }
    });
  }
  
  /**
   * 处理打包队列
   */
  async function processPackagingQueue(): Promise<void> {
    await logToFile(logFilePath, `启动打包队列处理逻辑`);

    // 状态变量：在 processor 调用之间保持
    let currentPackageFiles: FileItem[] = [];
    let currentPackageSize = 0;
    let packageIndex = 0;

    // 确保输出目录存在 (移到内部，确保执行)
    try {
      await fs.ensureDir(outputDir);
    } catch (dirError: any) {
      await logToFile(logFilePath, `创建输出目录 ${outputDir} 失败: ${dirError.message}`);
      // 如果目录创建失败，后续打包会失败，错误会在 createAndAddPackage 中处理
    }

    // 辅助函数：生成包路径 (保持不变)
    const packagePathPrefix = (index: number): string => {
      const packageName = packageNamePattern
        .replace('{index}', String(index))
        .replace('{taskId}', taskId);
      return path.join(outputDir, `${packageName}.zip`);
    };

    // 辅助函数：创建并添加包 (保持不变，但错误处理更细致)
    const createAndAddPackage = async (packageFiles: FileItem[], targetPath: string): Promise<void> => {
        const packageSize = packageFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        await logToFile(logFilePath, `创建打包: ${targetPath}, 包含 ${packageFiles.length} 个文件, 总大小: ${(packageSize / (1024 * 1024)).toFixed(2)}MB`);
        try {
          const packResult = await createBatchPackage(packageFiles, targetPath, {
            includeMd5: true,
            includeMetadata: true,
            onProgress: async (progress) => {
               await logToFile(logFilePath, `打包进度: ${targetPath}, 已处理 ${progress.processedFiles}/${progress.totalFiles} 文件 (${progress.percentage}%)`);
               if (progress.currentFile) {
                 await logToFile(logFilePath, `当前处理文件: ${progress.currentFile}, 进度: ${progress.currentFileProgress}%`);
               }
            },
            packageTags: [`task:${taskId}`, `scan:${scanId}`]
          });

          if (packResult.success) {
            packagePaths.push(targetPath);
            for (const packagedFile of packageFiles) {
              if (!packagedFile.metadata) packagedFile.metadata = {};
              packagedFile.metadata.packagePath = targetPath;
              // 注意：文件打包成功不代表整个流程完成，不在此处调用 markAsCompleted
            }
            // 创建代表包的 FileItem 并加入传输队列
            const packageStat = await fs.stat(targetPath);
            queue.addToQueue('transport', {
              path: targetPath,
              name: path.basename(targetPath),
              createTime: new Date(),
              modifyTime: new Date(),
              size: packageStat.size,
              origin: 'filesystem',
              metadata: {
                packagedFiles: packageFiles.map(f => f.path),
                fileCount: packageFiles.length,
                originalSize: packageSize
              }
            });
            await logToFile(logFilePath, `打包成功，包已加入传输队列: ${targetPath}`);
          } else {
            const errMsg = `打包失败: ${packResult.error?.message || '未知错误'}`;
            await logToFile(logFilePath, errMsg);
            for (const packagedFile of packageFiles) {
              if (!failedItems.some(fi => fi.path === packagedFile.path)) { // 避免重复记录失败
                 failedItems.push({ type: 'packaging', path: packagedFile.path, error: errMsg });
                 queue.markAsFailed(packagedFile.path); // 标记原始文件为失败
              }
            }
            // 抛出错误以便上层知道创建包失败
            throw new Error(errMsg);
          }
        } catch (error: any) {
           const errMsg = `打包过程发生异常: ${error.message}`;
           await logToFile(logFilePath, errMsg);
           for (const packagedFile of packageFiles) {
             if (!failedItems.some(fi => fi.path === packagedFile.path)) {
                failedItems.push({ type: 'packaging', path: packagedFile.path, error: errMsg });
                queue.markAsFailed(packagedFile.path);
             }
           }
           // 抛出错误
           throw new Error(errMsg);
        }
    };

    // --- 主处理逻辑 --- 
    return new Promise<void>((resolve) => {
      let checkInProgress = false; // 防止并发检查

      // 检查是否所有处理都完成，可以创建最终包并结束
      const checkCompletion = async () => {
        if (checkInProgress) {
          await logToFile(logFilePath, `完成状态检查已在进行中，跳过`);
          return;
        }
        checkInProgress = true;
        await logToFile(logFilePath, `开始检查打包完成状态...`);

        const stats = queue.getDetailedQueueStats();
        const packagingWaiting = queue.getFilesInQueue('packaging').length;
        const packagingProcessing = stats.packaging.processing;

        // 关键条件：上游队列完成 + 打包队列完成
        const upstreamDone = 
          stats.fileStability.waiting === 0 && stats.fileStability.processing === 0 &&
          stats.archiveStability.waiting === 0 && stats.archiveStability.processing === 0 &&
          stats.md5.waiting === 0 && stats.md5.processing === 0;
          
        const packagingDone = packagingWaiting === 0 && packagingProcessing === 0;

        await logToFile(logFilePath, `完成状态: 上游=${upstreamDone}, 打包=${packagingDone} (等待:${packagingWaiting}, 处理中:${packagingProcessing}), 剩余当前包=${currentPackageFiles.length}`);

        if (upstreamDone && packagingDone) {
          // 所有条件满足，处理最后一个包
          if (currentPackageFiles.length > 0) {
            await logToFile(logFilePath, `所有处理完成，创建最后一个包含 ${currentPackageFiles.length} 个文件的包`);
            const filesToPack = [...currentPackageFiles]; // 捕获当前状态
            const finalPackagePath = packagePathPrefix(packageIndex++);
            currentPackageFiles = []; // 重置状态
            currentPackageSize = 0;
            try {
                await createAndAddPackage(filesToPack, finalPackagePath);
            } catch(e: any) {
                 await logToFile(logFilePath, `创建最后一个包时出错: ${e.message}`);
                 // 错误已在 createAndAddPackage 中记录和标记
            }
          } else {
             await logToFile(logFilePath, `所有处理完成，没有剩余文件需要打包`);
          }
          await logToFile(logFilePath, `解析打包队列 Promise (完成)`);
          checkInProgress = false;
          resolve(); // **** 解析 Promise ****
        } else {
          // 打包或上游未完成，调度延迟检查
          logToFile(logFilePath, `[PackageQueue] Packaging or upstream tasks not complete, scheduling delayed check for ${currentPackageFiles.length} items after 1000ms.`);
          setTimeout(
            () => processPackagingQueue(),
            1000
          );
        }
      };

      // 处理从队列中取出的一批文件
      const processor = async (files: FileItem[]) => {
        await logToFile(logFilePath, `处理打包批次: ${files.length} 个文件`);

        for (const file of files) {
          currentPackageFiles.push(file);
          currentPackageSize += file.size || 0;
          await logToFile(logFilePath, `文件 ${file.name} 加入当前包 (现有 ${currentPackageFiles.length} 文件, ${currentPackageSize} B)`);

          const fileTrigger = currentPackageFiles.length >= packagingTrigger.maxFiles;
          const sizeTrigger = currentPackageSize >= packagingTrigger.maxSizeMB * 1024 * 1024;

          if (fileTrigger || sizeTrigger) {
             await logToFile(logFilePath, `打包触发器满足 (文件: ${fileTrigger}, 大小: ${sizeTrigger}), 创建包`);
            const filesToPack = [...currentPackageFiles]; // 捕获状态
            const packagePath = packagePathPrefix(packageIndex++);
            // 重置共享状态 *之前* await
            currentPackageFiles = [];
            currentPackageSize = 0;
            try {
              await createAndAddPackage(filesToPack, packagePath);
            } catch (e: any) {
                logToFile(logFilePath, `创建包 ${packagePath} 时捕获错误: ${e.message}`);
                // 错误已在 createAndAddPackage 中处理，此处仅记录
            }
          } else {
              logToFile(logFilePath, `文件 ${file.name} 加入后未触发打包`);
          }
        } // 结束 for 循环

        // 标记本批次文件处理完成 (从 processing 集合中移除)
        files.forEach(file => {
          queue.getProcessingSet('packaging')?.delete(file.path);
        });
        await logToFile(logFilePath, `批次 ${files.map(f=>f.name).join(',')} 标记为打包处理完成`);

        // 处理完一批后，检查是否需要处理下一批，或者是否应该检查完成状态
        const packagingWaiting = queue.getFilesInQueue('packaging').length;
        const packagingProcessing = queue.getDetailedQueueStats().packaging.processing; // 检查其他processor是否还在运行

        if (packagingWaiting > 0 || packagingProcessing > 0) {
            logToFile(logFilePath, `打包队列仍有 ${packagingWaiting} 等待 / ${packagingProcessing} 处理中，调度下一批次`);
            // 如果还有文件在等待队列或正在被其他 processor 处理，继续调度
            // 使用较小的批次大小以允许更频繁地检查触发器
            queue.processNextBatch('packaging', packagingTrigger.maxFiles || 10, processor);
        } else {
             logToFile(logFilePath, `打包队列已空或无处理中，开始检查最终完成状态`);
            // 如果没有文件在等待，并且没有其他 processor 在运行，开始检查是否可以完成
            checkCompletion();
        }
      }; // 结束 processor 函数

      // 初始触发器：开始处理第一批
      const initialBatchSize = packagingTrigger.maxFiles > 0 ? packagingTrigger.maxFiles : 10; // 初始批次大小
      logToFile(logFilePath, `首次触发打包处理器，批次大小: ${initialBatchSize}`);
      queue.processNextBatch('packaging', initialBatchSize, processor);

      // 处理初始队列为空的情况：仍然需要启动检查完成状态的循环
      const initialFiles = queue.getFilesInQueue('packaging');
      const initialProcessing = queue.getDetailedQueueStats().packaging.processing;
      if(initialFiles.length === 0 && initialProcessing === 0) {
          logToFile(logFilePath, `打包队列初始为空且无处理中，直接启动完成状态检查`);
          checkCompletion();
      }

    }); // 结束 Promise
  }
  
  /**
   * 处理传输队列
   */
  async function processTransportQueue(): Promise<void> {
    // 如果不需要传输，则标记所有文件为已完成
    if (!config.transport.enabled) {
      queue.getFilesInQueue('transport').forEach(file => {
        queue.markAsCompleted(file.path);
      });
      await logToFile(logFilePath, `传输功能已禁用，跳过传输`);
      return Promise.resolve();
    }
    
    // 构建子目录名称
    const remoteSubDir = `${taskId}-${scanId}`;
    await logToFile(logFilePath, `将文件上传到远程目录: ${remoteSubDir}`);
    
    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        await logToFile(logFilePath, `处理传输: ${files.length} 个包文件`);
        
        for (const file of files) {
          try {
            await logToFile(logFilePath, `开始传输文件: ${file.path}`);
            
            // 构建远程文件路径（放在任务id-扫描id子目录下）
            const remotePath = path.join(remoteSubDir, path.basename(file.path));
            
            // 使用transferFile函数进行文件传输
            const transportResult = await transferFile(
              file.path,
              remotePath,
              {
                ...config.transport,
                packageSize: packagingTrigger.maxFiles,
                retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
                timeout: DEFAULT_TRANSPORT_TIMEOUT
              }
            );
            
            // 添加传输结果
            transportResults.push({
              success: transportResult.success,
              filePath: transportResult.filePath,
              remotePath: transportResult.remotePath,
              error: transportResult.error
            });
            
            // 根据传输结果处理文件状态
            if (transportResult.success) {
              // 标记文件为已完成
              queue.markAsCompleted(file.path);
              
              await logToFile(logFilePath, `传输成功: ${file.path} -> ${transportResult.remotePath}`);
            } else {
              // 处理传输失败
              await logToFile(logFilePath, `传输失败: ${file.path}, 错误: ${transportResult.error}`);
              failedItems.push({
                type: 'transport',
                path: file.path,
                error: `传输失败: ${transportResult.error}`
              });
              
              // 检查是否应该重试
              if (DEFAULT_TRANSPORT_RETRY_COUNT > 0) {
                queue.addToRetryQueue(file, 'transport');
                await logToFile(logFilePath, `将文件添加到传输重试队列: ${file.path}`);
              } else {
                queue.markAsFailed(file.path);
              }
            }
          } catch (error: any) {
            // 处理调用transferFile函数时可能发生的异常
            const errorMessage = error.message || '未知错误';
            
            // 记录失败结果
            transportResults.push({
              success: false,
              filePath: file.path,
              remotePath: path.join(config.transport.remotePath || '/upload', remoteSubDir, path.basename(file.path)),
              error: errorMessage
            });
            
            await logToFile(logFilePath, `传输过程发生异常: ${file.path}, 错误: ${errorMessage}`);
            failedItems.push({
              type: 'transport',
              path: file.path,
              error: `传输异常: ${errorMessage}`
            });
            
            queue.markAsFailed(file.path);
          }
        }
        
        // ---> 新增：标记处理完成 <--- 
        files.forEach(file => {
          queue.getProcessingSet('transport')?.delete(file.path);
        });
        // ---> 结束新增 <--- 
        
        // 检查是否还有文件需要处理
        if (queue.getFilesInQueue('transport').length > 0 || 
            queue.getDetailedQueueStats().transport.processing > 0) {
          // 继续处理下一批
          queue.processNextBatch('transport', queueConfig.maxConcurrentTransfers || 2, processor);
        } else {
          resolve();
        }
      };
      
      // 开始处理第一批
      queue.processNextBatch('transport', queueConfig.maxConcurrentTransfers || 2, processor);
    });
  }
  
  /**
   * 处理重试队列
   */
  async function processRetryQueue(): Promise<void> {
    return new Promise(resolve => {
      const processor = (files: FileItem[], targetQueue: string) => {
        // 将文件添加回原来的队列
        files.forEach(file => {
          queue.addToQueue(targetQueue as any, file);
        });
      };
      
      // 处理重试队列
      queue.processRetryQueue(processor);
      
      // 检查是否需要继续处理
      if (queue.getQueueStats().retrying > 0) {
        // 等待一段时间后再次处理
        setTimeout(() => {
          processRetryQueue().then(resolve);
        }, queueConfig.stabilityRetryDelay || 2000);
      } else {
        resolve();
      }
    });
  }
} 