/**
 * @file 文件扫描器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { FileItem, ScanOptions, ScanProgress } from '../types';

/**
 * 扫描文件
 * @param options 扫描选项
 * @returns 文件列表
 */
export async function scanFiles(options: ScanOptions): Promise<FileItem[]> {
  const { 
    rootDir, 
    pattern, 
    depth = -1, 
    onProgress,
    maxFileSize = 500 * 1024 * 1024 // 默认 500MB
  } = options;
  const regex = new RegExp(pattern);
  const results: FileItem[] = [];
  
  const progress: ScanProgress = {
    currentDir: '',
    scannedFiles: 0,
    scannedDirs: 0,
    matchedFiles: 0,
    ignoredLargeFiles: 0
  };

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
      progress.scannedDirs++;
      if (onProgress) {
        onProgress({ ...progress });
      }

      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          await scanDirectory(fullPath, currentDepth + 1);
        } else if (entry.isFile()) {
          progress.scannedFiles++;
          if (regex.test(entry.name)) {
            const stats = await fs.stat(fullPath);
            if (stats.size <= maxFileSize) {
              results.push({
                path: fullPath,
                name: entry.name,
                createTime: stats.birthtime,
                modifyTime: stats.mtime,
                size: stats.size
              });
              progress.matchedFiles++;
            } else {
              progress.ignoredLargeFiles++;
            }
          }
          if (onProgress) {
            onProgress({ ...progress });
          }
        }
      }
    } catch (error) {
      // 忽略无法访问的目录
      console.warn(`无法访问目录: ${currentDir}`, error);
    }
  }

  await scanDirectory(rootDir, 0);
  return results;
} 