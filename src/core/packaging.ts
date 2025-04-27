/**
 * @file 文件打包模块
 * 负责文件打包、元数据生成和包信息提取
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { zip } from 'compressing';
import { FileItem, PackageMetadata, SerializedFileItem } from '../types';

/**
 * 打包选项
 */
export interface PackageOptions {
  /** 是否在元数据中包含MD5值 */
  includeMd5?: boolean;
  /** 是否添加元数据文件 */
  includeMetadata?: boolean;
  /** 压缩级别 (0-9) */
  compressionLevel?: number;
  /** 元数据文件名 */
  metadataFileName?: string;
  /** 临时目录路径 */
  tempDir?: string;
  /** 打包进度回调 */
  onProgress?: (progress: PackageProgress) => void;
  /** 是否启用增强元数据 */
  enhancedMetadata?: boolean;
  /** 元数据版本 */
  metadataVersion?: string;
  /** 包标签 */
  packageTags?: string[];
}

/**
 * 打包进度信息
 */
export interface PackageProgress {
  /** 已处理文件数 */
  processedFiles: number;
  /** 总文件数 */
  totalFiles: number;
  /** 完成百分比 (0-100) */
  percentage: number;
  /** 当前处理的文件名 */
  currentFile?: string;
  /** 当前文件的处理进度 (0-100) */
  currentFileProgress?: number;
}

/**
 * 打包结果
 */
export interface PackageResult {
  /** 打包是否成功 */
  success: boolean;
  /** 输出文件路径 */
  packagePath?: string;
  /** 包含的文件数量 */
  fileCount?: number;
  /** 发生的错误 */
  error?: Error;
  /** 错误列表 (多文件打包时) */
  errors?: Array<{
    file: FileItem;
    error: Error;
  }>;
  /** 警告列表 */
  warnings?: string[];
}

/**
 * 包信息提取结果
 */
export interface PackageInfo {
  /** 提取是否成功 */
  success: boolean;
  /** 文件列表 */
  files: FileItem[];
  /** 元数据对象 (如果存在) */
  metadata: PackageMetadata | null;
  /** 错误信息 */
  error?: Error;
}

/**
 * 默认打包选项
 */
const DEFAULT_OPTIONS: PackageOptions = {
  includeMd5: true,
  includeMetadata: true,
  compressionLevel: 6,
  metadataFileName: 'metadata.json',
  tempDir: path.join(process.cwd(), 'temp'),
  enhancedMetadata: false,
  metadataVersion: '1.0'
};

/**
 * 将FileItem转换为适合存储在元数据中的格式
 */
function serializeFileItem(fileItem: FileItem): SerializedFileItem {
  const { createTime, modifyTime, ...rest } = fileItem;
  return {
    ...rest,
    createTime: createTime?.toISOString(),
    modifyTime: modifyTime?.toISOString()
  };
}

/**
 * 创建单个文件的打包
 * @param fileItem 文件项
 * @param outputPath 输出路径
 * @param options 打包选项
 * @returns 打包结果
 */
export async function createSingleFilePackage(
  fileItem: FileItem,
  outputPath: string,
  options?: PackageOptions
): Promise<PackageResult> {
  // 合并选项
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  try {
    // 确保文件存在
    if (!await fs.pathExists(fileItem.path)) {
      return {
        success: false,
        error: new Error(`找不到文件: ${fileItem.path}`)
      };
    }

    // 调用初始进度回调
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: 0,
        totalFiles: 1,
        percentage: 0,
        currentFile: fileItem.name,
        currentFileProgress: 0
      });
    }
    
    // 创建临时目录
    const tempDir = opts.tempDir || path.join(process.cwd(), 'temp');
    await fs.ensureDir(tempDir);
    
    // 创建临时源文件夹，用于打包
    const tempSrcDir = path.join(tempDir, `src_${Date.now()}`);
    await fs.ensureDir(tempSrcDir);
    
    // 复制文件到临时目录
    const tempFilePath = path.join(tempSrcDir, fileItem.name);
    await fs.copy(fileItem.path, tempFilePath);
    
    // 如果需要元数据
    if (opts.includeMetadata) {
      // 序列化文件项
      const serializedFile = serializeFileItem(fileItem);
      
      // 创建元数据对象
      const metadata: PackageMetadata = {
        createdAt: new Date().toISOString(),
        files: [serializedFile]
      };
      
      // 如果启用了增强元数据
      if (opts.enhancedMetadata) {
        // 添加版本信息
        metadata.version = opts.metadataVersion || '1.0';
        // 生成包唯一ID
        metadata.packageId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        // 添加标签
        if (opts.packageTags && opts.packageTags.length > 0) {
          metadata.tags = opts.packageTags;
        }
        // 添加校验算法信息
        metadata.checksumAlgorithm = 'md5';
      }
      
      // 写入元数据文件
      const metadataPath = path.join(tempSrcDir, opts.metadataFileName || 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }
    
    // 调用中间进度回调
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: 0,
        totalFiles: 1,
        percentage: 50,
        currentFile: fileItem.name,
        currentFileProgress: 50
      });
    }
    
    // 确保输出目录存在
    await fs.ensureDir(path.dirname(outputPath));
    
    // 使用compressing创建zip文件
    await zip.compressDir(tempSrcDir, outputPath, {
      ignoreBase: true
    });
    
    // 清理临时目录
    await fs.remove(tempSrcDir);
    
    // 调用完成进度回调
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: 1,
        totalFiles: 1,
        percentage: 100,
        currentFile: fileItem.name,
        currentFileProgress: 100
      });
    }
    
    return {
      success: true,
      packagePath: outputPath,
      fileCount: 1
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

/**
 * 创建批量文件打包
 * @param fileItems 文件项列表
 * @param outputPath 输出路径
 * @param options 打包选项
 * @returns 打包结果
 */
export async function createBatchPackage(
  fileItems: FileItem[],
  outputPath: string,
  options?: PackageOptions
): Promise<PackageResult> {
  // 合并选项
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // 检查文件列表是否为空
  if (fileItems.length === 0) {
    const result: PackageResult = {
      success: true,
      packagePath: outputPath,
      fileCount: 0,
      warnings: ['文件列表为空，将创建只包含元数据的包']
    };
    
    // 如果需要元数据，为空文件列表创建元数据文件
    if (opts.includeMetadata) {
      try {
        // 创建临时目录
        const tempDir = opts.tempDir || path.join(process.cwd(), 'temp');
        await fs.ensureDir(tempDir);
        
        // 创建临时源文件夹
        const tempSrcDir = path.join(tempDir, `src_${Date.now()}`);
        await fs.ensureDir(tempSrcDir);
        
        // 创建元数据
        const metadata: PackageMetadata = {
          createdAt: new Date().toISOString(),
          files: []
        };
        
        // 写入元数据文件
        const metadataPath = path.join(tempSrcDir, opts.metadataFileName || 'metadata.json');
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        
        // 创建压缩文件
        await fs.ensureDir(path.dirname(outputPath));
        await zip.compressDir(tempSrcDir, outputPath, {
          ignoreBase: true
        });
        
        // 清理临时目录
        await fs.remove(tempSrcDir);
      } catch (error) {
        result.success = false;
        result.error = error instanceof Error ? error : new Error(String(error));
      }
    }
    
    return result;
  }
  
  // 创建临时目录
  const tempDir = opts.tempDir || path.join(process.cwd(), 'temp');
  await fs.ensureDir(tempDir);
  
  // 创建临时源文件夹
  const tempSrcDir = path.join(tempDir, `src_${Date.now()}`);
  await fs.ensureDir(tempSrcDir);
  
  // 存储处理过程中的错误
  const errors: Array<{ file: FileItem; error: Error }> = [];
  // 成功添加的文件
  const successFiles: FileItem[] = [];
  
  // 处理计数器
  let processedCount = 0;
  const totalCount = fileItems.length;
  
  // 报告初始进度
  if (opts.onProgress) {
    opts.onProgress({
      processedFiles: 0,
      totalFiles: totalCount,
      percentage: 0
    });
  }
  
  // 逐个处理文件
  for (const fileItem of fileItems) {
    try {
      // 报告当前文件进度
      if (opts.onProgress) {
        opts.onProgress({
          processedFiles: processedCount,
          totalFiles: totalCount,
          percentage: Math.floor((processedCount / totalCount) * 100),
          currentFile: fileItem.name,
          currentFileProgress: 0
        });
      }
      
      // 检查文件是否存在
      if (!await fs.pathExists(fileItem.path)) {
        throw new Error(`找不到文件: ${fileItem.path}`);
      }
      
      // 复制文件到临时目录
      const tempFilePath = path.join(tempSrcDir, fileItem.name);
      await fs.copy(fileItem.path, tempFilePath);
      successFiles.push(fileItem);
      
      // 报告文件完成进度
      if (opts.onProgress) {
        opts.onProgress({
          processedFiles: processedCount + 1,
          totalFiles: totalCount,
          percentage: Math.floor(((processedCount + 1) / totalCount) * 100),
          currentFile: fileItem.name,
          currentFileProgress: 100
        });
      }
    } catch (error) {
      // 记录错误
      errors.push({
        file: fileItem,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
    
    // 更新处理计数
    processedCount++;
    
    // 报告总体进度
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: processedCount,
        totalFiles: totalCount,
        percentage: Math.floor((processedCount / totalCount) * 100)
      });
    }
  }
  
  try {
    // 如果需要元数据
    if (opts.includeMetadata) {
      // 序列化文件列表
      const serializedFiles = successFiles.map(file => serializeFileItem(file));
      
      // 创建元数据对象
      const metadata: PackageMetadata = {
        createdAt: new Date().toISOString(),
        files: serializedFiles
      };
      
      // 如果启用了增强元数据
      if (opts.enhancedMetadata) {
        // 添加版本信息
        metadata.version = opts.metadataVersion || '1.0';
        // 生成包唯一ID
        metadata.packageId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        // 添加标签
        if (opts.packageTags && opts.packageTags.length > 0) {
          metadata.tags = opts.packageTags;
        }
        // 添加校验算法信息
        metadata.checksumAlgorithm = 'md5';
      }
      
      // 如果有错误，添加到元数据
      if (errors.length > 0) {
        metadata.errors = errors.map(err => ({
          file: err.file.name,
          error: err.error.message
        }));
      }
      
      // 写入元数据文件
      const metadataPath = path.join(tempSrcDir, opts.metadataFileName || 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }
    
    // 创建压缩文件
    await fs.ensureDir(path.dirname(outputPath));
    await zip.compressDir(tempSrcDir, outputPath, {
      ignoreBase: true
    });
    
    // 清理临时目录
    await fs.remove(tempSrcDir);
    
    // 报告最终进度
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: totalCount,
        totalFiles: totalCount,
        percentage: 100
      });
    }
    
    return {
      success: true,
      packagePath: outputPath,
      fileCount: successFiles.length,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    // 清理临时目录
    try {
      await fs.remove(tempSrcDir);
    } catch (e) {
      // 忽略清理错误
    }
    
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

/**
 * 提取ZIP包中的信息
 * @param packagePath ZIP包路径
 * @returns 包信息
 */
export async function extractPackageInfo(packagePath: string): Promise<PackageInfo> {
  try {
    // 检查文件是否存在
    if (!await fs.pathExists(packagePath)) {
      return {
        success: false,
        files: [],
        metadata: null,
        error: new Error(`找不到文件: ${packagePath}`)
      };
    }
    
    // 创建临时目录
    const tempDir = path.join(process.cwd(), 'temp', `extract_${Date.now()}`);
    await fs.ensureDir(tempDir);
    
    try {
      // 解压文件
      await zip.uncompress(packagePath, tempDir);
      
      // 读取解压后的文件列表
      const extractedFiles = await fs.readdir(tempDir);
      
      // 查找元数据文件
      let metadata = null;
      const metadataFile = extractedFiles.find(file => file === 'metadata.json');
      
      // 如果找到元数据，解析它
      if (metadataFile) {
        try {
          const metadataContent = await fs.readFile(path.join(tempDir, metadataFile), 'utf8');
          metadata = JSON.parse(metadataContent);
        } catch (error) {
          console.warn('解析元数据失败:', error);
        }
      }
      
      // 提取文件列表
      const files: FileItem[] = [];
      
      for (const fileName of extractedFiles) {
        if (fileName === 'metadata.json') continue;
        
        const filePath = path.join(tempDir, fileName);
        const stats = await fs.stat(filePath);
        
        // 从元数据中查找文件信息
        let md5: string | undefined;
        let createTime: Date | undefined;
        let modifyTime: Date | undefined;
        
        if (metadata && metadata.files) {
          const metaFile = metadata.files.find((f: any) => f.name === fileName);
          if (metaFile) {
            md5 = metaFile.md5;
            createTime = metaFile.createTime ? new Date(metaFile.createTime) : undefined;
            modifyTime = metaFile.modifyTime ? new Date(metaFile.modifyTime) : undefined;
          }
        }
        
        // 创建FileItem对象
        files.push({
          name: fileName,
          size: stats.size,
          createTime: createTime || stats.birthtime,
          modifyTime: modifyTime || stats.mtime,
          md5
        } as FileItem);
      }
      
      // 清理临时目录
      await fs.remove(tempDir);
      
      return {
        success: true,
        files,
        metadata
      };
    } catch (error) {
      // 清理临时目录
      try {
        await fs.remove(tempDir);
      } catch (e) {
        // 忽略清理错误
      }
      throw error;
    }
  } catch (error) {
    return {
      success: false,
      files: [],
      metadata: null,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
} 