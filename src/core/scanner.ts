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
    maxFileSize = 500 * 1024 * 1024, // 默认 500MB
    skipDirs = [] // 默认空白名单
  } = options;

  const regex = new RegExp(pattern);
  const results: FileItem[] = [];
  
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
    skippedDirs: 0 // 新增：记录跳过的目录数
  };

  /**
   * 检查目录是否在跳过列表中
   * @param dirPath 目录路径
   * @returns 是否应该跳过
   */
  function shouldSkipDirectory(dirPath: string): boolean {
    // 获取相对于根目录的路径
    const relativePath = path.relative(rootDir, dirPath);
    if (!relativePath) return false;

    const normalizedPath = path.normalize(relativePath).toLowerCase();
    
    // 检查是否匹配白名单中的任何路径
    return normalizedSkipDirs.some(skipDir => {
      // 完全匹配
      if (normalizedPath === skipDir) return true;
      // 当前目录是跳过目录的子目录
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