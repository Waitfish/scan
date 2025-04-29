/**
 * @file 真实环境测试 - 本地扫描并上传到FTPS服务器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { scanAndTransport } from './facade';
import { MatchRule } from './types';
import { ScanAndTransportConfig } from './types/facade-v2';

// 测试目录设置
const testRootDir = path.join(__dirname, '../temp/real-test-run');
const outputDir = path.join(testRootDir, 'output');
const resultsDir = path.join(testRootDir, 'results');
// 添加去重历史文件路径
const historyFilePath = path.join(testRootDir, 'historical-uploads.json');

/**
 * 创建测试目录和文件结构
 * @param clean 是否清空测试目录，默认为true
 */
async function createTestDirectory(clean: boolean = true): Promise<void> {
  console.log(`正在创建测试目录: ${testRootDir}`);
  try {
    if (clean) {
      // 清理之前的测试目录
      console.log('清理之前的测试目录...');
      await fs.remove(testRootDir);
    } else {
      console.log('保留现有测试目录，历史记录文件将被保留');
    }
    
    // 创建目录结构
    await fs.ensureDir(testRootDir);
    await fs.ensureDir(outputDir);
    await fs.ensureDir(resultsDir);

    // --- 文件系统文件 ---
    await fs.writeFile(path.join(testRootDir, 'readme.md'), '# Test Readme');
    await fs.writeFile(path.join(testRootDir, 'MeiTuan-report-final.docx'), 'MeiTuan DOCX');
    await fs.writeFile(path.join(testRootDir, 'BuYunSou-analysis.pdf'), 'BuYunSou PDF');
    await fs.writeFile(path.join(testRootDir, 'config.js'), 'module.exports = {};');
    
    // 在根目录创建一个冲突文件
    await fs.writeFile(path.join(testRootDir, 'MeiTuan-plan.doc'), 'MeiTuan计划文档 - 根目录版本');
    
    const subDir1 = path.join(testRootDir, 'project-a');
    await fs.ensureDir(subDir1);
    // 在子目录中创建同名文件 (与根目录的同名)
    await fs.writeFile(path.join(subDir1, 'MeiTuan-plan.doc'), 'MeiTuan计划文档 - 项目A版本');
    await fs.writeFile(path.join(subDir1, 'data.json'), '{}');
    
    const deepDir = path.join(subDir1, 'deep-data');
    await fs.ensureDir(deepDir);
    await fs.writeFile(path.join(deepDir, 'archive.txt'), 'text file');
    await fs.writeFile(path.join(deepDir, 'BuYunSou-results.xls'), 'BuYunSou XLS');
    // 在深层目录中再创建一个同名文件
    await fs.writeFile(path.join(deepDir, 'MeiTuan-plan.doc'), 'MeiTuan计划文档 - 深层目录版本');
    
    // 创建另一个子目录并添加同名文件
    const subDir2 = path.join(testRootDir, 'project-b');
    await fs.ensureDir(subDir2);
    await fs.writeFile(path.join(subDir2, 'MeiTuan-plan.doc'), 'MeiTuan计划文档 - 项目B版本');
    await fs.writeFile(path.join(subDir2, 'BuYunSou-data.xls'), 'BuYunSou XLS - 项目B');
    
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
    const tgzPath = path.join(archiveDir, 'project-backup.tar.gz');
    const tgzStream = new compressing.tgz.Stream();
    tgzStream.addEntry(Buffer.from('MeiTuan final report'), { relativePath: 'final/MeiTuan-final.doc' });
    tgzStream.addEntry(Buffer.from('BuYunSou diagram'), { relativePath: 'diagrams/BuYunSou-arch.pdf' });
    const tgzDestStream = fs.createWriteStream(tgzPath);
    await new Promise<void>((resolve, reject) => {
      tgzStream.pipe(tgzDestStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 添加重复文件测试 - 任务内重复
    const duplicateDir = path.join(testRootDir, 'duplicate-test');
    await fs.ensureDir(duplicateDir);
    
    // 完全相同的文件内容，不同路径 - 用于测试任务内去重
    const sameContentA = 'This is identical content for deduplication testing';
    const sameContentB = Buffer.from(sameContentA); // 相同内容，不同Buffer实例
    
    await fs.writeFile(path.join(duplicateDir, 'MeiTuan-duplicate-1.doc'), sameContentA);
    await fs.writeFile(path.join(duplicateDir, 'MeiTuan-duplicate-2.doc'), sameContentB);
    
    // 创建子目录
    const subfolder1 = path.join(duplicateDir, 'subfolder1');
    await fs.ensureDir(subfolder1);
    await fs.writeFile(path.join(subfolder1, 'MeiTuan-duplicate-3.doc'), sameContentA);
    
    // 在不同文件夹中再创建一个相同内容的文件
    const subfolder2 = path.join(duplicateDir, 'subfolder2');
    await fs.ensureDir(subfolder2);
    await fs.writeFile(path.join(subfolder2, 'MeiTuan-duplicate-4.doc'), sameContentA);
    
    // 创建不同内容的文件作为对比
    await fs.writeFile(path.join(duplicateDir, 'MeiTuan-unique.doc'), 'This is unique content');
    
    // 创建一个BuYunSou系列的重复文件测试
    const buYunSouContent = 'BuYunSou duplicate content test';
    await fs.writeFile(path.join(duplicateDir, 'BuYunSou-duplicate-1.pdf'), buYunSouContent);
    await fs.writeFile(path.join(subfolder2, 'BuYunSou-duplicate-2.pdf'), buYunSouContent);

    console.log('测试目录和压缩包创建完成。');
    console.log('已创建重复文件用于测试去重功能。');

  } catch (error) {
    console.error('创建测试目录时出错:', error);
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    // 检查是否有历史记录文件
    const hasHistoryFile = await fs.pathExists(historyFilePath);
    const cleanDir = !hasHistoryFile;
    
    if (hasHistoryFile) {
      console.log(`检测到历史记录文件: ${historyFilePath}`);
      try {
        const historyContent = await fs.readJson(historyFilePath);
        console.log(`历史记录文件包含 ${historyContent.length} 个MD5记录`);
      } catch (err: any) {
        console.log(`读取历史记录文件失败: ${err.message}`);
      }
    }
    
    await createTestDirectory(cleanDir);

    // 匹配规则
    const rules: MatchRule[] = [
      [['mjs'], 'clean.*'], 
      [['docx', 'doc'], '^MeiTuan.*'], 
      [['pdf', 'xls'], '^BuYunSou.*'],
      [['jpg'], '.*']
    ];
    
    // 定义扫描和传输配置
    const config: ScanAndTransportConfig = {
      rootDir: testRootDir,
      rules: rules,
      taskId: `real-test-1`,
      outputDir: outputDir,
      resultsDir: resultsDir,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      skipDirs: ['node_modules', '.git', outputDir, 'archives'],
      depth: -1, // 无限深度
      scanNestedArchives: true,
      calculateMd5: true,
      packagingTrigger: {
        maxFiles: 5,  // 5个文件打一个包
        maxSizeMB: 10
      },
      transport: {
        enabled: true,
        protocol: 'ftps',
        host: '10.19.19.74',
        port: 12123,
        username: 'daiwj',
        password: '123456',
        remotePath: '/'
      },
      // 添加去重配置
      deduplicatorOptions: {
        enabled: true,
        useHistoricalDeduplication: true,
        useTaskDeduplication: true,
        historyFilePath: historyFilePath,
        autoSaveInterval: 60000 // 1分钟
      },
      onProgress: (progress, file) => {
        if (file) {
          console.log(`处理文件: ${file.name}`);
        } else {
          // 输出当前扫描的目录信息
          const relativeDir = path.relative(testRootDir, progress.currentDir) || '.';
          console.log(`\n正在扫描目录: ${relativeDir}`);
          console.log(`扫描进度统计:`);
          console.log(`  - 已扫描文件数: ${progress.scannedFiles} 个`);
          console.log(`  - 匹配文件数: ${progress.matchedFiles} 个`);
          console.log(`  - 已扫描目录数: ${progress.scannedDirs} 个`);
          console.log(`  - 已跳过目录数: ${progress.skippedDirs} 个`);
          console.log(`  - 已处理压缩包数: ${progress.archivesScanned} 个`);
          console.log(`  - 已处理嵌套压缩包数: ${progress.nestedArchivesScanned || 0} 个`);
          console.log(`  - 已忽略大文件数: ${progress.ignoredLargeFiles} 个`);
          if (progress.currentNestedLevel && progress.currentNestedLevel > 0) {
            console.log(`  - 当前压缩包嵌套层级: ${progress.currentNestedLevel}`);
          }
        }
      }
    };

    console.log('\n开始扫描、打包和传输...');
    console.log('RootDir:', testRootDir);
    console.log('OutputDir:', outputDir);
    console.log('Skip Dirs:', ['node_modules', '.git', outputDir, 'archives']);

    // 执行扫描和传输
    const result = await scanAndTransport(config);

    // 输出结果
    console.log('\n\n处理完成!');
    console.log('-----------------');
    console.log(`任务ID: ${result.taskId}`);
    console.log(`扫描ID: ${result.scanId}`);
    console.log(`处理成功: ${result.success ? '是' : '否'}`);
    console.log(`处理文件数: ${result.processedFiles.length}`);
    console.log(`失败项目数: ${result.failedItems.length}`);
    console.log(`包数量: ${result.packagePaths.length}`);
    console.log(`传输结果: ${result.transportSummary.length} 个文件传输`);
    // 输出去重结果
    console.log(`任务内重复跳过: ${result.skippedTaskDuplicates.length} 个文件`);
    console.log(`历史重复跳过: ${result.skippedHistoricalDuplicates.length} 个文件`);
    console.log(`开始时间: ${result.startTime.toLocaleString()}`);
    console.log(`结束时间: ${result.endTime.toLocaleString()}`);
    console.log(`总耗时: ${result.elapsedTimeMs}ms`);
    console.log(`日志文件: ${result.logFilePath}`);
    console.log(`结果文件: ${result.resultFilePath}`);
    console.log('-----------------');

    // 输出包列表
    if (result.packagePaths.length > 0) {
      console.log('\n创建的包:');
      result.packagePaths.forEach((packagePath, index) => {
        console.log(`[${index + 1}] ${path.basename(packagePath)}`);
      });
    }

    // 输出传输结果
    if (result.transportSummary.length > 0) {
      console.log('\n传输结果:');
      result.transportSummary.forEach((summary, index) => {
        console.log(`[${index + 1}] ${path.basename(summary.filePath)}`);
        console.log(`  状态: ${summary.success ? '成功' : '失败'}`);
        console.log(`  本地路径: ${summary.filePath}`);
        console.log(`  远程路径: ${summary.remotePath}`);
        if (!summary.success && summary.error) {
          console.log(`  错误: ${summary.error}`);
        }
      });
    }

    // 输出任务内去重详情
    if (result.skippedTaskDuplicates.length > 0) {
      console.log('\n任务内重复文件:');
      result.skippedTaskDuplicates.forEach((file, index) => {
        console.log(`[${index + 1}] ${file.path}`);
        console.log(`  MD5: ${file.md5}`);
      });
    }

    // 输出历史去重详情
    if (result.skippedHistoricalDuplicates.length > 0) {
      console.log('\n历史重复文件:');
      result.skippedHistoricalDuplicates.forEach((file, index) => {
        console.log(`[${index + 1}] ${file.path}`);
        console.log(`  MD5: ${file.md5}`);
      });
    }

    // 输出失败项
    if (result.failedItems.length > 0) {
      console.log('\n失败项:');
      result.failedItems.forEach((failure, index) => {
        console.log(`[${index + 1}] 类型: ${failure.type}`);
        console.log(`  路径: ${failure.path}`);
        console.log(`  错误: ${failure.error}`);
      });
    }

    console.log(`\n测试目录位于: ${testRootDir}`);
    console.log(`历史记录文件位置: ${historyFilePath}`);
    console.log('\n再次运行此测试可测试历史去重功能');
  } catch (error) {
    console.error('\n处理过程中出错:', error);
  }
}

// 执行测试
main(); 