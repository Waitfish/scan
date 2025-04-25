/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { createExtractorFromFile } from 'node-unrar-js'; // 导入 RAR 相关
import { FileItem, ScanOptions, ScanProgress, FailureItem, ScanResult } from '../types'; // 导入新类型

/** 预处理后的匹配规则 */
interface ProcessedRule {
  extensions: Set<string>;
  nameRegex: RegExp;
}

// 定义支持扫描的压缩包后缀 (新增 .rar)
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.tar.gz', '.rar']);

/**
 * 扫描文件
 * @param options 扫描选项
 * @returns 包含成功结果和失败列表的对象
 */
export async function scanFiles(options: ScanOptions): Promise<ScanResult> { // 更新返回类型
  const {
    rootDir,
    matchRules,
    depth = -1,
    onProgress,
    maxFileSize = 500 * 1024 * 1024,
    skipDirs = [],
  } = options;

  const results: FileItem[] = [];
  const failures: FailureItem[] = []; // 初始化失败列表

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
   * 扫描 ZIP/TAR/TGZ 压缩包内部 (使用 compressing)
   */
  async function scanCompressingArchive(
    archivePath: string,
    archiveCreateTime: Date,
    archiveModifyTime: Date
  ): Promise<void> {
    progress.archivesScanned++;

    let StreamType: any;
    const ext = path.extname(archivePath).toLowerCase();
    const isTgz = ext === '.tgz' || archivePath.toLowerCase().endsWith('.tar.gz');

    if (ext === '.zip') {
      StreamType = compressing.zip.UncompressStream;
    } else if (ext === '.tar' || isTgz) {
      StreamType = isTgz ? compressing.tgz.UncompressStream : compressing.tar.UncompressStream;
    } else {
      const message = `[compressing] 不支持的压缩包类型: ${archivePath}`;
      console.warn(message);
      failures.push({ type: 'archiveOpen', path: archivePath, error: message }); // 记录失败
      return;
    }

    if (!StreamType) {
      const message = `[compressing] 无法找到解压流类型: ${ext}`;
      console.warn(message);
      failures.push({ type: 'archiveOpen', path: archivePath, error: message }); // 记录失败
      return;
    }
    
    try {
      const stream = new StreamType({ source: archivePath });
      
      await new Promise<void>((resolve, reject) => {
        stream.on('error', (err: Error) => {
          const message = `[compressing] 读取压缩包时出错 ${archivePath}: ${err.message}`;
          console.warn(message);
          failures.push({ type: 'archiveOpen', path: archivePath, error: err.message }); // 记录失败
          reject(err); // 继续拒绝 Promise 以便外层 catch 可以捕获（虽然这里不需要外层也捕获）
        });
        stream.on('finish', resolve);
        stream.on('entry', (
          header: { name: string; type: 'file' | 'directory', size?: number }, 
          entryStream: NodeJS.ReadableStream, 
          next: () => void
        ) => {
          const processEntry = () => {
            try {
              if (header.type === 'file') {
                const internalPath = header.name;
                const internalName = path.basename(internalPath);
                const internalExt = path.extname(internalName).toLowerCase();
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
                      path: archivePath,
                      name: internalName,
                      createTime: archiveCreateTime,
                      modifyTime: archiveModifyTime,
                      size: internalSize,
                      origin: 'archive',
                      archivePath: archivePath,
                      internalPath: internalPath,
                    };
                    results.push(fileItem);
                    progress.matchedFiles++;
                    if (onProgress) {
                      onProgress({ ...progress }, fileItem);
                    }
                  } else {
                    progress.ignoredLargeFiles++;
                  }
                }
              }
              entryStream.resume(); 
              next();
            } catch (entryError: any) {
              const message = `[compressing] 处理条目时出错 ${archivePath} > ${header.name}: ${entryError?.message || entryError}`;
              console.warn(message);
              // 记录条目处理失败
              failures.push({
                type: 'archiveEntry',
                path: archivePath,
                entryPath: header.name,
                error: entryError?.message || String(entryError),
              });
              entryStream.resume(); 
              next();
            }
          };
          processEntry();
        });
      });
    } catch (archiveError: any) {
      // 这个 catch 主要处理 stream.on('error') reject 的情况，以及 new StreamType 可能的同步错误
      // 错误已经在 stream.on('error') 中记录到 failures
      // 如果是 new StreamType 的错误，需要在这里记录
      if (!failures.some(f => f.path === archivePath && f.type === 'archiveOpen')) {
        const message = `[compressing] 无法处理压缩包 ${archivePath}: ${archiveError?.message || archiveError}`;
        console.warn(message);
        failures.push({
          type: 'archiveOpen',
          path: archivePath,
          error: archiveError?.message || String(archiveError),
        });
      }
    }
  }

  /**
   * 扫描 RAR 压缩包内部 (使用 node-unrar-js)
   */
  async function scanRarArchive(
    archivePath: string,
    archiveCreateTime: Date,
    archiveModifyTime: Date
  ): Promise<void> {
    progress.archivesScanned++;
    let extractor;
    try {
      // 创建提取器
      extractor = await createExtractorFromFile({ filepath: archivePath });
      // 获取文件头列表
      const list = extractor.getFileList();
      // 遍历文件头 - 必须完整遍历以释放资源!
      for (const fileHeader of list.fileHeaders) {
         try { // 添加内层 try...catch 以捕获单个条目处理错误
            if (fileHeader.flags.directory) {
              continue; // 跳过目录
            }

            const internalPath = fileHeader.name;
            const internalName = path.basename(internalPath);
            const internalExt = path.extname(internalName).toLowerCase();
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
                };
                results.push(fileItem);
                progress.matchedFiles++;
                if (onProgress) {
                  onProgress({ ...progress }, fileItem);
                }
              } else {
                progress.ignoredLargeFiles++;
              } 
            }
        } catch (entryError: any) { 
           const message = `[unrar] 处理条目时出错 ${archivePath} > ${fileHeader?.name}: ${entryError?.message || entryError}`;
           console.warn(message);
           failures.push({ 
              type: 'archiveEntry', 
              path: archivePath, 
              entryPath: fileHeader?.name, 
              error: entryError?.message || String(entryError)
            });
           // 继续处理下一个条目
        }
      }
      // 注意：getFileList() 返回的 fileHeaders 是生成器，
      // for...of 循环会自动处理迭代器的完成和资源释放。
      // 如果使用 list.fileHeaders.next() 手动迭代，则需要确保迭代到最后。
      
    } catch (error: any) {
      const message = `[unrar] 处理 RAR 压缩包时出错 ${archivePath}: ${error.message || error}`;
      console.warn(message);
      failures.push({ type: 'rarOpen', path: archivePath, error: error.message || String(error) }); // 记录失败
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
                // 根据类型调用不同的处理函数
                if (fileExt === '.rar') {
                    await scanRarArchive(fullPath, stats.birthtime, stats.mtime);
                } else {
                    await scanCompressingArchive(fullPath, stats.birthtime, stats.mtime);
                }
            } catch (statError: any) {
              const message = `无法获取压缩包状态: ${fullPath}: ${statError?.message || statError}`;
              console.warn(message);
              failures.push({ type: 'fileStat', path: fullPath, error: statError?.message || String(statError) }); // 记录失败
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
                  };
                  results.push(fileItem);
                  progress.matchedFiles++;
                  if (onProgress) {
                    onProgress({ ...progress }, fileItem);
                  }
                } else {
                  progress.ignoredLargeFiles++;
                }
              } catch (statError: any) {
                const message = `无法获取文件状态: ${fullPath}: ${statError?.message || statError}`;
                console.warn(message);
                failures.push({ type: 'fileStat', path: fullPath, error: statError?.message || String(statError) }); // 记录失败
              }
            }
          }
        }
      }
    } catch (error: any) {
      const message = `无法访问目录: ${currentDir}: ${error?.message || error}`;
      console.warn(message);
      failures.push({ type: 'directoryAccess', path: currentDir, error: error?.message || String(error) }); // 记录失败
    }
  }

  await scanDirectory(rootDir, 0);
  return { results, failures }; // 返回包含结果和失败的对象
} 