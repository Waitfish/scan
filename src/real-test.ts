/**
 * @file 真实环境测试 - 本地扫描并上传到FTPS服务器 (流水线模式验证)
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { scanAndTransport, getDefaultLogFilePath } from './facade';
import { MatchRule } from './types';
import { ScanAndTransportConfig } from './types/facade-v2';

// 测试目录设置
const testRootDir = path.join(__dirname, '../temp/real-test-run-pipeline'); // Use a new dir name
const outputDir = path.join(testRootDir, 'output');
const resultsDir = path.join(testRootDir, 'results');

/**
 * 创建测试目录和文件结构 (增强版，用于流水线测试)
 */
async function createTestDirectory(): Promise<void> {
  console.log(`正在创建测试目录 (流水线): ${testRootDir}`);
  try {
    await fs.remove(testRootDir); // Clean previous runs
    await fs.ensureDir(testRootDir);
    await fs.ensureDir(outputDir);
    await fs.ensureDir(resultsDir);

    // --- Create more small files ---
    console.log('创建小文件...');
    for (let i = 0; i < 20; i++) {
        await fs.writeFile(path.join(testRootDir, `small-file-${i}.txt`), `Content for small file ${i}`);
        // Add some files matching rules specifically
        if (i < 5) await fs.writeFile(path.join(testRootDir, `MeiTuan-data-${i}.txt`), `MT Data ${i}`);
        if (i >= 5 && i < 10) await fs.writeFile(path.join(testRootDir, `BuYunSou-log-${i}.log`), `BYS Log ${i}`);
    }

    // --- Existing diverse files ---
    console.log('创建多样化文件...');
    await fs.writeFile(path.join(testRootDir, 'readme.md'), '# Test Readme'); // Matches no rule by default
    await fs.writeFile(path.join(testRootDir, 'MeiTuan-report-final.docx'), 'MeiTuan DOCX Content'); // Match rule 2
    await fs.writeFile(path.join(testRootDir, 'BuYunSou-analysis.pdf'), 'BuYunSou PDF Content');   // Match rule 3
    await fs.writeFile(path.join(testRootDir, 'config.js'), 'module.exports = {};'); // Skipped

    // --- Subdirectories with files ---
    console.log('创建子目录文件...');
    const subDir1 = path.join(testRootDir, 'project-a');
    await fs.ensureDir(subDir1);
    await fs.writeFile(path.join(subDir1, 'MeiTuan-plan.doc'), 'MeiTuan DOC Content');       // Match rule 2
    await fs.writeFile(path.join(subDir1, 'data.json'), '{}');                            // Skipped
    // Add more small files in subdir
    for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(subDir1, `sub-small-${i}.txt`), `Sub Content ${i}`);
    }

    const deepDir = path.join(subDir1, 'deep-data');
    await fs.ensureDir(deepDir);
    await fs.writeFile(path.join(deepDir, 'archive.txt'), 'text file in deep'); // Matches rule 1 if rules changed
    await fs.writeFile(path.join(deepDir, 'BuYunSou-results.xls'), 'BuYunSou XLS Content'); // Match rule 3

    // --- Skipped Dirs ---
    console.log('创建跳过目录...');
    const nodeModulesDir = path.join(testRootDir, 'node_modules');
    await fs.ensureDir(nodeModulesDir);
    await fs.writeFile(path.join(nodeModulesDir, 'dummy-package.js'), 'ignore me');

    const gitDir = path.join(testRootDir, '.git');
    await fs.ensureDir(gitDir);
    await fs.writeFile(path.join(gitDir, 'config'), '[core]');

    // --- Large(ish) Files and Image ---
    console.log('创建中/大文件...');
    const largeFilesDir = path.join(testRootDir, 'large-assets');
    await fs.ensureDir(largeFilesDir);
    // Create a 5MB file (adjust size as needed, ensure < maxFileSize in config)
    const largeBufferSize = 5 * 1024 * 1024;
    await fs.writeFile(path.join(largeFilesDir, `large-data-5MB.bin`), Buffer.alloc(largeBufferSize, 'L')); // Won't match rules by default
    await fs.writeFile(path.join(largeFilesDir, 'BuYunSou-map.jpg'), Buffer.alloc(1024 * 500, 'S')); // 500KB JPG - Match rule 4

    // --- Archives ---
    console.log('创建压缩文件...');
    const archiveDir = path.join(testRootDir, 'archives');
    await fs.ensureDir(archiveDir);

    // 1. ZIP (Contains matching files)
    const zipPath = path.join(archiveDir, 'project-docs.zip');
    const zipStream = new compressing.zip.Stream();
    zipStream.addEntry(Buffer.from('MeiTuan spec v1'), { relativePath: 'docs/MeiTuan-spec.docx' });     // Match rule 2
    zipStream.addEntry(Buffer.from('BuYunSou data export'), { relativePath: 'data/BuYunSou-export.xls' }); // Match rule 3
    zipStream.addEntry(Buffer.from('Internal note'), { relativePath: 'notes.txt' });                  // Match rule 1
    zipStream.addEntry(Buffer.from('Small image'), { relativePath: 'img/small.jpg' });              // Match rule 4
    const zipDestStream = fs.createWriteStream(zipPath);
    await new Promise<void>((resolve, reject) => {
      zipStream.pipe(zipDestStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 2. TGZ (Contains matching files)
    const tgzPath = path.join(archiveDir, 'project-backup.tar.gz');
    const tgzStream = new compressing.tgz.Stream();
    tgzStream.addEntry(Buffer.from('MeiTuan final report'), { relativePath: 'final/MeiTuan-final.doc' });   // Match rule 2
    tgzStream.addEntry(Buffer.from('BuYunSou diagram'), { relativePath: 'diagrams/BuYunSou-arch.pdf' }); // Match rule 3
    const tgzDestStream = fs.createWriteStream(tgzPath);
    await new Promise<void>((resolve, reject) => {
      tgzStream.pipe(tgzDestStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    console.log('测试目录和文件创建完成。');

  } catch (error) {
    console.error('创建测试目录时出错:', error);
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await createTestDirectory();

    // 匹配规则 (Adjust if needed to match generated files)
    const rules: MatchRule[] = [
      [['txt', 'log'], '.*'], // Match all .txt and .log files
      [['docx', 'doc'], '^MeiTuan.*'],
      [['pdf', 'xls'], '^BuYunSou.*'],
      [['jpg', 'jpeg'], '.*'] // Match jpg/jpeg
    ];

    // 定义扫描和传输配置 (Adjusted for pipeline testing)
    const config: ScanAndTransportConfig = {
      rootDir: testRootDir,
      rules: rules,
      taskId: `pipeline-test-${Date.now()}`, // Unique task ID
      outputDir: outputDir,
      resultsDir: resultsDir,
      maxFileSize: 10 * 1024 * 1024, // 10MB limit (ensure large file is below this)
      skipDirs: ['node_modules', '.git'],
      depth: -1,
      scanNestedArchives: true,
      calculateMd5: true, // Keep MD5 calculation enabled
      packagingTrigger: {
        maxFiles: 5,  // <<-- Reduced trigger count
        maxSizeMB: 2    // <<-- Reduced trigger size (MB)
      },
      transport: {
        enabled: true, // <<-- Set to true to test transport
        protocol: 'ftps', // or 'ftp', 'sftp'
        host: '10.19.19.74', // <<-- !!! Your FTP/FTPS/SFTP Server Host !!!
        port: 12123,        // <<-- !!! Your Server Port !!!
        username: 'daiwj',   // <<-- !!! Your Username !!!
        password: '123456', // <<-- !!! Your Password !!!
        remotePath: '/' // <<-- Base remote directory
      },
      // Optional: Define queue concurrency if needed (defaults are usually ok)
      // queue: {
      //   maxConcurrentFileChecks: 5,
      //   maxConcurrentMd5: 3,
      //   maxConcurrentTransfers: 2
      // },
      onProgress: (progress, file) => {
        if (file) {
          // Less verbose progress for many files
          console.log(`Matched: ${file.name}`);
        } else {
          console.log(`Scanning Dir: ${path.relative(testRootDir, progress.currentDir) || '.'} | Scanned: ${progress.scannedFiles} files, ${progress.matchedFiles} matched`);
        }
      }
    };

    console.log('\n开始流水线扫描、打包和传输...');
    console.log(`日志文件将会生成在: ${getDefaultLogFilePath()}`);

    // 执行扫描和传输
    const result = await scanAndTransport(config);

    // 输出结果
    console.log('\n\n处理完成!');
    console.log('-----------------');
    console.log(`任务ID: ${result.taskId}`);
    console.log(`扫描ID: ${result.scanId}`);
    console.log(`处理成功: ${result.success ? '是' : '否'}`);
    // console.log(`处理文件数 (Approx): ${result.processedFiles.length}`); // processedFiles might be empty now
    console.log(`失败项目数: ${result.failedItems.length}`);
    console.log(`包数量: ${result.packagePaths.length}`);
    console.log(`传输结果数: ${result.transportSummary.length}`);
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
        console.log(`[${index + 1}] ${summary.success ? '✅' : '❌'} ${path.basename(summary.filePath)} -> ${summary.remotePath}`);
        if (!summary.success && summary.error) {
          console.log(`    错误: ${summary.error}`);
        }
      });
    }

    // 输出失败项
    if (result.failedItems.length > 0) {
      console.log('\n失败项:');
      result.failedItems.forEach((failure, index) => {
        console.log(`[${index + 1}] 类型: ${failure.type}`);
        console.log(`    路径: ${failure.path}`);
        if(failure.entryPath) console.log(`    内部路径: ${failure.entryPath}`);
        console.log(`    错误: ${failure.error}`);
      });
    }

    console.log(`\n测试目录位于: ${testRootDir}`);
    console.log("** 请检查日志文件以确认流水线行为 **");

  } catch (error) {
    console.error('\n处理过程中出错:', error);
  }
}

// 执行测试
main(); 