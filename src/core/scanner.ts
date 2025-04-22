/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { createExtractorFromFile } from 'node-unrar-js'; // 导入 RAR 相关
import { FileItem, ScanOptions, ScanProgress } from '../types';

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
 * @returns 文件列表
 */
export async function scanFiles(options: ScanOptions): Promise<FileItem[]> {
  const {
    rootDir,
    matchRules,
    depth = -1,
    onProgress,
    maxFileSize = 500 * 1024 * 1024,
    skipDirs = [],
  } = options;

  const results: FileItem[] = [];

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
      console.warn(`[compressing] 不支持的压缩包类型: ${archivePath}`);
      return;
    }

    if (!StreamType) {
      console.warn(`[compressing] 无法找到解压流类型: ${ext}`);
      return;
    }
    
    try {
      const stream = new StreamType({ source: archivePath });
      
      await new Promise<void>((resolve, reject) => {
        stream.on('error', (err: Error) => {
          console.warn(`[compressing] 读取压缩包时出错 ${archivePath}:`, err.message);
          reject(err); 
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
            } catch (entryError) {
              console.warn(`[compressing] 处理条目时出错 ${archivePath} > ${header.name}:`, entryError);
              entryStream.resume(); 
              next();
            }
          };
          processEntry();
        });
      });
    } catch (archiveError) {
      console.warn(`[compressing] 无法处理压缩包 ${archivePath}:`, archiveError);
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
      }
      // 注意：getFileList() 返回的 fileHeaders 是生成器，
      // for...of 循环会自动处理迭代器的完成和资源释放。
      // 如果使用 list.fileHeaders.next() 手动迭代，则需要确保迭代到最后。
      
    } catch (error: any) {
      // node-unrar-js 可能会抛出特定错误
      console.warn(`[unrar] 处理 RAR 压缩包时出错 ${archivePath}:`, error.message || error);
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
            } catch (statError) {
              console.warn(`无法获取压缩包状态: ${fullPath}`, statError);
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
              } catch (statError) {
                console.warn(`无法获取文件状态: ${fullPath}`, statError);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`无法访问目录: ${currentDir}`, error);
    }
  }

  await scanDirectory(rootDir, 0);
  return results;
} 