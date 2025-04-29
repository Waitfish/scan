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

/**
 * 创建测试目录和文件结构
 */
async function createTestDirectory(): Promise<void> {
  console.log(`正在创建测试目录: ${testRootDir}`);
  try {
    // 清理之前的测试目录
    await fs.remove(testRootDir);
    
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

    console.log('测试目录和压缩包创建完成。');

  } catch (error) {
    console.error('创建测试目录时出错:', error);
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await createTestDirectory();

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
      taskId: `real-test`,
      outputDir: outputDir,
      resultsDir: resultsDir,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      skipDirs: ['node_modules', '.git'],
      depth: -1, // 无限深度
      scanNestedArchives: true,
      calculateMd5: true,
      packagingTrigger: {
        maxFiles: 5,  // <--- 修改为 10
        maxSizeMB: 10   // <--- 修改为 10
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
      onProgress: (progress, file) => {
        if (file) {
          console.log(`处理文件: ${file.name}`);
        } else {
          // 输出当前扫描的目录信息
          console.log(`目录: ${path.relative(testRootDir, progress.currentDir) || '.'}`);
          console.log(`已扫描: ${progress.scannedFiles}文件, ${progress.matchedFiles}匹配, ${progress.scannedDirs}目录`);
        }
      }
    };

    console.log('\n开始扫描、打包和传输...');

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

    // 验证文件名冲突处理
    console.log('\n检查文件名冲突处理:');
    
    // 尝试查找结果文件中的冲突文件处理信息
    if (result.resultFilePath) {
      try {
        const resultContent = await fs.readJson(result.resultFilePath);
        
        // 查找所有最终包含在包中的 MeiTuan-plan.doc 文件
        const planDocs = resultContent.processedFiles.filter((file: any) => 
          file.originalName && file.originalName.includes('MeiTuan-plan.doc')
        );
        
        if (planDocs.length > 0) {
          console.log(`\n找到 ${planDocs.length} 个同名文件 "MeiTuan-plan.doc":`);
          planDocs.forEach((doc: any, index: number) => {
            console.log(`[${index + 1}] 原始路径: ${doc.path}`);
            console.log(`    原始名称: ${doc.originalName}`);
            console.log(`    最终名称: ${doc.name}`);
            console.log(`    MD5: ${doc.md5}`);
          });
        } else {
          console.log('未找到同名冲突文件');
        }
        
        // 检查警告信息中是否包含文件名冲突信息
        if (resultContent.warnings && resultContent.warnings.length > 0) {
          const conflictWarnings = resultContent.warnings.filter((warning: string) => 
            warning.includes('文件名冲突')
          );
          
          if (conflictWarnings.length > 0) {
            console.log('\n文件名冲突警告:');
            conflictWarnings.forEach((warning: string, index: number) => {
              console.log(`[${index + 1}] ${warning}`);
            });
          }
        }
      } catch (error) {
        console.error('读取结果文件时出错:', error);
      }
    }

  } catch (error) {
    console.error('\n处理过程中出错:', error);
  }
}

// 执行测试
main(); 