/**
 * @file 压缩文件处理模块
 * 负责压缩文件提取、完整性检查等功能
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { FileItem } from '../types';
import * as os from 'os';
import { zip, tgz, tar } from 'compressing';

/**
 * 压缩文件提取选项
 */
export interface ArchiveExtractionOptions {
  /** 是否保留文件权限 */
  preservePermissions?: boolean;
  /** 是否跳过大文件 */
  skipLargeFiles?: boolean;
  /** 大文件阈值（字节） */
  largeFileThreshold?: number;
  /** 临时文件目录 */
  tempDir?: string;
  /** 提取进度回调 */
  onProgress?: (progress: ArchiveExtractionProgress) => void;
}

/**
 * 压缩文件提取进度信息
 */
export interface ArchiveExtractionProgress {
  /** 已处理文件数 */
  processedFiles: number;
  /** 总文件数(如果可获取) */
  totalFiles?: number;
  /** 完成百分比 (0-100) */
  percentage: number;
  /** 当前处理的文件名 */
  currentFile?: string;
  /** 当前文件的处理进度 (0-100) */
  currentFileProgress?: number;
}

/**
 * 压缩文件提取结果
 */
export interface ArchiveExtractionResult {
  /** 提取是否成功 */
  success: boolean;
  /** 提取的文件路径 */
  extractedPath: string;
  /** 提取的文件列表 */
  extractedFiles: string[];
  /** 跳过的大文件列表 */
  skippedLargeFiles?: string[];
  /** 发生的错误 */
  error?: Error;
}

/**
 * 默认提取选项
 */
const DEFAULT_EXTRACTION_OPTIONS: ArchiveExtractionOptions = {
  preservePermissions: false,
  skipLargeFiles: true,
  largeFileThreshold: 100 * 1024 * 1024, // 100MB
};

/**
 * 测试压缩文件完整性
 * @param archivePath 压缩文件路径
 * @returns 是否完整
 */
export async function testArchiveIntegrity(archivePath: string): Promise<boolean> {
  const ext = path.extname(archivePath).toLowerCase();
  
  try {
    if (ext === '.zip') {
      await testZipIntegrity(archivePath);
    } else if (ext === '.tar') {
      await testTarIntegrity(archivePath);
    } else if (ext === '.tgz' || archivePath.toLowerCase().endsWith('.tar.gz')) {
      await testTgzIntegrity(archivePath);
    } else if (ext === '.rar') {
      await testRarIntegrity(archivePath);
    } else {
      throw new Error(`不支持的压缩格式: ${ext}`);
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 测试ZIP文件完整性
 */
async function testZipIntegrity(zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const readStream = fs.createReadStream(zipPath);
      const stream = new zip.UncompressStream();
      
      let hasError = false;
      
      // 测试文件读取过程中是否有错误
      readStream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('finish', () => {
        if (!hasError) {
          resolve();
        }
      });
      
      // 只读取文件头信息，不进行实际解压
      readStream.pipe(stream);
      
      // 读取一部分数据后停止，只是为了验证文件格式
      setTimeout(() => {
        if (!hasError) {
          readStream.destroy();
          resolve();
        }
      }, 1000);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 测试TAR文件完整性
 */
async function testTarIntegrity(tarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const readStream = fs.createReadStream(tarPath);
      const stream = new tar.UncompressStream();
      
      let hasError = false;
      
      readStream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('finish', () => {
        if (!hasError) {
          resolve();
        }
      });
      
      readStream.pipe(stream);
      
      setTimeout(() => {
        if (!hasError) {
          readStream.destroy();
          resolve();
        }
      }, 1000);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 测试TGZ文件完整性
 */
async function testTgzIntegrity(tgzPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const readStream = fs.createReadStream(tgzPath);
      const stream = new tgz.UncompressStream();
      
      let hasError = false;
      
      readStream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('error', (err) => {
        hasError = true;
        reject(err);
      });
      
      stream.on('finish', () => {
        if (!hasError) {
          resolve();
        }
      });
      
      readStream.pipe(stream);
      
      setTimeout(() => {
        if (!hasError) {
          readStream.destroy();
          resolve();
        }
      }, 1000);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 测试RAR文件完整性
 * 注意：需要单独安装unrar依赖
 */
async function testRarIntegrity(rarPath: string): Promise<void> {
  try {
    // 优先使用node-unrar-js模块
    try {
      const { createExtractorFromFile } = require('node-unrar-js');
      const extractor = await createExtractorFromFile({ filepath: rarPath });
      await extractor.getFileList();
      return;
    } catch (moduleError) {
      // 如果module不存在，尝试使用命令行方法
      return testRarIntegrityWithCommand(rarPath);
    }
  } catch (error) {
    throw new Error(`RAR文件损坏或不完整: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 使用命令行工具测试RAR文件完整性
 */
async function testRarIntegrityWithCommand(rarPath: string): Promise<void> {
  try {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      // 使用unrar命令行工具检测文件完整性
      exec(`unrar t "${rarPath}"`, (error: Error | null) => {
        if (error) {
          reject(new Error(`RAR文件损坏或不完整`));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    throw new Error(`无法验证RAR文件完整性: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 提取压缩文件内容
 * @param archivePath 压缩文件路径
 * @param outputPath 输出目录路径
 * @param options 提取选项
 * @returns 提取结果
 */
export async function extractArchiveContents(
  archivePath: string,
  outputPath: string,
  options: ArchiveExtractionOptions = {}
): Promise<ArchiveExtractionResult> {
  // 合并选项
  const opts = { ...DEFAULT_EXTRACTION_OPTIONS, ...options };
  
  try {
    // 确保文件存在
    if (!await fs.pathExists(archivePath)) {
      return {
        success: false,
        extractedPath: outputPath,
        extractedFiles: [],
        error: new Error(`找不到文件: ${archivePath}`)
      };
    }
    
    // 确保输出目录存在
    await fs.ensureDir(outputPath);
    
    // 获取文件扩展名
    const ext = path.extname(archivePath).toLowerCase();
    
    // 根据文件类型选择合适的提取方法
    if (ext === '.zip') {
      return await extractZipArchive(archivePath, outputPath, opts);
    } else if (ext === '.tar') {
      return await extractTarArchive(archivePath, outputPath, opts);
    } else if (ext === '.tgz' || archivePath.toLowerCase().endsWith('.tar.gz')) {
      return await extractTgzArchive(archivePath, outputPath, opts);
    } else if (ext === '.rar') {
      return await extractRarArchive(archivePath, outputPath, opts);
    } else {
      return {
        success: false,
        extractedPath: outputPath,
        extractedFiles: [],
        error: new Error(`不支持的压缩格式: ${ext}`)
      };
    }
  } catch (error) {
    // 提取过程出错
    return {
      success: false,
      extractedPath: outputPath,
      extractedFiles: [],
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

/**
 * 提取ZIP文件
 */
async function extractZipArchive(
  zipPath: string,
  outputPath: string,
  options: ArchiveExtractionOptions
): Promise<ArchiveExtractionResult> {
  try {
    await zip.uncompress(zipPath, outputPath);
    
    // 读取提取的文件列表
    const extractedFiles = await getExtractedFilesList(outputPath);
    
    // 检查并处理大文件
    const skippedLargeFiles = options.skipLargeFiles ? 
      await checkAndHandleLargeFiles(outputPath, options.largeFileThreshold || 100 * 1024 * 1024) : 
      [];
    
    return {
      success: true,
      extractedPath: outputPath,
      extractedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined
    };
  } catch (error) {
    throw new Error(`提取ZIP文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 提取TAR文件
 */
async function extractTarArchive(
  tarPath: string,
  outputPath: string,
  options: ArchiveExtractionOptions
): Promise<ArchiveExtractionResult> {
  try {
    await tar.uncompress(tarPath, outputPath);
    
    // 读取提取的文件列表
    const extractedFiles = await getExtractedFilesList(outputPath);
    
    // 检查并处理大文件
    const skippedLargeFiles = options.skipLargeFiles ? 
      await checkAndHandleLargeFiles(outputPath, options.largeFileThreshold || 100 * 1024 * 1024) : 
      [];
    
    return {
      success: true,
      extractedPath: outputPath,
      extractedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined
    };
  } catch (error) {
    throw new Error(`提取TAR文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 提取TGZ文件
 */
async function extractTgzArchive(
  tgzPath: string,
  outputPath: string,
  options: ArchiveExtractionOptions
): Promise<ArchiveExtractionResult> {
  try {
    await tgz.uncompress(tgzPath, outputPath);
    
    // 读取提取的文件列表
    const extractedFiles = await getExtractedFilesList(outputPath);
    
    // 检查并处理大文件
    const skippedLargeFiles = options.skipLargeFiles ? 
      await checkAndHandleLargeFiles(outputPath, options.largeFileThreshold || 100 * 1024 * 1024) : 
      [];
    
    return {
      success: true,
      extractedPath: outputPath,
      extractedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined
    };
  } catch (error) {
    throw new Error(`提取TGZ文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 提取RAR文件
 * 注意：需要单独安装unrar依赖
 */
async function extractRarArchive(
  rarPath: string,
  outputPath: string,
  options: ArchiveExtractionOptions
): Promise<ArchiveExtractionResult> {
  try {
    // 优先使用node-unrar-js模块
    try {
      const { createExtractorFromFile } = require('node-unrar-js');
      const extractor = await createExtractorFromFile({ filepath: rarPath });
      
      // 获取文件列表
      const list = extractor.getFileList();
      const files = Array.from(list.files);
      
      // 提取文件
      const extracted = extractor.extract({
        files: files.map((f: any) => f.fileHeader.name)
      });
      
      // 处理提取的文件
      for await (const item of extracted.files) {
        if (item.fileHeader && item.extraction) {
          // 构建目标路径
          const targetPath = path.join(outputPath, item.fileHeader.name);
          
          // 确保目标目录存在
          await fs.ensureDir(path.dirname(targetPath));
          
          // 写入文件内容
          await fs.writeFile(targetPath, item.extraction);
        }
      }
    } catch (moduleError) {
      // 如果模块不存在，尝试使用命令行方法
      await extractRarWithCommand(rarPath, outputPath);
    }
    
    // 读取提取的文件列表
    const extractedFiles = await getExtractedFilesList(outputPath);
    
    // 检查并处理大文件
    const skippedLargeFiles = options.skipLargeFiles ? 
      await checkAndHandleLargeFiles(outputPath, options.largeFileThreshold || 100 * 1024 * 1024) : 
      [];
    
    return {
      success: true,
      extractedPath: outputPath,
      extractedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined
    };
  } catch (error) {
    throw new Error(`提取RAR文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 使用命令行工具提取RAR文件
 */
async function extractRarWithCommand(rarPath: string, outputPath: string): Promise<void> {
  try {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      // 使用unrar命令行工具提取文件
      exec(`unrar x -o+ "${rarPath}" "${outputPath}"`, (error: Error | null) => {
        if (error) {
          reject(new Error(`RAR提取失败: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    throw new Error(`无法提取RAR文件: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 递归获取目录中的所有文件
 */
async function getExtractedFilesList(dir: string): Promise<string[]> {
  let results: string[] = [];
  const items = await fs.readdir(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stats = await fs.stat(fullPath);
    
    if (stats.isDirectory()) {
      const subResults = await getExtractedFilesList(fullPath);
      results = results.concat(subResults);
    } else {
      results.push(fullPath);
    }
  }
  
  return results;
}

/**
 * 检查并处理大文件
 * @returns 跳过的大文件列表
 */
async function checkAndHandleLargeFiles(dir: string, threshold: number): Promise<string[]> {
  const skippedFiles: string[] = [];
  const files = await getExtractedFilesList(dir);
  
  for (const file of files) {
    const stats = await fs.stat(file);
    
    // 如果文件大小超过阈值，记录并删除
    if (stats.size > threshold) {
      skippedFiles.push(file);
      await fs.remove(file);
      
      // 创建一个占位文件
      await fs.writeFile(
        `${file}.large_file_skipped`, 
        `文件大小(${stats.size} 字节)超过阈值(${threshold} 字节)，已跳过处理`
      );
    }
  }
  
  return skippedFiles;
}

/**
 * 创建压缩文件处理器
 * @param options 提取选项
 * @returns 文件处理函数
 */
export function createArchiveProcessor(options: ArchiveExtractionOptions = {}) {
  return async (file: FileItem): Promise<{
    success: boolean;
    extractedPath?: string;
    extractedFiles?: string[];
    error?: Error;
  }> => {
    try {
      // 创建临时输出目录
      const tempDir = options.tempDir || os.tmpdir();
      const outputDir = path.join(
        tempDir,
        `archive-extract-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        path.basename(file.path, path.extname(file.path))
      );
      
      // 提取压缩文件
      const result = await extractArchiveContents(file.path, outputDir, options);
      
      return {
        success: result.success,
        extractedPath: result.extractedPath,
        extractedFiles: result.extractedFiles,
        error: result.error
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  };
} 