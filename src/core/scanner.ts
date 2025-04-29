/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as compressing from 'compressing';
import * as stream from 'stream';
import { createExtractorFromFile } from 'node-unrar-js';
import { FileItem, FailureItem, ScanProgress } from '../types';
import { ScanOptions, ScanResult } from '../types/scanner'; // 导入新的接口定义

/** 预处理后的匹配规则 */
interface ProcessedRule {
  extensions: Set<string>;
  nameRegex: RegExp;
}

// 定义支持扫描的压缩包后缀
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.tar.gz', '.rar']);

/**
 * 检查文件是否为压缩文件
 */
function isArchiveFile(fileName: string): boolean {
  const fileExt = path.extname(fileName).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(fileExt);
}

/**
 * 扫描文件
 * @param options 扫描选项
 * @returns 包含成功结果和失败列表的对象
 */
export async function scanFiles(options: ScanOptions): Promise<ScanResult> {
  // 记录开始时间
  const startTime = new Date();
  
  const {
    rootDir,
    matchRules,
    depth = -1,
    maxFileSize = 500 * 1024 * 1024,
    skipDirs = [],
    scanNestedArchives = true,
    maxNestedLevel = 5,
    taskId,
    onProgress,
    onFileMatched,
    onFailure
  } = options;

  // 生成扫描ID (基于时间戳)
  const scanId = `scan_${startTime.getTime()}`;

  const matchedFiles: FileItem[] = [];
  const failures: FailureItem[] = [];
  // 记录处理过的压缩文件以避免重复处理
  const processedArchives = new Set<string>();

  const processedRules: ProcessedRule[] = matchRules.map(([extensions, namePattern]) => {
    const normalizedExtensions = extensions.map((ext) =>
      ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()
    );
    return {
      extensions: new Set(normalizedExtensions),
      nameRegex: new RegExp(namePattern),
    };
  });

  const normalizedSkipDirs = skipDirs.map((dir) =>
    path.normalize(dir).toLowerCase()
  );

  const progress: ScanProgress = {
    currentDir: '',
    scannedFiles: 0,
    scannedDirs: 0,
    archivesScanned: 0, 
    matchedFiles: 0,
    ignoredLargeFiles: 0,
    skippedDirs: 0,
    nestedArchivesScanned: 0,
    currentNestedLevel: 0
  };

  function shouldSkipDirectory(dirPath: string): boolean {
    const relativePath = path.relative(rootDir, dirPath);
    if (!relativePath) return false;
    const normalizedPath = path.normalize(relativePath).toLowerCase();
    return normalizedSkipDirs.some((skipDir) => {
      if (normalizedPath === skipDir) return true;
      if (normalizedPath.startsWith(skipDir + path.sep)) return true;
      return false;
    });
  }

  /**
   * 构建嵌套路径
   */
  function buildNestedPath(parentPath: string, currentPath: string): string {
    if (!parentPath) return currentPath;
    return parentPath + '/' + currentPath;
  }

  /**
   * 处理嵌套压缩文件
   * 采用流式处理方式
   */
  async function handleNestedArchive(
    entryStream: NodeJS.ReadableStream,
    nestedFileName: string,
    parentPath: string,
    currentNestedLevel: number,
    archiveCreateTime: Date,
    archiveModifyTime: Date
  ): Promise<void> {
    if (currentNestedLevel >= maxNestedLevel) {
      entryStream.resume(); // 忽略此内容，但需要消费流
      return;
    }

    progress.nestedArchivesScanned = (progress.nestedArchivesScanned || 0) + 1;
    
    // 创建内存缓冲区保存嵌套压缩文件内容
    const chunks: Buffer[] = [];
    
    try {
      // 采集流中的数据
      await new Promise<void>((resolve, reject) => {
        entryStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        entryStream.on('end', () => resolve());
        entryStream.on('error', (err) => reject(err));
      });
      
      const nestedBuffer = Buffer.concat(chunks);
      const fileExt = path.extname(nestedFileName).toLowerCase();
      const nestedArchiveName = path.basename(nestedFileName);
      
      // 构建嵌套路径
      const nestedPath = buildNestedPath(parentPath, nestedArchiveName);
      
      // 基于文件类型选择合适的处理函数
      if (fileExt === '.rar') {
        // 创建临时文件处理RAR，因为node-unrar-js需要文件路径
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-rar-'));
        const tempFile = path.join(tempDir, nestedArchiveName);
        
        try {
          await fs.writeFile(tempFile, nestedBuffer);
          await scanRarArchive(
            tempFile, 
            archiveCreateTime, 
            archiveModifyTime, 
            currentNestedLevel + 1,
            nestedPath
          );
        } catch (error: any) {
          const failureItem: FailureItem = { 
            type: 'nestedArchive', 
            path: tempFile, 
            error: `[嵌套RAR] 处理嵌套RAR出错: ${error?.message || error}`,
            nestedLevel: currentNestedLevel 
          };
          failures.push(failureItem);
          console.warn(failureItem.error);
          
          // 调用失败回调
          if (onFailure) {
            onFailure(failureItem, { ...progress });
          }
        } finally {
          // 清理临时文件
          try {
            await fs.remove(tempDir);
          } catch (e) { 
            // 忽略清理错误
          }
        }
      } else if (fileExt === '.zip' || fileExt === '.tar' || fileExt === '.tgz') {
        // 使用内存缓冲区直接创建解压流
        const memoryStream = new stream.Readable();
        memoryStream.push(nestedBuffer);
        memoryStream.push(null);
        
        try {
          await scanCompressingArchiveFromStream(
            memoryStream,
            fileExt,
            nestedArchiveName,
            archiveCreateTime,
            archiveModifyTime,
            currentNestedLevel + 1,
            nestedPath
          );
        } catch (error: any) {
          const failureItem: FailureItem = { 
            type: 'nestedArchive', 
            path: nestedFileName, 
            error: `[嵌套压缩包] 处理嵌套压缩包出错: ${nestedFileName}: ${error?.message || error}`,
            nestedLevel: currentNestedLevel 
          };
          failures.push(failureItem);
          console.warn(failureItem.error);
          
          // 调用失败回调
          if (onFailure) {
            onFailure(failureItem, { ...progress });
          }
        }
      }
    } catch (error: any) {
      const failureItem: FailureItem = { 
        type: 'nestedArchive', 
        path: nestedFileName, 
        error: `[嵌套处理] 流处理错误: ${nestedFileName}: ${error?.message || error}`,
        nestedLevel: currentNestedLevel 
      };
      failures.push(failureItem);
      console.warn(failureItem.error);
      
      // 调用失败回调
      if (onFailure) {
        onFailure(failureItem, { ...progress });
      }
    }
  }

  /**
   * 从流扫描压缩包 (用于嵌套压缩包)
   */
  async function scanCompressingArchiveFromStream(
    inputStream: NodeJS.ReadableStream,
    fileExt: string,
    archiveName: string,
    archiveCreateTime: Date,
    archiveModifyTime: Date,
    currentNestedLevel: number,
    parentPath: string = ''
  ): Promise<void> {
    // 对于内存流，使用文件名和路径来避免重复处理
    const identifier = parentPath ? `${parentPath}/${archiveName}` : archiveName;
    const normalizedIdentifier = identifier.replace(/\/\//g, '/'); // 规范化路径
    
    if (processedArchives.has(normalizedIdentifier)) {
      return; // 已处理过，直接返回
    }
    processedArchives.add(normalizedIdentifier); // 记录为已处理
    
    let StreamType: any;
    const isTgz = fileExt === '.tgz' || archiveName.toLowerCase().endsWith('.tar.gz');

    if (fileExt === '.zip') {
      StreamType = compressing.zip.UncompressStream;
    } else if (fileExt === '.tar' || isTgz) {
      StreamType = isTgz ? compressing.tgz.UncompressStream : compressing.tar.UncompressStream;
    } else {
      throw new Error(`不支持的压缩包类型: ${fileExt}`);
    }

    const stream = new StreamType();
    inputStream.pipe(stream);
    
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.on('entry', async (
        header: { name: string; type: 'file' | 'directory', size?: number }, 
        entryStream: NodeJS.ReadableStream, 
        next: () => void
      ) => {
        try {
          if (header.type === 'file') {
            const internalPath = header.name;
            const internalName = path.basename(internalPath);
            const internalExt = path.extname(internalName).toLowerCase();
            
            // 当前层级的实际嵌套路径
            const currentNestedPath = buildNestedPath(parentPath, internalPath);
            
            // 检查是否是嵌套压缩文件
            if (scanNestedArchives && isArchiveFile(internalName) && currentNestedLevel < maxNestedLevel) {
              // 处理嵌套压缩文件
              await handleNestedArchive(
                entryStream, 
                internalName, 
                parentPath ? parentPath : path.dirname(internalPath), 
                currentNestedLevel,
                archiveCreateTime,
                archiveModifyTime
              );
              next();
              return;
            }
            
            // 常规文件匹配处理
            let isMatch = false;
            for (const rule of processedRules) {
              if (rule.extensions.has(internalExt) && rule.nameRegex.test(internalName)) {
                isMatch = true;
                break;
              }
            }
            
            if (isMatch) {
              const internalSize = header.size ?? 0; 
              if (internalSize <= maxFileSize) {
                const fileItem: FileItem = {
                  path: archiveName, // 由于是内存流，使用名称而非路径
                  name: internalName,
                  createTime: archiveCreateTime,
                  modifyTime: archiveModifyTime,
                  size: internalSize,
                  origin: 'archive',
                  archivePath: archiveName,
                  internalPath: internalPath,
                  nestedLevel: currentNestedLevel,
                  nestedPath: currentNestedPath
                };
                matchedFiles.push(fileItem);
                progress.matchedFiles++;
                
                // 更新进度
                if (onProgress) {
                  progress.currentNestedLevel = currentNestedLevel;
                  onProgress({ ...progress });
                }
                
                // 调用文件匹配回调
                if (onFileMatched) {
                  onFileMatched(fileItem, { ...progress });
                }
              } else {
                progress.ignoredLargeFiles++;
                // 添加被忽略的大文件到失败列表
                const failureItem: FailureItem = {
                  type: 'ignoredLargeFile',
                  path: archiveName,
                  entryPath: internalPath,
                  error: `文件大小(${internalSize})超过最大限制(${maxFileSize})`,
                  nestedLevel: currentNestedLevel
                };
                failures.push(failureItem);
                
                // 调用失败回调
                if (onFailure) {
                  onFailure(failureItem, { ...progress });
                }
              }
            }
          }
          
          entryStream.resume();
          next();
        } catch (error: any) {
          const failureItem: FailureItem = {
            type: 'archiveEntry',
            path: archiveName,
            entryPath: header.name,
            error: `[嵌套扫描] 处理嵌套压缩包内文件出错: ${error?.message || error}`,
            nestedLevel: currentNestedLevel
          };
          failures.push(failureItem);
          console.warn(failureItem.error);
          
          // 调用失败回调
          if (onFailure) {
            onFailure(failureItem, { ...progress });
          }
          
          entryStream.resume();
          next();
        }
      });
    });
  }

  /**
   * 扫描 ZIP/TAR/TGZ 压缩包内部 (使用 compressing)
   */
  async function scanCompressingArchive(
    archivePath: string,
    archiveCreateTime: Date,
    archiveModifyTime: Date,
    currentNestedLevel: number = 0,
    parentPath: string = ''
  ): Promise<void> {
    // 检查是否已处理过该压缩文件
    const normalizedPath = path.normalize(archivePath);
    if (processedArchives.has(normalizedPath)) {
      return; // 已处理过，直接返回
    }
    processedArchives.add(normalizedPath); // 记录为已处理
    
    progress.archivesScanned++;

    let StreamType: any;
    const ext = path.extname(archivePath).toLowerCase();
    const isTgz = ext === '.tgz' || archivePath.toLowerCase().endsWith('.tar.gz');

    if (ext === '.zip') {
      StreamType = compressing.zip.UncompressStream;
    } else if (ext === '.tar' || isTgz) {
      StreamType = isTgz ? compressing.tgz.UncompressStream : compressing.tar.UncompressStream;
    } else {
      const failureItem: FailureItem = { 
        type: 'archiveOpen', 
        path: archivePath, 
        error: `[compressing] 不支持的压缩包类型: ${archivePath}`,
        nestedLevel: currentNestedLevel 
      };
      failures.push(failureItem);
      console.warn(failureItem.error);
      
      // 调用失败回调
      if (onFailure) {
        onFailure(failureItem, { ...progress });
      }
      return;
    }

    if (!StreamType) {
      const failureItem: FailureItem = { 
        type: 'archiveOpen', 
        path: archivePath, 
        error: `[compressing] 无法找到解压流类型: ${ext}`,
        nestedLevel: currentNestedLevel 
      };
      failures.push(failureItem);
      console.warn(failureItem.error);
      
      // 调用失败回调
      if (onFailure) {
        onFailure(failureItem, { ...progress });
      }
      return;
    }
    
    try {
      const stream = new StreamType({ source: archivePath });
      
      await new Promise<void>((resolve, reject) => {
        stream.on('error', (err: Error) => {
          const failureItem: FailureItem = { 
            type: 'archiveOpen', 
            path: archivePath, 
            error: `[compressing] 读取压缩包时出错 ${archivePath}: ${err.message}`,
            nestedLevel: currentNestedLevel 
          };
          failures.push(failureItem);
          console.warn(failureItem.error);
          
          // 调用失败回调
          if (onFailure) {
            onFailure(failureItem, { ...progress });
          }
          
          reject(err);
        });
        stream.on('finish', resolve);
        stream.on('entry', async (
          header: { name: string; type: 'file' | 'directory', size?: number }, 
          entryStream: NodeJS.ReadableStream, 
          next: () => void
        ) => {
          try {
            if (header.type === 'file') {
              const internalPath = header.name;
              const internalName = path.basename(internalPath);
              const internalExt = path.extname(internalName).toLowerCase();
              
              // 构建嵌套路径 (如果是嵌套压缩文件)
              const archiveName = path.basename(archivePath);
              const currentNestedPath = parentPath 
                ? buildNestedPath(parentPath, internalPath)
                : buildNestedPath(archiveName, internalPath);
              
              // 检查是否是嵌套压缩文件
              if (scanNestedArchives && isArchiveFile(internalName) && currentNestedLevel < maxNestedLevel) {
                // 处理嵌套压缩文件
                await handleNestedArchive(
                  entryStream, 
                  internalName, 
                  parentPath ? parentPath : archiveName, 
                  currentNestedLevel,
                  archiveCreateTime,
                  archiveModifyTime
                );
                next();
                return;
              }
              
              // 常规文件匹配处理
              let isMatch = false;
              for (const rule of processedRules) {
                if (rule.extensions.has(internalExt) && rule.nameRegex.test(internalName)) {
                  isMatch = true;
                  break;
                }
              }
              
              if (isMatch) {
                // 修复：检查压缩包内文件大小
                const internalSize = header.size ?? 0; 
                
                // 重要修改：只处理满足大小限制的文件
                if (internalSize <= maxFileSize) {
                  const fileItem: FileItem = {
                    path: archivePath,
                    name: internalName,
                    createTime: archiveCreateTime,
                    modifyTime: archiveModifyTime,
                    size: internalSize,
                    origin: 'archive',
                    archivePath: archivePath,
                    internalPath: internalPath,
                    nestedLevel: currentNestedLevel,
                    nestedPath: currentNestedPath
                  };
                  matchedFiles.push(fileItem);
                  progress.matchedFiles++;
                  
                  // 更新进度
                  if (onProgress) {
                    progress.currentNestedLevel = currentNestedLevel;
                    onProgress({ ...progress });
                  }
                  
                  // 调用文件匹配回调
                  if (onFileMatched) {
                    onFileMatched(fileItem, { ...progress });
                  }
                } else {
                  progress.ignoredLargeFiles++;
                  // 添加被忽略的大文件到失败列表
                  const failureItem: FailureItem = {
                    type: 'ignoredLargeFile',
                    path: archivePath,
                    entryPath: internalPath,
                    error: `文件大小(${internalSize})超过最大限制(${maxFileSize})`,
                    nestedLevel: currentNestedLevel
                  };
                  failures.push(failureItem);
                  
                  // 调用失败回调
                  if (onFailure) {
                    onFailure(failureItem, { ...progress });
                  }
                }
              }
            }
            entryStream.resume(); 
            next();
          } catch (entryError: any) {
            const failureItem: FailureItem = {
              type: 'archiveEntry',
              path: archivePath,
              entryPath: header.name,
              error: `[compressing] 处理条目时出错 ${archivePath} > ${header.name}: ${entryError?.message || entryError}`,
              nestedLevel: currentNestedLevel
            };
            failures.push(failureItem);
            console.warn(failureItem.error);
            
            // 调用失败回调
            if (onFailure) {
              onFailure(failureItem, { ...progress });
            }
            
            entryStream.resume(); 
            next();
          }
        });
      });
    } catch (archiveError: any) {
      // 这个 catch 主要处理 stream.on('error') reject 的情况，以及 new StreamType 可能的同步错误
      // 错误已经在 stream.on('error') 中记录到 failures
      // 如果是 new StreamType 的错误，需要在这里记录
      if (!failures.some(f => f.path === archivePath && f.type === 'archiveOpen')) {
        const failureItem: FailureItem = {
          type: 'archiveOpen',
          path: archivePath,
          error: `[compressing] 无法处理压缩包 ${archivePath}: ${archiveError?.message || archiveError}`,
          nestedLevel: currentNestedLevel
        };
        failures.push(failureItem);
        console.warn(failureItem.error);
        
        // 调用失败回调
        if (onFailure) {
          onFailure(failureItem, { ...progress });
        }
      }
    }
  }

  /**
   * 扫描 RAR 压缩包内部 (使用 node-unrar-js)
   */
  async function scanRarArchive(
    archivePath: string,
    archiveCreateTime: Date,
    archiveModifyTime: Date,
    currentNestedLevel: number = 0,
    parentPath: string = ''
  ): Promise<void> {
    // 检查是否已处理过该压缩文件
    const normalizedPath = path.normalize(archivePath);
    if (processedArchives.has(normalizedPath)) {
      return; // 已处理过，直接返回
    }
    processedArchives.add(normalizedPath); // 记录为已处理
    
    progress.archivesScanned++;
    let extractor;
    try {
      // 创建提取器
      extractor = await createExtractorFromFile({ filepath: archivePath });
      // 获取文件头列表
      const list = extractor.getFileList();
      // 获取Archive名称用于构建路径
      const archiveName = path.basename(archivePath);
      
      // 遍历文件头 - 必须完整遍历以释放资源!
      for (const fileHeader of list.fileHeaders) {
        try { // 添加内层 try...catch 以捕获单个条目处理错误
          if (fileHeader.flags.directory) {
            continue; // 跳过目录
          }

          const internalPath = fileHeader.name;
          const internalName = path.basename(internalPath);
          const internalExt = path.extname(internalName).toLowerCase();
          
          // 构建嵌套路径
          const currentNestedPath = parentPath 
            ? buildNestedPath(parentPath, internalPath)
            : buildNestedPath(archiveName, internalPath);
          
          // 检查是否是嵌套压缩文件
          if (scanNestedArchives && isArchiveFile(internalName) && currentNestedLevel < maxNestedLevel) {
            try {
              // 使用不同的方式处理：先获取文件内容，然后写入临时文件
              const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-from-rar-'));
              const tempFile = path.join(tempDir, internalName);
              
              // 先找到fileHeader，然后提取
              const extractOptions = {
                files: [internalPath] // 只提取指定的文件
              };
              
              // 从RAR中提取
              const extracted = extractor.extract(extractOptions);
              
              // 创建临时文件并写入
              for await (const file of extracted.files) {
                if (file.extraction && file.fileHeader.name === internalPath) {
                  await fs.writeFile(tempFile, file.extraction);
                  
                  // 文件已提取，现在处理它
                  try {
                    // 根据扩展名选择合适的处理函数
                    if (internalExt === '.rar') {
                      await scanRarArchive(
                        tempFile,
                        archiveCreateTime,
                        archiveModifyTime,
                        currentNestedLevel + 1,
                        parentPath ? parentPath : archiveName
                      );
                    } else {
                      await scanCompressingArchive(
                        tempFile,
                        archiveCreateTime,
                        archiveModifyTime,
                        currentNestedLevel + 1,
                        parentPath ? parentPath : archiveName
                      );
                    }
                  } finally {
                    // 清理临时文件
                    try {
                      await fs.remove(tempDir);
                    } catch (e) {
                      // 忽略清理错误
                    }
                  }
                }
              }
            } catch (nestedError: any) {
              const failureItem: FailureItem = {
                type: 'nestedArchive',
                path: archivePath,
                entryPath: internalPath,
                error: `[RAR嵌套] 处理嵌套压缩文件出错 ${archivePath} > ${internalName}: ${nestedError?.message || nestedError}`,
                nestedLevel: currentNestedLevel
              };
              failures.push(failureItem);
              console.warn(failureItem.error);
              
              // 调用失败回调
              if (onFailure) {
                onFailure(failureItem, { ...progress });
              }
            }
            continue; // 已处理嵌套压缩文件，跳过常规处理
          }
            
          // 常规文件匹配逻辑
          let isMatch = false;
          for (const rule of processedRules) {
            if (rule.extensions.has(internalExt) && rule.nameRegex.test(internalName)) {
              isMatch = true;
              break;
            }
          }

          if (isMatch) {
            const internalSize = fileHeader.unpSize;
            if (internalSize <= maxFileSize) {
              const fileItem: FileItem = {
                path: archivePath,
                name: internalName,
                createTime: archiveCreateTime,
                modifyTime: archiveModifyTime,
                size: internalSize,
                origin: 'archive',
                archivePath: archivePath,
                internalPath: internalPath,
                nestedLevel: currentNestedLevel,
                nestedPath: currentNestedPath
              };
              matchedFiles.push(fileItem);
              progress.matchedFiles++;
              
              // 更新进度
              if (onProgress) {
                progress.currentNestedLevel = currentNestedLevel;
                onProgress({ ...progress });
              }
              
              // 调用文件匹配回调
              if (onFileMatched) {
                onFileMatched(fileItem, { ...progress });
              }
            } else {
              progress.ignoredLargeFiles++;
              // 添加被忽略的大文件到失败列表
              const failureItem: FailureItem = {
                type: 'ignoredLargeFile',
                path: archivePath,
                entryPath: internalPath,
                error: `文件大小(${internalSize})超过最大限制(${maxFileSize})`,
                nestedLevel: currentNestedLevel
              };
              failures.push(failureItem);
              
              // 调用失败回调
              if (onFailure) {
                onFailure(failureItem, { ...progress });
              }
            } 
          }
        } catch (entryError: any) { 
          const failureItem: FailureItem = { 
            type: 'archiveEntry', 
            path: archivePath, 
            entryPath: fileHeader?.name, 
            error: `[unrar] 处理条目时出错 ${archivePath} > ${fileHeader?.name}: ${entryError?.message || entryError}`,
            nestedLevel: currentNestedLevel
          };
          failures.push(failureItem);
          console.warn(failureItem.error);
          
          // 调用失败回调
          if (onFailure) {
            onFailure(failureItem, { ...progress });
          }
          // 继续处理下一个条目
        }
      }
      
    } catch (error: any) {
      const failureItem: FailureItem = { 
        type: 'rarOpen', 
        path: archivePath, 
        error: `[unrar] 处理 RAR 压缩包时出错 ${archivePath}: ${error.message || error}`,
        nestedLevel: currentNestedLevel
      };
      failures.push(failureItem);
      console.warn(failureItem.error);
      
      // 调用失败回调
      if (onFailure) {
        onFailure(failureItem, { ...progress });
      }
    } 
    // 不需要手动关闭 extractor，迭代器完成时资源会自动处理
  }

  async function scanDirectory(
    currentDir: string,
    currentDepth: number
  ): Promise<void> {
    if (depth !== -1 && currentDepth > depth) {
      return;
    }

    try {
      progress.currentDir = currentDir;
      if (shouldSkipDirectory(currentDir)) {
        progress.skippedDirs++;
        if (onProgress) onProgress({ ...progress });
        return;
      }

      progress.scannedDirs++;
      if (onProgress) onProgress({ ...progress });

      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, currentDepth + 1);
        } else if (entry.isFile()) {
          const fileExt = path.extname(entry.name).toLowerCase();
          
          // 检查是否是支持的压缩包
          if (ARCHIVE_EXTENSIONS.has(fileExt)) {
             try {
                const stats = await fs.stat(fullPath);
              
              // 检查压缩包大小是否超过限制
              if (stats.size > maxFileSize) {
                progress.ignoredLargeFiles++;
                // 添加被忽略的大压缩包到失败列表
                const failureItem: FailureItem = {
                  type: 'ignoredLargeFile',
                  path: fullPath,
                  error: `压缩包大小(${stats.size})超过最大限制(${maxFileSize})，跳过检测内部文件`,
                };
                failures.push(failureItem);
                
                // 调用失败回调
                if (onFailure) {
                  onFailure(failureItem, { ...progress });
                }
                continue; // 跳过此压缩包的进一步处理
              } else {
                // 根据类型调用不同的处理函数
                if (fileExt === '.rar') {
                    await scanRarArchive(fullPath, stats.birthtime, stats.mtime);
                } else {
                    await scanCompressingArchive(fullPath, stats.birthtime, stats.mtime);
                }
                }
            } catch (statError: any) {
              const failureItem: FailureItem = { 
                type: 'fileStat', 
                path: fullPath, 
                error: `无法获取压缩包状态: ${fullPath}: ${statError?.message || statError}`
              };
              failures.push(failureItem);
              console.warn(failureItem.error);
              
              // 调用失败回调
              if (onFailure) {
                onFailure(failureItem, { ...progress });
              }
            }
            continue; // 跳过后续的常规文件处理
          } else {
             // 常规文件处理逻辑
             progress.scannedFiles++;
             let isMatch = false;
             for (const rule of processedRules) {
              if (rule.extensions.has(fileExt) && rule.nameRegex.test(entry.name)) {
                isMatch = true;
                break;
              }
            }
            if (isMatch) {
              try {
                const stats = await fs.stat(fullPath);
                if (stats.size <= maxFileSize) {
                  const fileItem: FileItem = {
                    path: fullPath,
                    name: entry.name,
                    createTime: stats.birthtime,
                    modifyTime: stats.mtime,
                    size: stats.size,
                    origin: 'filesystem',
                    nestedLevel: 0, // 文件系统文件，非嵌套
                  };
                  matchedFiles.push(fileItem);
                  progress.matchedFiles++;
                  
                  // 更新进度
                  if (onProgress) {
                    onProgress({ ...progress });
                  }
                  
                  // 调用文件匹配回调
                  if (onFileMatched) {
                    onFileMatched(fileItem, { ...progress });
                  }
                } else {
                  progress.ignoredLargeFiles++;
                  // 添加被忽略的大文件到失败列表
                  const failureItem: FailureItem = {
                    type: 'ignoredLargeFile',
                    path: fullPath,
                    error: `文件大小(${stats.size})超过最大限制(${maxFileSize})`,
                  };
                  failures.push(failureItem);
                  
                  // 调用失败回调
                  if (onFailure) {
                    onFailure(failureItem, { ...progress });
                  }
                }
              } catch (statError: any) {
                const failureItem: FailureItem = { 
                  type: 'fileStat', 
                  path: fullPath, 
                  error: `无法获取文件状态: ${fullPath}: ${statError?.message || statError}`
                };
                failures.push(failureItem);
                console.warn(failureItem.error);
                
                // 调用失败回调
                if (onFailure) {
                  onFailure(failureItem, { ...progress });
                }
                }
              }
          }
              }
      }
          } catch (error: any) {
      const failureItem: FailureItem = { 
        type: 'directoryAccess', 
        path: currentDir, 
        error: `无法访问目录: ${currentDir}: ${error?.message || error}`
      };
      failures.push(failureItem);
      console.warn(failureItem.error);
      
      // 调用失败回调
      if (onFailure) {
        onFailure(failureItem, { ...progress });
      }
    }
  }

  try {
    // 扫描根目录
    await scanDirectory(rootDir, 0);
  } catch (error: any) {
    const failureItem: FailureItem = {
      type: 'scanError',
      path: rootDir,
      error: error?.message || 'Unknown error',
    };
    failures.push(failureItem);
    
    // 调用失败回调
    if (onFailure) {
      onFailure(failureItem, { ...progress });
  }
  }

  // 记录结束时间
  const endTime = new Date();
  const elapsedTimeMs = endTime.getTime() - startTime.getTime();

  // 返回扫描结果
  return {
    matchedFiles,
    failures,
    stats: {
      totalScanned: progress.scannedFiles,
      totalMatched: progress.matchedFiles,
      totalFailures: failures.length,
      archivesScanned: progress.archivesScanned,
      nestedArchivesScanned: progress.nestedArchivesScanned || 0
    },
    taskId,
    scanId,
    startTime,
    endTime,
    elapsedTimeMs
  };
} 