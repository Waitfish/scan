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
// 导入core模块下的关键功能
import { waitForFileStability } from './core/stability';
import { calculateFileMd5 } from './core/md5';
import { extractArchiveContents } from './core/archive';
import { transferFile } from './core/transport';
// 导入去重器
import { createDeduplicator } from './core/deduplication';
import { DeduplicatorOptions, DeduplicationType } from './types/deduplication';
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
const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const DEFAULT_SKIP_DIRS: string[] = [];
const DEFAULT_DEPTH = -1;
const DEFAULT_SCAN_NESTED_ARCHIVES = true;
const DEFAULT_MAX_NESTED_LEVEL = 10;
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
  maxConcurrentFileChecks: 100,
  maxConcurrentArchiveChecks: 50,
  maxConcurrentMd5: 5,
  maxConcurrentTransfers: 2,
  stabilityRetryDelay: 2000
};
const DEFAULT_TRANSPORT_RETRY_COUNT = 3;
const DEFAULT_TRANSPORT_TIMEOUT = 60000; // 60 秒
// 默认去重选项
const DEFAULT_DEDUPLICATOR_OPTIONS: DeduplicatorOptions = {
  enabled: true,
  useHistoricalDeduplication: true,
  useTaskDeduplication: true,
  historyFilePath: path.join(process.cwd(), 'historical-uploads.json'),
  autoSaveInterval: 5 * 60 * 1000 // 5分钟
};

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
  
  // 添加各阶段耗时记录
  const stageTimings: Record<string, number> = {
    initialization: 0,
    scanning: 0,
    fileStabilityCheck: 0,
    archiveStabilityCheck: 0,
    md5Calculation: 0,
    packaging: 0,
    transport: 0,
    finalization: 0
  };
  
  // 添加计时辅助函数
  const timeStage = async (
    stageName: string, 
    callback: () => Promise<void>
  ): Promise<void> => {
    const stageStart = Date.now();
    await callback();
    stageTimings[stageName] = Date.now() - stageStart;
  };
  
  // 1. 合并配置与默认值
  const initStart = Date.now();
  
  const taskId = config.taskId || crypto.randomUUID(); // 使用提供的任务ID或生成新的
  const scanId = `scan_${startTime.getTime()}`; // 基于时间戳创建扫描ID
  
  // 将 rootDirs 转换为绝对路径数组 (使用正确的 config.rootDirs)
  const rootDirs = config.rootDirs.map((dir: string) => path.resolve(dir)); // 添加 dir 类型注解
  if (rootDirs.length === 0) {
    throw new Error('rootDirs cannot be empty.');
  }
  
  const outputDir = path.resolve(config.outputDir ?? DEFAULT_OUTPUT_DIR);
  const resultsDir = path.resolve(config.resultsDir ?? DEFAULT_RESULTS_DIR);
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  // skipDirs 处理: 解析为绝对路径
  const skipDirsList = (config.skipDirs ?? DEFAULT_SKIP_DIRS).map(dir => path.resolve(dir));
  const depth = config.depth ?? DEFAULT_DEPTH;
  const scanNestedArchives = config.scanNestedArchives ?? DEFAULT_SCAN_NESTED_ARCHIVES;
  const maxNestedLevel = config.maxNestedLevel ?? DEFAULT_MAX_NESTED_LEVEL;
  const packagingTrigger = { ...DEFAULT_PACKAGING_TRIGGER, ...config.packagingTrigger };
  const logFilePath = config.logFilePath ? path.resolve(config.logFilePath) : getDefaultLogFilePath();
  const calculateMd5 = config.calculateMd5 !== undefined ? config.calculateMd5 : true;
  // 处理去重配置
  const deduplicatorOptions: DeduplicatorOptions = {
    ...DEFAULT_DEDUPLICATOR_OPTIONS,
    ...config.deduplicatorOptions
  };

  // 2. 准备队列配置
  const queueConfig: QueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    ...config.queue,
    // 确保打包并发数与打包触发器的maxFiles配置保持一致
    maxConcurrentPackaging: config.packagingTrigger?.maxFiles || DEFAULT_PACKAGING_TRIGGER.maxFiles
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
    rootDirs: rootDirs, // 使用处理后的 rootDirs
    rulesCount: config.rules.length,
    outputDir,
    resultsDir,
    skipDirs: skipDirsList, // 使用处理后的 skipDirs
    depth,
    maxFileSize,
    scanNestedArchives,
    calculateMd5
  })}`);

  // 5. 初始化共享的文件处理队列和去重器 (在循环外)
  const queue = new FileProcessingQueue(queueConfig, stabilityConfig);
  await logToFile(logFilePath, `队列系统初始化完成`);
  
  const deduplicator = createDeduplicator(deduplicatorOptions);
  await deduplicator.initialize();
  await logToFile(logFilePath, `去重系统初始化完成，历史记录数量: ${deduplicator.getHistoricalMd5Set().size}`);
  
  // 6. 初始化共享的结果和失败项收集器 (在循环外)
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
  const skippedHistoricalDuplicates: FileItem[] = [];
  const skippedTaskDuplicates: FileItem[] = [];
  
  // 用于存储最终结果的对象 (在循环外)
  const result: ScanAndTransportResult = {
    success: false,
    processedFiles: [],
    failedItems: [],
    packagePaths: [],
    transportSummary: [],
    skippedHistoricalDuplicates: [],
    skippedTaskDuplicates: [],
    logFilePath,
    taskId,
    scanId,
    resultFilePath: getResultFilePath(resultsDir, taskId, scanId),
    startTime,
    endTime: new Date(), // 临时值
    elapsedTimeMs: 0 // 临时值
  };
  
  // 更新初始化阶段耗时
  stageTimings.initialization = Date.now() - initStart;
  await logToFile(logFilePath, `初始化阶段耗时: ${stageTimings.initialization}ms`);
  
  let totalMatchedFiles = 0; // 用于跟踪所有根目录的总匹配文件数

  try {
    // 7. 循环处理每个根目录 - 计时扫描阶段
    const scanStart = Date.now();
    
    // 7. 循环处理每个根目录
    for (const currentRootDir of rootDirs) {
      await logToFile(logFilePath, `开始扫描根目录: ${currentRootDir}`);
      
      // 7.1 构建当前根目录的扫描选项
      const scanOptions: ScanOptions = {
        rootDir: currentRootDir, // 使用当前循环的根目录
        matchRules: config.rules,
        depth,
        maxFileSize,
        skipDirs: skipDirsList, // 使用处理好的绝对路径列表
        scanNestedArchives,
        maxNestedLevel,
        taskId,
        onProgress: (progress) => {
          // 更新进度信息 - 注意这里的进度是相对于当前根目录的
          // 如果需要总进度，需要在此处进行聚合
          if (config.onProgress) {
            // 可以考虑传递一个包含当前 rootDir 的扩展进度对象
            config.onProgress(progress);
          }
        },
        onFileMatched: (file, progress) => {
          // 当文件匹配时，添加到 *共享* 的队列管理系统
          matchedFiles.push(file); // matchedFiles 列表现在聚合所有根目录的结果
          queue.addToMatchedQueue(file);
          
          // 如果有外部进度回调，调用它
          if (config.onProgress) {
            config.onProgress(progress, file);
          }
        },
        onFailure: (failure, progress) => {
          // 记录扫描失败项到 *共享* 的列表
          failedItems.push(failure);
          
          // 记录到日志
          logToFile(logFilePath, `扫描失败: ${failure.path}, 类型: ${failure.type}, 错误: ${failure.error}`);
          
          // 如果有外部进度回调，调用它
          if (config.onProgress) {
            config.onProgress(progress);
          }
        }
      };
      
      // 7.2 执行当前根目录的扫描
      const scanResult = await scanFiles(scanOptions);
      await logToFile(logFilePath, `根目录扫描完成: ${currentRootDir}，找到 ${scanResult.matchedFiles.length} 个匹配文件`);
      totalMatchedFiles += scanResult.matchedFiles.length;
    } // 结束 rootDirs 循环
    
    await logToFile(logFilePath, `所有根目录扫描完成，共找到 ${totalMatchedFiles} 个匹配文件`);
    await logToFile(logFilePath, `处理扫描队列...`);
    
    // 更新扫描阶段耗时
    stageTimings.scanning = Date.now() - scanStart;
    await logToFile(logFilePath, `扫描阶段耗时: ${stageTimings.scanning}ms`);
    
    // 9. 处理匹配队列 (现在包含所有根目录的文件)
    queue.processMatchedQueue();
    
    // 10. 处理文件稳定性队列 - 计时文件稳定性检查阶段
    await logToFile(logFilePath, `开始处理文件稳定性队列...`);
    await timeStage('fileStabilityCheck', async () => {
      await processFileStabilityQueue();
    });
    await logToFile(logFilePath, `文件稳定性队列处理完成，耗时: ${stageTimings.fileStabilityCheck}ms`);
    
    // 11. 处理压缩文件稳定性检测队列 - 计时压缩文件稳定性检查阶段
    await logToFile(logFilePath, `开始处理压缩文件稳定性队列...`);
    await timeStage('archiveStabilityCheck', async () => {
      await processArchiveStabilityQueue();
    });
    await logToFile(logFilePath, `压缩文件稳定性队列处理完成，耗时: ${stageTimings.archiveStabilityCheck}ms`);
    
    // 12. 处理MD5计算队列 - 计时MD5计算阶段
    await logToFile(logFilePath, `开始处理MD5计算队列...`);
    await timeStage('md5Calculation', async () => {
      await processMd5Queue();
    });
    await logToFile(logFilePath, `MD5计算队列处理完成，耗时: ${stageTimings.md5Calculation}ms`);

    // 获取打包队列长度
    const packagingQueueLength = queue.getFilesInQueue('packaging').length;
    await logToFile(logFilePath, `准备处理打包队列，初始队列长度: ${packagingQueueLength}`);
    
    // 13. 处理打包队列 - 计时打包阶段
    await timeStage('packaging', async () => {
      await processPackagingQueue();
    });
    await logToFile(logFilePath, `打包队列处理完成，耗时: ${stageTimings.packaging}ms`);
    
    // 14. 处理传输队列 - 计时传输阶段
    await logToFile(logFilePath, `开始处理传输队列...`);
    await timeStage('transport', async () => {
      await processTransportQueue();
    });
    await logToFile(logFilePath, `传输队列处理完成，耗时: ${stageTimings.transport}ms`);
    
    // 15. 处理重试队列中的文件
    await logToFile(logFilePath, `开始处理重试队列...`);
    await processRetryQueue();
    await logToFile(logFilePath, `重试队列处理完成`);
    
    // 16. 收集最终结果 (从共享的队列和去重器收集)
    processedFiles.push(...queue.getCompletedFiles());
    failedItems.push(...queue.getFailedFiles().map(file => {
      return {
        type: 'stability' as const,
        path: file.path,
        error: `文件处理失败`
      } as FailureItem;
    }));
    
    // 直接从deduplicator获取去重的文件列表，不再将其追加到已有列表
    // skippedHistoricalDuplicates在处理MD5时已经添加过了
    // 这里使用Set进行去重，确保每个文件只出现一次
    const histFilePaths = new Set<string>();
    const uniqueHistoricalDuplicates: FileItem[] = [];
    
    // 先处理已有的文件
    skippedHistoricalDuplicates.forEach(file => {
      if (file.path && !histFilePaths.has(file.path)) {
        histFilePaths.add(file.path);
        uniqueHistoricalDuplicates.push(file);
      }
    });
    
    // 再处理从deduplicator获取的文件
    deduplicator.getSkippedHistoricalDuplicates().forEach(file => {
      if (file.path && !histFilePaths.has(file.path)) {
        histFilePaths.add(file.path);
        uniqueHistoricalDuplicates.push(file);
      }
    });
    
    // 清空原列表并添加去重后的文件
    skippedHistoricalDuplicates.length = 0;
    skippedHistoricalDuplicates.push(...uniqueHistoricalDuplicates);
    
    // 对任务内重复文件也进行同样处理
    const taskFilePaths = new Set<string>();
    const uniqueTaskDuplicates: FileItem[] = [];
    
    skippedTaskDuplicates.forEach(file => {
      if (file.path && !taskFilePaths.has(file.path)) {
        taskFilePaths.add(file.path);
        uniqueTaskDuplicates.push(file);
      }
    });
    
    deduplicator.getSkippedTaskDuplicates().forEach(file => {
      if (file.path && !taskFilePaths.has(file.path)) {
        taskFilePaths.add(file.path);
        uniqueTaskDuplicates.push(file);
      }
    });
    
    // 清空原列表并添加去重后的文件
    skippedTaskDuplicates.length = 0;
    skippedTaskDuplicates.push(...uniqueTaskDuplicates);
    
    // 设置成功标志（如果有失败项，则为false）
    result.success = failedItems.length === 0;
    
  } catch (error: any) {
    // 处理顶层错误 (使用 rootDirs[0])
    const failureItem: FailureItem = {
      type: 'scanError',
      path: rootDirs[0] || 'N/A', 
      error: error.message || String(error)
    };
    failedItems.push(failureItem);
    result.success = false;
    
    await logToFile(logFilePath, `错误: ${error.message || String(error)}`);
    console.error('Error during scanAndTransport:', error);
  } finally {
    // 记录结束时间 - 计时收尾阶段
    const finalizationStart = Date.now();
    
    // 记录结束时间
    const endTime = new Date();
    const elapsedTimeMs = endTime.getTime() - startTime.getTime();
    
    // 更新结果对象
    result.processedFiles = processedFiles;
    result.failedItems = failedItems;
    result.packagePaths = packagePaths;
    result.transportSummary = transportResults;
    result.skippedHistoricalDuplicates = skippedHistoricalDuplicates;
    result.skippedTaskDuplicates = skippedTaskDuplicates;
    result.endTime = endTime;
    result.elapsedTimeMs = elapsedTimeMs;
    
    // 添加阶段耗时到结果对象 (扩展ScanAndTransportResult类型)
    (result as any).stageTimings = stageTimings;
    
    // 记录结束信息到日志
    await logToFile(logFilePath, `--- ScanAndTransport End ---`);
    await logToFile(logFilePath, `结束时间: ${endTime.toISOString()}`);
    await logToFile(logFilePath, `耗时: ${elapsedTimeMs}ms`);
    await logToFile(logFilePath, `成功: ${result.success}`);
    await logToFile(logFilePath, `处理文件数: ${processedFiles.length}`);
    await logToFile(logFilePath, `失败数: ${failedItems.length}`);
    await logToFile(logFilePath, `包数量: ${packagePaths.length}`);
    await logToFile(logFilePath, `历史去重跳过文件数: ${skippedHistoricalDuplicates.length}`);
    await logToFile(logFilePath, `任务内去重跳过文件数: ${skippedTaskDuplicates.length}`);
    
    // 添加各阶段耗时统计信息到日志
    stageTimings.finalization = Date.now() - finalizationStart;
    await logToFile(logFilePath, `\n--- 各阶段耗时统计 ---`);
    await logToFile(logFilePath, `初始化阶段: ${stageTimings.initialization}ms (${(stageTimings.initialization / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `扫描阶段: ${stageTimings.scanning}ms (${(stageTimings.scanning / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `文件稳定性检查阶段: ${stageTimings.fileStabilityCheck}ms (${(stageTimings.fileStabilityCheck / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `压缩文件稳定性检查阶段: ${stageTimings.archiveStabilityCheck}ms (${(stageTimings.archiveStabilityCheck / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `MD5计算阶段: ${stageTimings.md5Calculation}ms (${(stageTimings.md5Calculation / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `打包阶段: ${stageTimings.packaging}ms (${(stageTimings.packaging / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `传输阶段: ${stageTimings.transport}ms (${(stageTimings.transport / elapsedTimeMs * 100).toFixed(2)}%)`);
    await logToFile(logFilePath, `收尾阶段: ${stageTimings.finalization}ms (${(stageTimings.finalization / elapsedTimeMs * 100).toFixed(2)}%)`);
    
    // 可视化百分比 (简单的文本条形图)
    await logToFile(logFilePath, `\n--- 阶段耗时百分比可视化 ---`);
    for (const [stage, time] of Object.entries(stageTimings)) {
      const percent = (time / elapsedTimeMs * 100).toFixed(2);
      const barLength = Math.max(1, Math.round(Number(percent) / 2)); // 每2%显示一个字符
      const bar = '#'.repeat(barLength);
      await logToFile(logFilePath, `${stage.padEnd(25)}: ${bar.padEnd(50)} ${percent}%`);
    }
    
    // 保存去重历史记录
    try {
      if (deduplicatorOptions.enabled) {
        await deduplicator.saveHistoricalMd5();
        await logToFile(logFilePath, `去重历史记录已保存`);
      }
    } catch (dedupError: any) {
      await logToFile(logFilePath, `保存去重历史记录失败: ${dedupError.message}`);
    }

    // 销毁去重器
    deduplicator.dispose();
    
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
    const queueFiles = queue.getFilesInQueue('archiveStability');
    
    // 记录队列状态
    await logToFile(logFilePath, `压缩文件稳定性队列状态: 共 ${queueFiles.length} 个文件等待处理`);
    
    // 如果队列中有文件，记录它们的路径
    if (queueFiles.length > 0) {
      await logToFile(logFilePath, `压缩文件队列文件列表: ${queueFiles.map(f => f.path).join(', ')}`);
    } else {
      // 队列为空时，直接返回已完成的Promise
      await logToFile(logFilePath, `压缩文件稳定性队列为空，无需解压处理`);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const processor = async (files: FileItem[]) => {
        // 如果没有文件要处理，则直接完成
        if (files.length === 0) {
          await logToFile(logFilePath, `没有压缩文件需要处理，跳过解压步骤`);
          resolve();
          return;
        }
        
        await logToFile(logFilePath, `处理压缩文件稳定性: ${files.length} 个文件`);
        
        for (const file of files) {
          try {
            await logToFile(logFilePath, `检测压缩文件稳定性: ${file.path}`);
            await logToFile(logFilePath, `压缩文件信息: 大小=${file.size || '未知'} 字节, 修改时间=${file.modifyTime?.toISOString() || '未知'}`);
            
            // 使用core/stability.ts中的稳定性检测函数
            const stabilityOptions = {
              enabled: true,
              maxRetries: stabilityConfig?.archive?.maxRetries || 3,
              retryInterval: stabilityConfig?.archive?.checkInterval || 500,
              checkInterval: stabilityConfig?.archive?.checkInterval || 500,
              largeFileThreshold: stabilityConfig?.archive?.largeFileThreshold || 100 * 1024 * 1024,
              skipReadForLargeFiles: stabilityConfig?.archive?.skipReadForLargeFiles || true
            };
            
            await logToFile(logFilePath, `压缩文件稳定性检测选项: maxRetries=${stabilityOptions.maxRetries}, retryInterval=${stabilityOptions.retryInterval}ms, largeFileThreshold=${stabilityOptions.largeFileThreshold} 字节`);
            
            // 等待文件稳定
            const isStable = await waitForFileStability(file.path, stabilityOptions);
            
            if (isStable) {
              // 压缩文件稳定，获取文件的最新信息
              const stats = await fs.stat(file.path);
              await logToFile(logFilePath, `压缩文件已稳定: ${file.path}, 大小: ${stats.size} 字节, 修改时间: ${stats.mtime.toISOString()}`);
              
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
              
              await logToFile(logFilePath, `临时输出目录: ${tempOutputDir}`);
              
              try {
                // 使用core/archive.ts中的函数提取压缩文件内容
                const extractOptions = {
                  preservePermissions: false,
                  skipLargeFiles: stabilityConfig?.archive?.skipLargeFiles,
                  largeFileThreshold: stabilityConfig?.archive?.largeFileThreshold
                };
                
                await logToFile(logFilePath, `解压选项: skipLargeFiles=${extractOptions.skipLargeFiles}, largeFileThreshold=${extractOptions.largeFileThreshold}`);
                
                const extractResult = await extractArchiveContents(file.path, tempOutputDir, extractOptions);
                
                // 记录提取结果
                if (extractResult.success) {
                  await logToFile(logFilePath, `压缩文件提取成功: ${file.path}, 提取了 ${extractResult.extractedFiles.length} 个文件`);
                  
                  if (extractResult.skippedLargeFiles && extractResult.skippedLargeFiles.length > 0) {
                    await logToFile(logFilePath, `跳过了 ${extractResult.skippedLargeFiles.length} 个大文件: ${extractResult.skippedLargeFiles.join(', ')}`);
                  }
                } else {
                  await logToFile(logFilePath, `压缩文件提取部分成功: ${file.path}, 错误: ${extractResult.error?.message}`);
                }
                
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
                await logToFile(logFilePath, `压缩文件稳定性检测和提取完成: ${file.path} (大小: ${stats.size} 字节)`);
              } catch (error: any) {
                await logToFile(logFilePath, `压缩文件提取失败: ${file.path}, 错误: ${error.message}`);
                await logToFile(logFilePath, `错误堆栈: ${error.stack || '无堆栈信息'}`);
                throw new Error(`压缩文件提取失败: ${error.message}`);
              }
            } else {
              // 文件不稳定，加入重试队列
              queue.addToRetryQueue(file, 'archiveStability');
              await logToFile(logFilePath, `压缩文件稳定性检测失败，加入重试队列: ${file.path}, 当前重试次数: ${file.metadata?.retryCount || 0}`);
            }
          } catch (error: any) {
            // 处理压缩文件稳定性检测失败
            await logToFile(logFilePath, `压缩文件稳定性检测失败: ${file.path}, 错误: ${error.message}`);
            await logToFile(logFilePath, `错误堆栈: ${error.stack || '无堆栈信息'}`);
            failedItems.push({
              type: 'stability' as const,
              path: file.path,
              error: `压缩文件稳定性检测失败: ${error.message}`
            });
            queue.markAsFailed(file.path);
          }
        }
        
        // 标记处理完成
        files.forEach(file => {
          queue.getProcessingSet('archiveStability')?.delete(file.path);
        });
        
        // 更新队列状态
        const currentQueueStats = queue.getDetailedQueueStats().archiveStability;
        await logToFile(logFilePath, `压缩文件稳定性队列状态更新: 等待=${currentQueueStats.waiting}, 处理中=${currentQueueStats.processing}`);
        
        // 检查是否还有文件需要处理
        if (queue.getFilesInQueue('archiveStability').length > 0 || 
            queue.getDetailedQueueStats().archiveStability.processing > 0) {
          // 继续处理下一批
          queue.processNextBatch('archiveStability', queueConfig.maxConcurrentArchiveChecks || 2, processor);
        } else {
          await logToFile(logFilePath, `压缩文件稳定性队列处理完成`);
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
    const queueFiles = queue.getFilesInQueue('md5');
    await logToFile(logFilePath, `MD5队列状态: 共 ${queueFiles.length} 个文件等待处理`);
    if (queueFiles.length > 0) {
      await logToFile(logFilePath, `MD5队列文件列表: ${queueFiles.map(f => f.path).join(', ')}`);
    } else {
      await logToFile(logFilePath, `MD5队列为空，无需计算MD5`);
      return Promise.resolve(); // 如果队列为空，直接返回已完成的Promise
    }

    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        // 如果没有文件要处理，则直接完成
        if (files.length === 0) {
          await logToFile(logFilePath, `没有文件需要计算MD5，跳过MD5计算步骤`);
          resolve();
          return;
        }
        
        await logToFile(logFilePath, `计算MD5: ${files.length} 个文件`);
        
        // 单独处理每个文件
        for (const file of files) {
          try {
            // Calculate MD5
            const updatedFile = await calculateFileMd5(file);
            
            // 执行去重检查
            if (deduplicatorOptions.enabled) {
              const deduplicationResult = deduplicator.checkDuplicate(updatedFile);
              
              // 检查文件是否重复
              if (deduplicationResult.isDuplicate) {
                // 记录去重结果
                if (deduplicationResult.type === DeduplicationType.HISTORICAL_DUPLICATE) {
                  await logToFile(logFilePath, `文件 ${updatedFile.path} 与历史文件重复，已跳过`);
                  skippedHistoricalDuplicates.push(updatedFile);
                } else if (deduplicationResult.type === DeduplicationType.TASK_DUPLICATE) {
                  await logToFile(logFilePath, `文件 ${updatedFile.path} 在当前任务中重复，已跳过`);
                  skippedTaskDuplicates.push(updatedFile);
                }
                
                // 跳过重复文件，不加入打包队列
                continue;
              }
            }

            // Add to processed files *after* MD5 calculation and deduplication check
            processedFiles.push(updatedFile);

            // 将文件添加到打包队列
            queue.addToQueue('packaging', updatedFile);
            
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
    });
  }
  
  /**
   * 处理打包队列
   */
  async function processPackagingQueue(): Promise<void> {
    const queueFiles = queue.getFilesInQueue('packaging');
    await logToFile(logFilePath, `打包队列状态: 共 ${queueFiles.length} 个文件等待处理`);
    if (queueFiles.length > 0) {
      await logToFile(logFilePath, `打包队列文件列表: ${queueFiles.map(f => f.path).join(', ')}`);
    } else {
      await logToFile(logFilePath, `打包队列为空，无需创建包`);
      return Promise.resolve(); // 队列为空，直接返回已完成的Promise
    }

    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        // 如果没有文件要处理，则直接完成
        if (files.length === 0) {
          await logToFile(logFilePath, `没有文件需要打包，跳过打包步骤`);
          resolve();
          return;
        }
        
        await logToFile(logFilePath, `处理打包: ${files.length} 个文件`);
        
        try {
          // 创建临时输出目录
          const packageName = `package-${taskId || 'default'}-${scanId}-${packagePaths.length}.zip`;
          const packagePath = path.join(outputDir, packageName);
          
          // 调用core/packaging.ts中的createBatchPackage函数创建包
          await logToFile(logFilePath, `正在创建打包文件: ${packagePath}`);
          const { createBatchPackage } = require('./core/packaging');
          
          const packageResult = await createBatchPackage(files, packagePath, {
            includeMetadata: true,
            compressionLevel: 0,
            tempDir: path.join(outputDir, 'temp')
          });
          
          if (packageResult.success) {
            // 记录包路径
            packagePaths.push(packagePath);
            await logToFile(logFilePath, `打包成功: ${packagePath}`);
            
            // 添加打包后的文件到传输队列
            const packageItem: FileItem = {
              path: packagePath,
              name: path.basename(packagePath),
              createTime: new Date(),
              modifyTime: new Date(),
              size: fs.statSync(packagePath).size,
              origin: 'filesystem',
              metadata: {
                packagedFiles: files.map(f => f.path),
                fileCount: files.length
              }
            };
            
            // 将打包文件添加到传输队列
            queue.addToQueue('transport', packageItem);
            
            // 标记原始文件为已完成
            files.forEach(file => {
              queue.markAsCompleted(file.path);
            });
            
            await logToFile(logFilePath, `打包文件已添加到传输队列: ${packageItem.path}`);
          } else {
            // 打包失败处理
            await logToFile(logFilePath, `打包失败: ${packageResult.error?.message || '未知错误'}`);
            files.forEach(file => {
              failedItems.push({
                type: 'packaging' as const,
                path: file.path,
                error: `打包失败: ${packageResult.error?.message || '未知错误'}`
              });
              queue.markAsFailed(file.path);
            });
          }
        } catch (error: any) {
          await logToFile(logFilePath, `打包处理失败: ${error.message}`);
          files.forEach(file => {
            failedItems.push({
              type: 'packaging' as const,
              path: file.path,
              error: `打包失败: ${error.message}`
            });
            queue.markAsFailed(file.path);
          });
        }
        
        // 标记处理完成
        files.forEach(file => {
          queue.getProcessingSet('packaging')?.delete(file.path);
        });
        
        // 检查是否还有文件需要处理
        if (queue.getFilesInQueue('packaging').length > 0 || 
            queue.getDetailedQueueStats().packaging.processing > 0) {
          // 继续处理下一批
          queue.processNextBatch('packaging', queueConfig.maxConcurrentPackaging || packagingTrigger.maxFiles || 10, processor);
        } else {
          resolve();
        }
      };
      
      // 开始处理第一批
      queue.processNextBatch('packaging', queueConfig.maxConcurrentPackaging || packagingTrigger.maxFiles || 10, processor);
    });
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
    
    // 检查传输队列是否为空
    const transportFiles = queue.getFilesInQueue('transport');
    if (transportFiles.length === 0) {
      await logToFile(logFilePath, `传输队列为空，无需传输`);
      return Promise.resolve();
    }
    
    // 构建子目录名称
    const remoteSubDir = `${taskId}-${scanId}`;
    await logToFile(logFilePath, `将文件上传到远程目录: ${remoteSubDir}`);
    
    return new Promise(resolve => {
      const processor = async (files: FileItem[]) => {
        // 如果没有文件要处理，则直接完成
        if (files.length === 0) {
          await logToFile(logFilePath, `没有文件需要传输，跳过传输步骤`);
          resolve();
          return;
        }
        
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
              
              // 文件上传成功后，将包中的文件MD5添加到历史记录中
              if (deduplicatorOptions.enabled && file.metadata?.packagedFiles) {
                // 获取包中的文件列表
                const packagedFiles = processedFiles.filter(f => 
                  file.metadata?.packagedFiles?.includes(f.path)
                );
                
                // 添加到历史记录
                const addedCount = deduplicator.addBatchToHistory(packagedFiles);
                await logToFile(logFilePath, `添加 ${addedCount} 个文件MD5到历史记录`);
              }
              
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
        
        // 标记处理完成
        files.forEach(file => {
          queue.getProcessingSet('transport')?.delete(file.path);
        });
        
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