/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { FileItem, ScanOptions, ScanProgress } from '../types';

/** 预处理后的匹配规则 */
interface ProcessedRule {
  extensions: Set<string>;
  nameRegex: RegExp;
}

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
    maxFileSize = 500 * 1024 * 1024, // 默认 500MB
    skipDirs = [] // 默认空白名单
  } = options;

  const results: FileItem[] = [];
  
  // 预处理匹配规则
  const processedRules: ProcessedRule[] = matchRules.map(([extensions, namePattern]) => {
    const normalizedExtensions = extensions.map(ext => 
      ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()
    );
    return {
      extensions: new Set(normalizedExtensions),
      nameRegex: new RegExp(namePattern)
    };
  });

  // 将白名单路径标准化
  const normalizedSkipDirs = skipDirs.map(dir => 
    path.normalize(dir).toLowerCase()
  );
  
  const progress: ScanProgress = {
    currentDir: '',
    scannedFiles: 0,
    scannedDirs: 0,
    matchedFiles: 0,
    ignoredLargeFiles: 0,
    skippedDirs: 0
  };

  /**
   * 检查目录是否在跳过列表中
   * @param dirPath 目录路径
   * @returns 是否应该跳过
   */
  function shouldSkipDirectory(dirPath: string): boolean {
    const relativePath = path.relative(rootDir, dirPath);
    if (!relativePath) return false;
    const normalizedPath = path.normalize(relativePath).toLowerCase();
    return normalizedSkipDirs.some(skipDir => {
      if (normalizedPath === skipDir) return true;
      if (normalizedPath.startsWith(skipDir + path.sep)) return true;
      return false;
    });
  }

  async function scanDirectory(
    currentDir: string,
    currentDepth: number
  ): Promise<void> {
    // 如果设置了深度限制且当前深度超过限制，则停止扫描
    if (depth !== -1 && currentDepth > depth) {
      return;
    }

    try {
      progress.currentDir = currentDir;
      
      // 检查是否应该跳过当前目录
      if (shouldSkipDirectory(currentDir)) {
        progress.skippedDirs++;
        if (onProgress) {
          onProgress({ ...progress }); // 报告跳过
        }
        return;
      }

      progress.scannedDirs++;
      if (onProgress) {
        onProgress({ ...progress }); // 报告进入目录
      }

      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, currentDepth + 1);
        } else if (entry.isFile()) {
          progress.scannedFiles++;
          const fileExt = path.extname(entry.name).toLowerCase();
          let isMatch = false;
          
          // 检查是否匹配任何规则
          for (const rule of processedRules) {
            if (rule.extensions.has(fileExt) && rule.nameRegex.test(entry.name)) {
              isMatch = true;
              break; // 找到一个匹配规则即可
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
                  size: stats.size
                };
                results.push(fileItem);
                progress.matchedFiles++;
                if (onProgress) {
                  // 关键：在匹配且符合大小要求时，传递 FileItem
                  onProgress({ ...progress }, fileItem);
                }
              } else {
                progress.ignoredLargeFiles++;
                // 如果需要，也可以在这里调用 onProgress 报告忽略了大文件
                // if (onProgress) { onProgress({ ...progress }); }
              }
            } catch (statError) {
              console.warn(`无法获取文件状态: ${fullPath}`, statError);
            }
          }
          // 如果需要在每次扫描文件后都更新进度（即使未匹配），可以在这里调用 onProgress
          // else if (onProgress) { onProgress({ ...progress }); }
        }
      }
    } catch (error) {
      // 忽略无法访问的目录
      console.warn(`无法访问目录: ${currentDir}`, error);
      // 如果需要，可以在这里调用 onProgress 报告错误
      // if (onProgress) { onProgress({ ...progress }); }
    }
  }

  await scanDirectory(rootDir, 0);
  return results;
} 