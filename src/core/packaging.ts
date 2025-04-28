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
  /** 输出文件路径（兼容字段） */
  outputPath?: string;
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
  /** 打包开始时间 */
  packagedAt?: Date;
  /** 打包耗时（毫秒） */
  duration?: number;
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
  enhancedMetadata: true,
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
  options?: Partial<PackageOptions>
): Promise<PackageResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startTime = new Date();
  const fileCount = fileItems.length;
  let processedFiles = 0;
  const errors: Array<{file: FileItem; error: Error;}> = [];
  const warnings: string[] = [];
  const successFiles: FileItem[] = [];
  
  // 创建临时目录
  const packageTempDir = path.join(opts.tempDir || 'temp', `pkg_${Date.now()}`);
  try {
    await fs.promises.mkdir(packageTempDir, { recursive: true });
    
    // 用于检查文件名冲突
    const fileNameMap = new Map<string, number>();
    
    // 处理文件
    for (const fileItem of fileItems) {
      try {
        if (opts.onProgress) {
          const progress: PackageProgress = {
            processedFiles,
            totalFiles: fileCount,
            percentage: Math.floor((processedFiles / fileCount) * 100),
            currentFile: fileItem.path,
            currentFileProgress: 0
          };
          opts.onProgress(progress);
        }
        
        // 检查文件名是否存在
        let destFileName = fileItem.name;
        if (fileNameMap.has(destFileName)) {
          // 文件名冲突，添加计数后缀
          const count = fileNameMap.get(destFileName)! + 1;
          fileNameMap.set(destFileName, count);
          
          // 保存原始文件名
          if (!fileItem.originalName) {
            fileItem.originalName = fileItem.name;
          }
          
          // 分解文件名和扩展名
          const extIndex = destFileName.lastIndexOf('.');
          if (extIndex > 0) {
            // 有扩展名
            const baseName = destFileName.substring(0, extIndex);
            const extension = destFileName.substring(extIndex);
            destFileName = `${baseName}_${count}${extension}`;
          } else {
            // 无扩展名
            destFileName = `${destFileName}_${count}`;
          }
          
          // 更新文件名
          fileItem.name = destFileName;
          
          warnings.push(`文件名冲突: "${fileItem.originalName}" 已重命名为 "${destFileName}"`);
        } else {
          // 记录文件名
          fileNameMap.set(destFileName, 0);
        }
        
        let sourcePath = fileItem.path;
        // 处理压缩包内文件
        if (fileItem.origin === 'archive' && fileItem.archivePath && fileItem.internalPath) {
          try {
            const extractDir = path.join(opts.tempDir || 'temp', `extract_${Date.now()}`);
            await fs.promises.mkdir(extractDir, { recursive: true });
            
            // 这里需要实现从压缩包中提取文件的逻辑
            // 临时跳过这部分实现，只做路径检查
            try {
              await fs.promises.access(sourcePath);
            } catch (error: any) {
              throw new Error(`从压缩包提取文件时出错: ${error.message}`);
            }
          } catch (error: any) {
            throw new Error(`处理压缩包文件时出错: ${error.message}`);
          }
        }
        
        // 复制文件到临时目录
        const destPath = path.join(packageTempDir, destFileName);
        await fs.promises.copyFile(sourcePath, destPath);
        
        // 更新进度和记录成功文件
        processedFiles++;
        successFiles.push({...fileItem});
        
      } catch (error: any) {
        errors.push({
          file: fileItem,
          error: error instanceof Error ? error : new Error(error.message || String(error))
        });
      }
    }
    
    // 确保至少有一个文件要打包，或者是空文件列表的特殊情况
    if (successFiles.length === 0 && fileItems.length > 0) {
      // 即使所有文件都失败了，我们仍然创建一个只包含元数据的ZIP包
      warnings.push('所有文件处理失败: 只创建包含元数据的ZIP');
    }
    
    // 如果是空文件列表，添加一个警告
    if (fileItems.length === 0) {
      warnings.push('空文件列表: 只创建包含元数据的ZIP');
    }
    
    // 创建元数据
    if (opts.includeMetadata) {
      const metadataPath = path.join(packageTempDir, opts.metadataFileName || 'metadata.json');
      
      // 准备元数据内容
      const metadataContent: any = {
        version: opts.metadataVersion || '1.0',
        packagedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        tags: opts.packageTags || [],
        enhancedMetadata: opts.enhancedMetadata || false,
        files: []
      };
      
      // 添加增强元数据的特殊字段
      if (opts.enhancedMetadata) {
        metadataContent.packageId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        metadataContent.checksumAlgorithm = 'md5';
      }
      
      // 只包含成功的文件在元数据中
      if (opts.enhancedMetadata) {
        metadataContent.files = successFiles.map(item => serializeFileItem(item));
      } else {
        // 否则只包含基本信息
        metadataContent.files = successFiles.map(item => ({
          name: item.name,
          originalName: item.originalName,
          size: item.size,
          md5: item.md5
        }));
      }
      
      // 添加错误信息到元数据
      if (errors.length > 0) {
        metadataContent.errors = errors.map(err => ({
          file: err.file.name,
          error: err.error.message
        }));
      }
      
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadataContent, null, 2));
    }
    
    // 确保输出目录存在
    await fs.ensureDir(path.dirname(outputPath));
    
    // 压缩打包
    await zip.compressDir(packageTempDir, outputPath, {
      level: opts.compressionLevel || 6,
      ignoreBase: true
    });
    
    // 最终进度回调
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: fileCount,
        totalFiles: fileCount,
        percentage: 100,
        currentFile: '',
        currentFileProgress: 100
      });
    }
    
    return {
      success: true, // 即使有错误，也返回true，错误会记录在errors中
      packagePath: outputPath,
      outputPath,
      fileCount: processedFiles,
      errors,
      warnings,
      packagedAt: startTime,
      duration: new Date().getTime() - startTime.getTime()
    };
    
  } catch (error: any) {
    return {
      success: false,
      packagePath: '',
      outputPath: '',
      fileCount: 0,
      errors,
      error: error instanceof Error ? error : new Error(error.message || String(error)),
      warnings,
      packagedAt: startTime,
      duration: new Date().getTime() - startTime.getTime()
    };
  } finally {
    // 清理临时目录
    try {
      await fs.promises.rm(packageTempDir, { recursive: true, force: true });
    } catch (error: any) {
      console.error(`清理临时目录时出错: ${error.message}`);
    }
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