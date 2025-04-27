/**
 * @file MD5计算模块
 * 用于计算文件的MD5值
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { FileItem } from '../types';

/**
 * MD5计算进度回调函数类型
 */
export type Md5ProgressCallback = (progress: number, filePath: string) => void;

/**
 * MD5计算选项
 */
export interface Md5Options {
  /** 是否使用优化的流式处理（用于大文件） */
  useStreamProcessing?: boolean;
  /** 缓冲区大小（字节） */
  bufferSize?: number;
  /** 大文件阈值（字节），超过此大小将使用流式处理 */
  largeFileThreshold?: number;
  /** 进度回调函数 */
  onProgress?: Md5ProgressCallback;
}

/**
 * 默认MD5计算选项
 */
const DEFAULT_MD5_OPTIONS: Md5Options = {
  useStreamProcessing: true,
  bufferSize: 8 * 1024 * 1024, // 8MB
  largeFileThreshold: 100 * 1024 * 1024, // 100MB
};

/**
 * 计算文件的MD5值
 * @param filePath 文件路径
 * @param options MD5计算选项
 * @returns MD5哈希值的Promise
 */
export async function calculateMd5(
  filePath: string, 
  options: Md5Options = {}
): Promise<string> {
  const opts = { ...DEFAULT_MD5_OPTIONS, ...options };
  
  try {
    // 获取文件大小
    const stats = await fs.promises.stat(filePath);
    const fileSize = stats.size;
    
    // 对于大文件，使用流式处理以减少内存使用
    if (fileSize > opts.largeFileThreshold! && opts.useStreamProcessing) {
      return calculateMd5Stream(filePath, fileSize, opts);
    }
    
    // 对于小文件，使用标准方法
    return calculateMd5Standard(filePath);
  } catch (error: any) {
    throw new Error(`计算MD5失败 (${filePath}): ${error.message}`);
  }
}

/**
 * 使用标准方法计算小文件的MD5值
 * @param filePath 文件路径
 * @returns MD5哈希值的Promise
 */
async function calculateMd5Standard(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      
      // 确保 stream 存在且有 on 方法
      if (!stream || typeof stream.on !== 'function') {
        return reject(new Error(`创建文件读取流失败: ${filePath}`));
      }
      
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', error => reject(error));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 使用流式处理计算大文件的MD5值，支持进度报告
 * @param filePath 文件路径
 * @param fileSize 文件大小
 * @param options MD5计算选项
 * @returns MD5哈希值的Promise
 */
async function calculateMd5Stream(
  filePath: string, 
  fileSize: number, 
  options: Md5Options
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath, {
        highWaterMark: options.bufferSize
      });
      
      // 确保 stream 存在且有 on 方法
      if (!stream || typeof stream.on !== 'function') {
        return reject(new Error(`创建文件读取流失败: ${filePath}`));
      }
      
      let processedBytes = 0;
      let lastProgressReported = 0;
      
      stream.on('data', (data) => {
        hash.update(data);
        
        // 更新处理的字节数
        processedBytes += data.length;
        
        // 计算进度百分比
        const progress = Math.floor((processedBytes / fileSize) * 100);
        
        // 如果有进度回调，确保调用它
        if (options.onProgress && progress > lastProgressReported) {
          options.onProgress(progress, filePath);
          lastProgressReported = progress;
        }
      });
      
      stream.on('end', () => {
        // 确保报告100%进度
        if (options.onProgress && lastProgressReported < 100) {
          options.onProgress(100, filePath);
        }
        
        resolve(hash.digest('hex'));
      });
      
      stream.on('error', (error) => reject(error));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 为文件项计算MD5值
 * @param fileItem 文件项
 * @param options MD5计算选项
 * @returns 更新后的文件项
 */
export async function calculateFileMd5(
  fileItem: FileItem, 
  options: Md5Options = {}
): Promise<FileItem> {
  try {
    const md5 = await calculateMd5(fileItem.path, options);
    return {
      ...fileItem,
      md5
    };
  } catch (error) {
    // 如果MD5计算失败，保留原始文件项
    console.error(`计算文件 ${fileItem.path} 的MD5值失败:`, error);
    return fileItem;
  }
}

/**
 * 并行计算多个文件的MD5值
 * @param files 文件项数组
 * @param options MD5计算选项
 * @param concurrency 并行计算的文件数
 * @returns 更新后的文件项数组
 */
export async function calculateBatchMd5(
  files: FileItem[], 
  options: Md5Options = {}, 
  concurrency = 0
): Promise<FileItem[]> {
  // 如果未指定并发数，则根据CPU核心数自动计算
  if (!concurrency) {
    concurrency = Math.max(1, Math.min(
      os.cpus().length,
      Math.floor(os.freemem() / (100 * 1024 * 1024)), // 每100MB内存一个并发
      files.length
    ));
  }
  
  // 创建结果数组
  const result = [...files];
  
  // 将文件分成批次处理
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    
    // 并行处理当前批次
    const promises = batch.map(async (file, index) => {
      const updatedFile = await calculateFileMd5(file, options);
      result[i + index] = updatedFile;
    });
    
    // 等待当前批次完成
    await Promise.all(promises);
  }
  
  return result;
}

/**
 * 根据文件大小优化MD5计算方法
 * @param filePath 文件路径
 * @param options MD5计算选项
 * @returns MD5哈希值的Promise
 */
export async function calculateOptimizedMd5(
  filePath: string, 
  options: Md5Options = DEFAULT_MD5_OPTIONS
): Promise<string> {
  try {
    const stats = await fs.promises.stat(filePath);
    const fileSize = stats.size;
    
    // 根据文件大小优化缓冲区大小
    let bufferSize = options.bufferSize;
    let useStream = options.useStreamProcessing;
    
    if (fileSize === 0) {
      // 空文件直接返回标准MD5值
      return 'd41d8cd98f00b204e9800998ecf8427e';
    } else if (fileSize < 1024 * 1024) { // < 1MB
      // 小文件使用标准读取
      bufferSize = 64 * 1024; // 64KB
      useStream = false;
    } else if (fileSize < 10 * 1024 * 1024) { // 1MB - 10MB
      // 中型文件适中缓冲区
      bufferSize = 1 * 1024 * 1024; // 1MB
      useStream = true;
    } else if (fileSize < 100 * 1024 * 1024) { // 10MB - 100MB
      // 大型文件较大缓冲区
      bufferSize = 2 * 1024 * 1024; // 2MB
      useStream = true;
    } else { // >= 100MB
      // 超大文件使用更小的缓冲区以增加进度回调频率
      bufferSize = 4 * 1024 * 1024; // 4MB
      useStream = true;
    }
    
    // 使用优化后的选项计算MD5，保留原始选项中的onProgress回调
    const optimizedOptions: Md5Options = {
      ...options,  // 保留所有原始选项，包括onProgress回调
      bufferSize,
      useStreamProcessing: useStream
    };
    
    return calculateMd5(filePath, optimizedOptions);
  } catch (error: any) {
    throw new Error(`计算优化MD5失败: ${error.message}`);
  }
} 