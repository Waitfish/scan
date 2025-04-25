/**
 * @file 文件打包模块
 * 用于将文件打包成压缩包并包含元数据信息
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { FileItem } from '../types';

// 使用项目已有的compressing库，后续实现中导入

/**
 * 文件包的元数据接口
 */
export interface PackageMetadata {
  /** 创建时间 */
  createTime: string;
  /** 包含的文件列表 */
  files: {
    /** 文件原始路径 */
    originalPath: string;
    /** 文件名 */
    name: string;
    /** 文件大小 */
    size: number;
    /** 文件MD5值 */
    md5?: string;
    /** 文件修改时间 */
    modifyTime: string;
  }[];
}

/**
 * 创建包的元数据
 * @param files 文件列表
 * @returns 包元数据
 */
export function createPackageMetadata(files: FileItem[]): PackageMetadata {
  return {
    createTime: new Date().toISOString(),
    files: files.map(file => ({
      originalPath: file.path,
      name: file.name,
      size: file.size,
      md5: file.md5,
      modifyTime: file.modifyTime.toISOString()
    }))
  };
}

/**
 * 创建文件包（基础实现）
 * @param files 要打包的文件列表
 * @param outputPath 输出路径
 * @returns 包文件路径
 */
export async function createPackage(
  files: FileItem[], 
  outputPath: string
): Promise<string> {
  // 基础实现 - 将在后续开发中完善
  // 创建目录
  await fs.ensureDir(path.dirname(outputPath));
  
  // 创建元数据
  const metadata = createPackageMetadata(files);
  const metadataPath = `${outputPath}.json`;
  
  // 写入元数据文件
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
  
  return outputPath;
} 