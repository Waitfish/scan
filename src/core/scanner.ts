/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { FileItem, ScanOptions, ScanProgress,  } from '../types';

/** 预处理后的匹配规则 */
interface ProcessedRule {
  extensions: Set<string>;
  nameRegex: RegExp;
}

// 定义支持扫描的压缩包后缀
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.tar.gz']);

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
   * 扫描压缩包内部
   */
  async function scanArchive(
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
      console.warn(`不支持的压缩包类型，跳过扫描: ${archivePath}`);
      return;
    }

    if (!StreamType) {
      console.warn(`无法找到 ${ext} 的解压流类型，跳过扫描: ${archivePath}`);
      return;
    }
    
    try {
      const stream = new StreamType({ source: archivePath });
      
      await new Promise<void>((resolve, reject) => {
        stream.on('error', (err: Error) => {
          console.warn(`读取压缩包时出错 ${archivePath}:`, err.message);
          reject(err);
        });

        stream.on('finish', () => {
          resolve();
        });

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
              console.warn(`处理压缩包条目时出错 ${archivePath} > ${header.name}:`, entryError);
              entryStream.resume();
              next();
            }
          };
          processEntry();
        });
      });
    } catch (archiveError) {
      console.warn(`无法处理压缩包 ${archivePath}:`, archiveError);
    }
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
        if (onProgress) {
          onProgress({ ...progress });
        }
        return;
      }

      progress.scannedDirs++;
      if (onProgress) {
        onProgress({ ...progress });
      }

      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, currentDepth + 1);
        } else if (entry.isFile()) {
          const fileExt = path.extname(entry.name).toLowerCase();
          
          if (ARCHIVE_EXTENSIONS.has(fileExt)) {
            try {
              const stats = await fs.stat(fullPath);
              await scanArchive(fullPath, stats.birthtime, stats.mtime);
            } catch (statError) {
              console.warn(`无法获取压缩包状态: ${fullPath}`, statError);
            }
            continue;
          } else {
             // ----- 常规文件处理逻辑 -----
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
                    origin: 'filesystem', // 明确来源
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
            // ----- 结束常规文件处理逻辑 -----
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