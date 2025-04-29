/**
 * @file 文件稳定性检测模块
 * 用于检测文件是否处于稳定状态（非编辑中）
 */

import * as fs from 'fs/promises';
import { constants, createReadStream } from 'fs';
import { StabilityCheckOptions } from '../types';
import * as os from 'os';

/**
 * 文件稳定性检测结果
 */
export enum FileStabilityStatus {
  /** 文件稳定 */
  STABLE = 'stable',
  /** 文件被锁定，没有访问权限 */
  LOCKED = 'locked',
  /** 文件不存在 */
  NOT_EXIST = 'not_exist',
  /** 文件正在写入 */
  WRITING = 'writing',
  /** 文件大小不稳定 */
  SIZE_CHANGING = 'size_changing',
  /** 检测失败 */
  CHECK_FAILED = 'check_failed',
}

/**
 * 默认的稳定性检测选项
 */
const DEFAULT_STABILITY_OPTIONS: StabilityCheckOptions = {
  enabled: true,
  maxRetries: 3,
  retryInterval: 1000,
  checkInterval: 2000,
  largeFileThreshold: 100 * 1024 * 1024, // 100MB
  skipReadForLargeFiles: true,
};

/**
 * 获取合并后的稳定性检测选项
 * @param options 用户提供的选项
 * @returns 合并后的选项
 */
function getStabilityOptions(options: Partial<StabilityCheckOptions> = {}): StabilityCheckOptions {
  return { ...DEFAULT_STABILITY_OPTIONS, ...options };
}

/**
 * 检查文件是否被锁定（处于编辑状态）
 * @param filePath 文件路径
 * @param options 稳定性检测选项
 * @returns 文件稳定性状态的Promise
 */
export async function checkFileStability(
  filePath: string, 
  options: Partial<StabilityCheckOptions> = {}
): Promise<FileStabilityStatus> {
  const opts = getStabilityOptions(options);
  
  try {
    // 1. 检查文件是否存在
    try {
      await fs.access(filePath, constants.F_OK);
    } catch (error) {
      return FileStabilityStatus.NOT_EXIST;
    }
    
    // 2. 检查文件访问权限
    try {
      await fs.access(filePath, constants.R_OK | constants.W_OK);
    } catch (error) {
      return FileStabilityStatus.LOCKED;
    }
    
    // 3. 获取文件大小
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    
    // 4. 对于大文件，使用平台相关的优化策略
    if (fileSize > opts.largeFileThreshold && opts.skipReadForLargeFiles) {
      return await checkLargeFileStability(filePath, fileSize);
    }
    
    // 5. 标准检测：尝试读取文件的前1字节
    try {
      await readFileFirstByte(filePath);
      return FileStabilityStatus.STABLE;
    } catch (error) {
      return FileStabilityStatus.LOCKED;
    }
  } catch (error) {
    return FileStabilityStatus.CHECK_FAILED;
  }
}

/**
 * 读取文件的第一个字节，以检查是否可以访问
 * @param filePath 文件路径
 */
async function readFileFirstByte(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start: 0, end: 0 });
    
    stream.on('data', () => {
      stream.close();
      resolve();
    });
    
    stream.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 根据不同平台检查大文件的稳定性
 * @param filePath 文件路径
 * @param fileSize 文件大小
 * @returns 文件稳定性状态的Promise
 */
async function checkLargeFileStability(
  filePath: string, 
  _fileSize: number
): Promise<FileStabilityStatus> {
  const platform = os.platform();
  
  // Windows平台
  if (platform === 'win32') {
    return await checkWindowsFileStability(filePath);
  }
  
  // Linux/Unix/macOS平台
  return await checkUnixFileStability(filePath);
}

/**
 * Windows平台特定的文件稳定性检测
 * @param filePath 文件路径
 * @returns 文件稳定性状态的Promise
 */
async function checkWindowsFileStability(filePath: string): Promise<FileStabilityStatus> {
  try {
    // 在Windows上，尝试重命名文件到自身是一种检测文件锁定的方法
    // 如果文件被锁定，这会失败
    const tempName = `${filePath}.temp`;
    await fs.rename(filePath, tempName);
    await fs.rename(tempName, filePath);
    return FileStabilityStatus.STABLE;
  } catch (error) {
    return FileStabilityStatus.LOCKED;
  }
}

/**
 * Unix平台特定的文件稳定性检测
 * @param filePath 文件路径
 * @returns 文件稳定性状态的Promise
 */
async function checkUnixFileStability(
  filePath: string
): Promise<FileStabilityStatus> {
  try {
    // 首先检查文件大小是否稳定
    // 获取第一次的文件信息
    const stats1 = await fs.stat(filePath);
    
    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 再次获取文件信息
    const stats2 = await fs.stat(filePath);
    
    // 比较两次的文件大小和修改时间
    if (stats1.size !== stats2.size) {
      return FileStabilityStatus.SIZE_CHANGING;
    }
    
    if (stats1.mtime.getTime() !== stats2.mtime.getTime()) {
      return FileStabilityStatus.WRITING;
    }
    
    return FileStabilityStatus.STABLE;
  } catch (error) {
    return FileStabilityStatus.CHECK_FAILED;
  }
}

/**
 * 检查文件是否被锁定（处于编辑状态）
 * @param filePath 文件路径
 * @param options 稳定性检测选项
 * @returns 文件是否被锁定的Promise
 */
export async function isFileLocked(
  filePath: string, 
  options: Partial<StabilityCheckOptions> = {}
): Promise<boolean> {
  const status = await checkFileStability(filePath, options);
  return status !== FileStabilityStatus.STABLE;
}

/**
 * 等待文件变为稳定状态
 * @param filePath 文件路径
 * @param options 稳定性检测选项
 * @returns 文件是否变为稳定状态的Promise
 */
export async function waitForFileStability(
  filePath: string,
  options: Partial<StabilityCheckOptions> = {}
): Promise<boolean> {
  const opts = getStabilityOptions(options);
  
  let retries = 0;
  let consecutiveStableChecks = 0;
  const requiredStableChecks = 2; // 连续稳定检查次数，确保文件真的稳定
  
  console.log(`[稳定性检查] 开始检查文件 ${filePath}, 最大重试次数: ${opts.maxRetries}, 间隔: ${opts.retryInterval}ms`);
  
  while (retries < opts.maxRetries) {
    const status = await checkFileStability(filePath, opts);
    console.log(`[稳定性检查] 文件 ${filePath} 的第 ${retries + 1}/${opts.maxRetries} 次检查结果: ${status}`);
    
    if (status === FileStabilityStatus.STABLE) {
      consecutiveStableChecks++;
      console.log(`[稳定性检查] 文件 ${filePath} 连续稳定次数: ${consecutiveStableChecks}/${requiredStableChecks}`);
      
      if (consecutiveStableChecks >= requiredStableChecks) {
        console.log(`[稳定性检查] 文件 ${filePath} 已稳定，通过连续 ${consecutiveStableChecks} 次检查`);
        return true; // 文件已稳定
      }
    } else {
      // 重置连续稳定计数
      console.log(`[稳定性检查] 文件 ${filePath} 不稳定，重置连续稳定计数，状态: ${status}`);
      consecutiveStableChecks = 0;
    }
    
    // 等待一段时间后重试
    console.log(`[稳定性检查] 等待 ${opts.retryInterval}ms 后进行下一次检查`);
    await new Promise(resolve => setTimeout(resolve, opts.retryInterval));
    retries++;
  }
  
  console.log(`[稳定性检查] 文件 ${filePath} 仍不稳定，已达到最大重试次数 ${opts.maxRetries}`);
  return false; // 文件仍不稳定
}

/**
 * 创建可用于确认多个文件稳定性的批处理函数
 * @param options 稳定性检测选项
 * @returns 批处理稳定性检测函数
 */
export function createBatchStabilityChecker(
  options: Partial<StabilityCheckOptions> = {}
): (filePaths: string[]) => Promise<Map<string, boolean>> {
  const opts = getStabilityOptions(options);
  
  return async (filePaths: string[]): Promise<Map<string, boolean>> => {
    const results = new Map<string, boolean>();
    
    // 为每个文件创建一个Promise
    const promises = filePaths.map(async (filePath) => {
      const isStable = await waitForFileStability(filePath, opts);
      results.set(filePath, isStable);
    });
    
    // 等待所有Promise完成
    await Promise.all(promises);
    
    return results;
  };
} 