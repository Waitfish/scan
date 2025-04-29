/**
 * @file 用户文档扫描测试 - 扫描用户目录下的办公文档并上传到FTPS服务器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { scanAndTransport } from './facade';
import { MatchRule } from './types';
import { ScanAndTransportConfig } from './types/facade-v2';

// 获取用户主目录
const userHomeDir = os.homedir();

// 测试目录设置
const downloadsDir = path.join(userHomeDir, 'Downloads'); // 用户下载目录
const documentsDir = path.join(userHomeDir, 'Documents'); // 用户文档目录
const baseDir = path.join(__dirname, '../temp/user-docs-test'); // 基础目录
const outputDir = path.join(baseDir, 'output'); // 输出目录
const resultsDir = path.join(baseDir, 'results'); // 结果目录
const historyFilePath = path.join(baseDir, 'historical-uploads.json'); // 历史记录文件

async function main(): Promise<void> {
  try {
    console.log(`准备扫描用户文档目录...`);
    
    // 确保输出和结果目录存在
    await fs.ensureDir(baseDir);
    await fs.ensureDir(outputDir);
    await fs.ensureDir(resultsDir);
    
    // 检查是否有历史记录文件
    const hasHistoryFile = await fs.pathExists(historyFilePath);
    if (hasHistoryFile) {
      console.log(`检测到历史记录文件: ${historyFilePath}`);
      try {
        const historyContent = await fs.readJson(historyFilePath);
        console.log(`历史记录文件包含 ${historyContent.length} 个MD5记录`);
      } catch (err: any) {
        console.log(`读取历史记录文件失败: ${err.message}`);
      }
    } else {
      console.log(`未检测到历史记录文件，将创建新的历史记录。`);
    }

    // 匹配规则设置 - 只匹配办公文档格式
    const rules: MatchRule[] = [
      [['doc', 'docx'], '.*'], // 匹配所有Word文档
      [['xls', 'xlsx'], '.*']  // 匹配所有Excel文档
    ];
    
    // 定义扫描和传输配置
    const config: ScanAndTransportConfig = {
      rootDirs: [downloadsDir, documentsDir], // 扫描用户下载和文档目录
      rules: rules,
      taskId: `user-docs-scan-${Date.now()}`, // 使用时间戳创建唯一的任务ID
      outputDir: outputDir,
      resultsDir: resultsDir,
      maxFileSize: 500 * 1024 * 1024, // 50MB 最大文件大小限制
      skipDirs: ['node_modules', '.git', '.vscode', 'Library', '.Trash'], // 忽略这些目录
      depth: -1, // 无限深度
      scanNestedArchives: true, // 启用扫描嵌套压缩包
      calculateMd5: true,
      packagingTrigger: {
        maxFiles: 500,  // 每个包最多10个文件
        maxSizeMB: 2000  // 每个包最大50MB
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
          // 显示绝对路径以避免混淆
          console.log(`\n正在扫描目录: ${progress.currentDir}`);
          console.log(`扫描进度统计:`);
          console.log(`  - 已扫描文件数: ${progress.scannedFiles} 个`);
          console.log(`  - 匹配文件数: ${progress.matchedFiles} 个`);
          console.log(`  - 已扫描目录数: ${progress.scannedDirs} 个`);
          console.log(`  - 已跳过目录数: ${progress.skippedDirs} 个`);
          console.log(`  - 已忽略大文件数: ${progress.ignoredLargeFiles} 个`);
          if (progress.archivesScanned) {
            console.log(`  - 已处理压缩包数: ${progress.archivesScanned} 个`);
          }
          if (progress.nestedArchivesScanned) {
            console.log(`  - 已处理嵌套压缩包数: ${progress.nestedArchivesScanned} 个`);
          }
          if (progress.currentNestedLevel && progress.currentNestedLevel > 0) {
            console.log(`  - 当前压缩包嵌套层级: ${progress.currentNestedLevel}`);
          }
        }
      }
    };

    console.log('\n开始扫描、打包和传输用户文档...');
    console.log('扫描目录:', config.rootDirs);
    console.log('匹配规则: Word文档(.doc, .docx), Excel文档(.xls, .xlsx)');
    console.log('输出目录:', outputDir);
    console.log('结果目录:', resultsDir);
    console.log('跳过目录:', config.skipDirs);

    // 执行扫描和传输
    const result = await scanAndTransport(config);

    // 输出结果
    console.log('\n\n处理完成!');
    console.log('-----------------');
    console.log(`任务ID: ${result.taskId}`);
    console.log(`扫描ID: ${result.scanId}`);
    console.log(`处理成功: ${result.success ? '是' : '否'}`);
    console.log(`处理文件数 (进入打包/传输队列): ${result.processedFiles.length}`);
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

    // 输出重复文件详情（任务内）
    if (result.skippedTaskDuplicates.length > 0) {
      console.log('\n任务内重复文件:');
      result.skippedTaskDuplicates.forEach((file, index) => {
        console.log(`[${index + 1}] ${file.path}`);
        console.log(`  MD5: ${file.md5}`);
      });
    }

    // 输出重复文件详情（历史）
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

    // 输出各阶段时间统计（如果可用）
    if ((result as any).stageTimings) {
      const stageTimings = (result as any).stageTimings;
      console.log('\n各阶段耗时统计:');
      for (const [stage, time] of Object.entries(stageTimings)) {
        const percent = (Number(time) / result.elapsedTimeMs * 100).toFixed(2);
        console.log(`${stage}: ${time}ms (${percent}%)`);
      }
    }

    console.log(`\n测试基础目录位于: ${baseDir}`);
    console.log(`扫描目录: ${downloadsDir}, ${documentsDir}`);
    console.log(`历史记录文件位置: ${historyFilePath}`);
    console.log('\n再次运行此测试可测试历史去重功能');
  } catch (error) {
    console.error('\n处理过程中出错:', error);
  }
}

// 执行测试
main(); 