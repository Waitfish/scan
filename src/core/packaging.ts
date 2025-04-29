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

    // === 新的文件名冲突处理逻辑 ===
    const usedTargetNames = new Set<string>(); // 用于跟踪最终使用的目标文件名

    for (const fileItem of fileItems) {
      // 1. 无条件填充 originalName (如果尚未填充)
      // 假设 fileItem.path 总是可用
      if (!fileItem.originalName) {
        // fileItem.originalName = path.basename(fileItem.path); // <-- 旧逻辑，从路径推断，可能导致不准确
        fileItem.originalName = fileItem.name || path.basename(fileItem.path); // <-- 新逻辑，优先使用 name
      }
      // 确保 name 字段也已初始化
      if (fileItem.name === undefined || fileItem.name === null) {
        fileItem.name = fileItem.originalName;
      }

      let currentName = fileItem.name;

      if (!usedTargetNames.has(currentName)) {
        // 没有冲突，将当前 name 加入已使用集合
        usedTargetNames.add(currentName);
      } else {
        // 发生冲突，需要基于 originalName 生成新 name
        // const originalBase = path.basename(fileItem.originalName, path.extname(fileItem.originalName)); // <-- 旧逻辑
        // const extension = path.extname(fileItem.originalName);
        // --- 新逻辑：基于冲突的 currentName 生成 --- 
        const conflictingBase = path.basename(currentName, path.extname(currentName));
        const extension = path.extname(currentName);
        // --- 结束新逻辑 ---
        let counter = 1;
        // let newName = `${originalBase}-${counter}${extension}`; // <-- 旧逻辑
        let newName = `${conflictingBase}-${counter}${extension}`; // <-- 新逻辑
        
        // 循环查找未被使用的名称
        while (usedTargetNames.has(newName)) {
          counter++;
          // newName = `${originalBase}-${counter}${extension}`; // <-- 旧逻辑
          newName = `${conflictingBase}-${counter}${extension}`; // <-- 新逻辑
        }

        // 记录警告 (警告信息仍使用 originalName 比较好，以指明是哪个原始文件冲突了)
        warnings.push(`文件名冲突: "${fileItem.originalName}" (目标名 "${currentName}") 已重命名为 "${newName}"`); // 调整警告信息更清晰

        // 更新 FileItem 的 name 字段
        fileItem.name = newName;
        // 将新生成的、唯一的 name 加入已使用集合
        usedTargetNames.add(newName);
      }
    }
    // === 文件名冲突处理逻辑结束 ===

    // 处理文件 (复制到临时目录)
    for (const fileItem of fileItems) {
      try {
        if (opts.onProgress) {
          const progress: PackageProgress = {
            processedFiles,
            totalFiles: fileCount,
            percentage: Math.floor((processedFiles / fileCount) * 100),
            currentFile: fileItem.path, // 显示原始路径更有意义
            currentFileProgress: 0
          };
          opts.onProgress(progress);
        }

        let sourcePath = fileItem.path;

        // 处理压缩包内文件 (如果需要提取)
        if (fileItem.origin === 'archive' && fileItem.archivePath && fileItem.internalPath) {
          // TODO: 实现从压缩包提取文件的逻辑，如果需要的话
          // 这里假设 sourcePath 已经指向了解压后的临时文件路径，或者需要在这里处理提取
          // 为了简化，暂时假设 sourcePath 是有效的，如果需要实际提取，这里需要补充代码
          try {
            await fs.promises.access(sourcePath);
          } catch (accessError: any) {
             // 如果路径无效，则尝试从 archivePath 提取 internalPath 到临时位置
             // 这部分逻辑需要根据具体实现添加
            throw new Error(`处理压缩包内文件失败: 无法访问源路径 ${sourcePath} 或未实现提取逻辑。`);
          }
        }

        // 检查源文件是否存在 (防御性编程)
        if (!await fs.pathExists(sourcePath)) {
            throw new Error(`源文件不存在: ${sourcePath}`);
        }

        // 复制文件到临时目录，使用最终确定的 fileItem.name
        const destPath = path.join(packageTempDir, fileItem.name);
        await fs.promises.copyFile(sourcePath, destPath);

        // 更新进度和记录成功文件 (只记录元数据所需信息)
        processedFiles++;
        successFiles.push({...fileItem}); // 存储处理后的FileItem，包含更新后的name和originalName

        // 单个文件处理完成后的进度回调 (可选)
        if (opts.onProgress) {
            opts.onProgress({
                processedFiles,
                totalFiles: fileCount,
                percentage: Math.floor((processedFiles / fileCount) * 100),
                currentFile: fileItem.path,
                currentFileProgress: 100 // 假设复制完成代表100%
            });
        }

      } catch (error: any) {
        errors.push({
          file: fileItem, // 记录原始的 fileItem 信息
          error: error instanceof Error ? error : new Error(error.message || String(error))
        });
        // 即使出错，也更新总进度计数，避免百分比卡住
        processedFiles++;
        if (opts.onProgress) {
            opts.onProgress({
                processedFiles,
                totalFiles: fileCount,
                percentage: Math.floor((processedFiles / fileCount) * 100),
                currentFile: fileItem.path,
                currentFileProgress: 100 // 标记为完成（即使是失败）
            });
        }
      }
    }

    // 确保至少有一个文件成功处理，或者明确是空列表的情况
    if (successFiles.length === 0 && fileItems.length > 0) {
      warnings.push('所有文件处理失败，但仍将创建包含元数据的ZIP包');
    } else if (fileItems.length === 0) {
      warnings.push('空文件列表，创建只包含元数据的ZIP包');
    }

    // 创建元数据
    if (opts.includeMetadata) {
      const metadataPath = path.join(packageTempDir, opts.metadataFileName || 'metadata.json');

      // 序列化成功的文件列表 (使用处理后的 fileItem)
      const serializedFiles = successFiles.map(item => serializeFileItem(item));

      // 创建元数据对象
      const metadata: PackageMetadata = {
        createdAt: startTime.toISOString(), // 使用打包开始时间
        files: serializedFiles
      };

      // 添加增强元数据字段
      if (opts.enhancedMetadata) {
        metadata.version = opts.metadataVersion || '1.0';
        metadata.packageId = `pkg_${startTime.getTime()}_${Math.random().toString(36).substring(2, 10)}`;
        metadata.tags = opts.packageTags || [];
        metadata.checksumAlgorithm = opts.includeMd5 ? 'md5' : undefined; // 根据选项决定
      }

      // 添加错误信息到元数据
      if (errors.length > 0) {
        metadata.errors = errors.map(err => ({
          // 调整为符合 ErrorMetadata 的结构 (假设需要 file 和 error)
          file: err.file.name, // 使用处理后的文件名
          error: err.error.message,
          // 可以选择性地添加其他信息
          path: err.file.path,
          originalName: err.file.originalName
        }));
      }

      // 添加警告信息到元数据 (可选, 假设类型已添加)
      if (warnings.length > 0) {
          (metadata as any).warnings = warnings; // 临时使用 any, 等待类型更新
      }

      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    }

    // 确保输出目录存在
    await fs.ensureDir(path.dirname(outputPath));

    // 压缩打包 (只压缩临时目录中的内容)
    await zip.compressDir(packageTempDir, outputPath, {
      level: opts.compressionLevel ?? 6,
      ignoreBase: true
    });

    // 最终进度回调 (确保总是100%)
    if (opts.onProgress) {
      opts.onProgress({
        processedFiles: fileCount, // 报告处理的文件总数
        totalFiles: fileCount,
        percentage: 100,
        currentFile: '',
        currentFileProgress: 100
      });
    }

    const endTime = new Date();
    return {
      success: errors.length === 0, // 仅当没有文件处理错误时才算完全成功
      packagePath: outputPath,
      outputPath,
      fileCount: successFiles.length, // 成功打包的文件数
      errors,
      warnings,
      packagedAt: startTime,
      duration: endTime.getTime() - startTime.getTime()
    };

  } catch (error: any) {
    // 捕捉创建临时目录、写入元数据、压缩等过程中的顶层错误
    const endTime = new Date();
    errors.push({ file: {} as FileItem, error: error instanceof Error ? error : new Error(String(error)) }); // 添加全局错误
    return {
      success: false,
      packagePath: '',
      outputPath: '',
      fileCount: 0,
      errors,
      // error: error instanceof Error ? error : new Error(error.message || String(error)),
      warnings,
      packagedAt: startTime,
      duration: endTime.getTime() - startTime.getTime()
    };
  } finally {
    // 清理临时目录
    try {
      await fs.promises.rm(packageTempDir, { recursive: true, force: true });
    } catch (cleanupError: any) {
      // 记录清理错误，但不影响最终结果
      console.error(`清理临时目录 ${packageTempDir} 时出错: ${cleanupError.message}`);
      // 可以考虑将清理错误添加到 warnings
      warnings.push(`清理临时目录失败: ${cleanupError.message}`);
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