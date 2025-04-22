/**
 * @file 文件扫描器使用示例（带自动测试目录创建）
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { scanFiles } from './core/scanner';
import { MatchRule  } from './types';

// --- 测试目录设置 ---
const testRootDir = path.join(__dirname, '../example-test-run');

/**
 * 创建测试目录和文件结构
 */
async function createTestDirectory(): Promise<void> {
  console.log(`正在创建测试目录: ${testRootDir}`);
  try {
    await fs.ensureDir(testRootDir);

    // 根目录文件
    await fs.writeFile(path.join(testRootDir, 'readme.md'), '# Test Readme');
    await fs.writeFile(path.join(testRootDir, 'MeiTuan-report-final.docx'), 'MeiTuan DOCX');
    await fs.writeFile(path.join(testRootDir, 'BuYunSou-analysis.pdf'), 'BuYunSou PDF');
    await fs.writeFile(path.join(testRootDir, 'config.js'), 'module.exports = {};');

    // 子目录 1
    const subDir1 = path.join(testRootDir, 'project-a');
    await fs.ensureDir(subDir1);
    await fs.writeFile(path.join(subDir1, 'MeiTuan-plan.doc'), 'MeiTuan DOC');
    await fs.writeFile(path.join(subDir1, 'data.json'), '{}');

    // 子目录 1 的深层目录
    const deepDir = path.join(subDir1, 'deep-data');
    await fs.ensureDir(deepDir);
    await fs.writeFile(path.join(deepDir, 'archive.txt'), 'text file');
    await fs.writeFile(path.join(deepDir, 'BuYunSou-results.xls'), 'BuYunSou XLS');

    // 要跳过的目录
    const nodeModulesDir = path.join(testRootDir, 'node_modules');
    await fs.ensureDir(nodeModulesDir);
    await fs.writeFile(path.join(nodeModulesDir, 'dummy-package.js'), 'ignore me');

    const gitDir = path.join(testRootDir, '.git');
    await fs.ensureDir(gitDir);
    await fs.writeFile(path.join(gitDir, 'config'), '[core]');

    // 大文件目录
    const largeFilesDir = path.join(testRootDir, 'large-assets');
    await fs.ensureDir(largeFilesDir);
    // 创建一个 1MB 的文件用于测试忽略
    await fs.writeFile(
      path.join(largeFilesDir, 'large-video.mp4'), 
      Buffer.alloc(1024 * 1024, 'L') 
    );
     // 创建一个 1KB 的文件用于测试不忽略
    await fs.writeFile(
      path.join(largeFilesDir, 'small-image.jpg'), 
      Buffer.alloc(1024, 'S') 
    );

    console.log('测试目录创建完成。');

  } catch (error) {
    console.error('创建测试目录时出错:', error);
    throw error; // 抛出错误，阻止后续扫描
  }
}

async function main(): Promise<void> {
  try {
    // 1. 创建测试目录结构
    await createTestDirectory();

    // 2. 定义扫描参数
    const rules: MatchRule[] = [
      [['docx', 'doc'], '^MeiTuan.*'], 
      [['pdf', 'xls'], '^BuYunSou.*'],
      [['jpg'], '.*'] // 添加一个规则匹配 jpg
    ];
    const skipDirs = ['node_modules', '.git']; // 要跳过的目录
    const maxSize = 500 * 1024; // 设置较小的文件限制 (500KB) 来测试大文件忽略

    console.log('\n开始扫描...');

    // 3. 执行扫描
    const files = await scanFiles({
      rootDir: testRootDir,          // 使用创建的测试目录
      matchRules: rules,             
      depth: -1,                   
      maxFileSize: maxSize,
      skipDirs: skipDirs,            
      onProgress: (progress, matchedFile) => {
        // 清除之前的进度输出 (调整行数以匹配新的输出: 3基本 + 7详情 = 10)
        // process.stdout.write('\x1B[10A\x1B[0J'); 

        // 显示基本进度
        console.log(`当前: ${path.relative(testRootDir, progress.currentDir) || '.'}`);
        console.log(`目录: ${progress.scannedDirs} scanned, ${progress.skippedDirs} skipped`);
        console.log(`文件: ${progress.scannedFiles} scanned, ${progress.matchedFiles} matched, ${progress.ignoredLargeFiles} ignored`);
        
        // 如果有匹配的文件，则显示其信息
        if (matchedFile) {
          console.log(`\n[匹配文件]:`); // +1
          console.log(`  名称: ${matchedFile.name}`); // +1
          console.log(`  路径: ${matchedFile.path}`); // +1 (Absolute Path)
          console.log(`  大小: ${(matchedFile.size / 1024).toFixed(2)} KB`); // +1
          console.log(`  创建: ${matchedFile.createTime.toLocaleString()}`); // +1
          console.log(`  修改: ${matchedFile.modifyTime.toLocaleString()}`); // +1
          console.log(` `); // +1 (Separator)
        } else {
          // 保持行数一致 (7 lines)
          console.log('\n ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
        }
      }
    });

    // 4. 显示最终结果
    console.log('\n\n扫描完成!');
    console.log('-----------------');
    console.log(`总共找到 ${files.length} 个匹配文件 (大小 <= ${(maxSize / 1024).toFixed(0)} KB):`);
    console.log('-----------------');
    
    files.forEach((file, index) => {
      console.log(`[${index + 1}] 文件名: ${file.name}`);
      console.log(`    路径: ${file.path}`);
      console.log(`    大小: ${(file.size / 1024).toFixed(2)} KB`);
      console.log(`    创建时间: ${file.createTime.toLocaleString()}`);
      console.log(`    修改时间: ${file.modifyTime.toLocaleString()}`);
      console.log('-----------------');
    });
    console.log(`测试目录位于: ${testRootDir}`); // 提示目录位置

  } catch (error) {
    console.error('\n扫描或处理过程中出错:', error);
  }
}

main(); 