/**
 * @file 文件扫描器使用示例
 */

import { scanFiles } from './core/scanner';

async function main(): Promise<void> {
  try {
    // 扫描当前目录下所有的 .ts 文件
    const files = await scanFiles({
      rootDir: '/Users/daiwangjian/',    // 扫描目录
      pattern: '\\.ts$',         // 匹配所有 .ts 文件
      depth: 20,                 // 扫描深度为20层
      maxFileSize: 500 * 1024 * 1024, // 500MB
      onProgress: (progress) => {
        console.log(`\r扫描进度: ${progress.currentDir}`);
        console.log(`已扫描目录: ${progress.scannedDirs}`);
        console.log(`已扫描文件: ${progress.scannedFiles}`);
        console.log(`匹配文件: ${progress.matchedFiles}`);
        console.log(`忽略的大文件: ${progress.ignoredLargeFiles}`);
        // 清空当前行，准备下一次输出
        process.stdout.write('\x1B[4A\x1B[0J');
      }
    });

    console.log('\n找到的文件：');
    console.log('-----------------');
    
    files.forEach(file => {
      console.log(`文件名: ${file.name}`);
      console.log(`路径: ${file.path}`);
      console.log(`大小: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`创建时间: ${file.createTime}`);
      console.log(`修改时间: ${file.modifyTime}`);
      console.log('-----------------');
    });

    console.log(`总共找到 ${files.length} 个文件`);
  } catch (error) {
    console.error('扫描出错:', error);
  }
}

main(); 