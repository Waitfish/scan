/**
 * @file 文件扫描器使用示例（带自动测试目录创建）
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing'; // Import compressing
import { scanFiles } from './core/scanner';
import { MatchRule} from './types';

// --- 测试目录设置 ---
const testRootDir = path.join(__dirname, '../example-test-run');

/**
 * 创建测试目录和文件结构
 */
async function createTestDirectory(): Promise<void> {
  console.log(`正在创建测试目录: ${testRootDir}`);
  try {
    await fs.ensureDir(testRootDir);

    // --- 文件系统文件 ---
    await fs.writeFile(path.join(testRootDir, 'readme.md'), '# Test Readme');
    await fs.writeFile(path.join(testRootDir, 'MeiTuan-report-final.docx'), 'MeiTuan DOCX');
    await fs.writeFile(path.join(testRootDir, 'BuYunSou-analysis.pdf'), 'BuYunSou PDF');
    await fs.writeFile(path.join(testRootDir, 'config.js'), 'module.exports = {};');
    const subDir1 = path.join(testRootDir, 'project-a');
    await fs.ensureDir(subDir1);
    await fs.writeFile(path.join(subDir1, 'MeiTuan-plan.doc'), 'MeiTuan DOC');
    await fs.writeFile(path.join(subDir1, 'data.json'), '{}');
    const deepDir = path.join(subDir1, 'deep-data');
    await fs.ensureDir(deepDir);
    await fs.writeFile(path.join(deepDir, 'archive.txt'), 'text file');
    await fs.writeFile(path.join(deepDir, 'BuYunSou-results.xls'), 'BuYunSou XLS');
    const nodeModulesDir = path.join(testRootDir, 'node_modules');
    await fs.ensureDir(nodeModulesDir);
    await fs.writeFile(path.join(nodeModulesDir, 'dummy-package.js'), 'ignore me');
    const gitDir = path.join(testRootDir, '.git');
    await fs.ensureDir(gitDir);
    await fs.writeFile(path.join(gitDir, 'config'), '[core]');
    const largeFilesDir = path.join(testRootDir, 'large-assets');
    await fs.ensureDir(largeFilesDir);
    await fs.writeFile(path.join(largeFilesDir, 'large-video.mp4'), Buffer.alloc(1024 * 1024, 'L'));
    await fs.writeFile(path.join(largeFilesDir, 'small-image.jpg'), Buffer.alloc(1024, 'S'));

    // --- 创建压缩文件 ---
    const archiveDir = path.join(testRootDir, 'archives');
    await fs.ensureDir(archiveDir);

    // 1. ZIP
    const zipPath = path.join(archiveDir, 'project-docs.zip');
    const zipStream = new compressing.zip.Stream();
    zipStream.addEntry(Buffer.from('MeiTuan spec v1'), { relativePath: 'MeiTuan-spec.docx' });
    zipStream.addEntry(Buffer.from('BuYunSou data export'), { relativePath: 'data/BuYunSou-export.xls' });
    zipStream.addEntry(Buffer.from('Internal note'), { relativePath: 'notes.txt' });
    const zipDestStream = fs.createWriteStream(zipPath);
    await new Promise<void>((resolve, reject) => {
      zipStream.pipe(zipDestStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 2. TGZ
    const tgzPath = path.join(archiveDir, 'project-backup.tar.gz'); // Use .tar.gz for tgz
    const tgzStream = new compressing.tgz.Stream();
    tgzStream.addEntry(Buffer.from('MeiTuan final report'), { relativePath: 'final/MeiTuan-final.doc' });
    tgzStream.addEntry(Buffer.from('BuYunSou diagram'), { relativePath: 'diagrams/BuYunSou-arch.pdf' });
    const tgzDestStream = fs.createWriteStream(tgzPath);
    await new Promise<void>((resolve, reject) => {
      tgzStream.pipe(tgzDestStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    console.log('测试目录和压缩包创建完成。');

  } catch (error) {
    console.error('创建测试目录时出错:', error);
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await createTestDirectory();

    const rules: MatchRule[] = [
      [['mjs'], 'clean.*'], 
      [['docx', 'doc'], '^MeiTuan.*'], 
      [['pdf', 'xls'], '^BuYunSou.*'],
      [['jpg'], '.*']
    ];
    const skipDirs = ['node_modules', '.git'];
    const maxSize = 500 * 1024;

    console.log('\n开始扫描 (包含压缩包内部)...');

    const { results: matchedFiles, failures } = await scanFiles({
      rootDir: testRootDir,
      matchRules: rules,
      depth: -1,
      maxFileSize: maxSize,
      skipDirs: skipDirs,
      onProgress: (progress, matchedFile) => {
        // 清除进度输出 (3 基本 + 1 空行 + 9 详情 = 13 行)
        // process.stdout.write('\x1B[13A\x1B[0J'); 

        // 基本进度
        console.log(`当前: ${path.relative(testRootDir, progress.currentDir) || '.'}`);
        console.log(`目录: ${progress.scannedDirs} scanned, ${progress.skippedDirs} skipped, ${progress.archivesScanned} archives`);
        console.log(`文件: ${progress.scannedFiles} scanned, ${progress.matchedFiles} matched, ${progress.ignoredLargeFiles} ignored`);
        console.log(' '); // 空行

        // 匹配文件详情
        if (matchedFile) {
          console.log(`[匹配文件]:`);
          console.log(`  来源 (origin): ${matchedFile.origin ?? 'filesystem'}`); // 显示 origin
          console.log(`  名称: ${matchedFile.name}`);
          if (matchedFile.origin === 'archive') {
            // 来自压缩包，显示压缩包路径和内部路径
            console.log(`  压缩包 (archivePath): ${path.relative(testRootDir, matchedFile.archivePath ?? '')}`); // 相对路径
            console.log(`  内部路径 (internalPath): ${matchedFile.internalPath}`);
          } else {
            // 来自文件系统，显示完整路径
            console.log(`  路径 (path): ${matchedFile.path}`);
            console.log(`  (无压缩包信息)`); // 占位
            console.log(`  (无压缩包信息)`); // 占位
          }
          console.log(`  大小: ${(matchedFile.size / 1024).toFixed(2)} KB`);
          console.log(`  创建: ${matchedFile.createTime.toLocaleString()}`);
          console.log(`  修改: ${matchedFile.modifyTime.toLocaleString()}`);
        } else {
          // 保持行数一致 (9 lines for file details)
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
          console.log(' ');
        }
      }
    });

    // 最终结果
    console.log('\n\n扫描完成!');
    console.log('-----------------');
    console.log(`总共找到 ${matchedFiles.length} 个匹配文件 (大小 <= ${(maxSize / 1024).toFixed(0)} KB):`);
    console.log('-----------------');
    
    matchedFiles.forEach((file, index) => {
      console.log(`[${index + 1}] ${file.name}`);
      console.log(`    来源 (origin): ${file.origin ?? 'filesystem'}`);
      if (file.origin === 'archive') {
        console.log(`    压缩包 (archivePath): ${file.archivePath}`);
        console.log(`    内部路径 (internalPath): ${file.internalPath}`);
      } else {
        console.log(`    路径 (path): ${file.path}`);
      }
      console.log(`    大小: ${(file.size / 1024).toFixed(2)} KB`);
      console.log(`    创建时间: ${file.createTime.toLocaleString()}`);
      console.log(`    修改时间: ${file.modifyTime.toLocaleString()}`);
      console.log('-----------------');
    });

    // 检查并打印失败信息
    if (failures.length > 0) {
        console.warn('\n扫描过程中遇到以下错误:');
        console.warn('-----------------');
        failures.forEach((fail, index) => {
            console.warn(`[失败 ${index + 1}] 类型: ${fail.type}`);
            console.warn(`  路径: ${fail.path}`);
            if (fail.entryPath) {
                console.warn(`  内部条目: ${fail.entryPath}`);
            }
            console.warn(`  错误: ${fail.error}`);
            console.warn('-----------------');
        });
    } else {
        console.log('\n扫描过程中未报告任何错误。');
    }

    console.log(`测试目录位于: ${testRootDir}`);

  } catch (error) {
    console.error('\n扫描或处理过程中出错:', error);
  }
}

main(); 