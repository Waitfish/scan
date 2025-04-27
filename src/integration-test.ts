/**
 * @file 集成测试脚本
 * 用于测试所有模块的整合，包括扫描、稳定性检测、MD5计算、打包和传输
 */

import * as path from 'path';
import { scanFiles } from './core/scanner';
import { ScanOptions, TransportOptions, StabilityCheckOptions, QueueOptions, MatchRule } from './types';
import { createTransportAdapter } from './core/transport';
import * as fs from 'fs-extra';
import { calculateMd5 } from './core/md5';
import { checkFileStability, FileStabilityStatus } from './core/stability';
import { createBatchPackage, PackageProgress } from './core/packaging';

// 测试配置
const TEST_CONFIG = {
  // 扫描根目录
  rootDir: path.resolve(__dirname, '../example-test-run'),
  
  // FTP服务器配置 - 使用本地测试
  ftpServer: {
    host: '10.19.19.74', // 使用本地FTP服务器进行测试
    port: 12123,
    username: 'daiwj',
    password: '123456',
    remotePath: '/'
  },
  
  // 测试文件匹配规则
  matchRules: [
    // 匹配文档文件
    [['pdf', 'doc', 'docx', 'xls', 'xlsx'], '.*'] as MatchRule,
    // 匹配图片文件
    [['jpg', 'jpeg', 'png'], '.*'] as MatchRule,
    // 匹配视频文件
    [['mp4', 'avi'], '.*'] as MatchRule,
    // 匹配文本文件
    [['txt', 'md'], '.*'] as MatchRule
  ],
  
  // 输出目录
  outputDir: path.resolve(__dirname, '../temp/packages')
};

/**
 * 运行集成测试
 */
async function runIntegrationTest() {
  console.log('开始集成测试...');
  
  // 确保输出目录存在
  await fs.ensureDir(TEST_CONFIG.outputDir);
  
  // 创建稳定性检测选项
  const stabilityOptions: StabilityCheckOptions = {
    enabled: true,
    maxRetries: 3,
    retryInterval: 1000,
    checkInterval: 2000,
    largeFileThreshold: 100 * 1024 * 1024, // 100MB
    skipReadForLargeFiles: true
  };
  
  // 创建队列选项
  const queueOptions: QueueOptions = {
    enabled: true,
    maxConcurrentChecks: 5,
    maxConcurrentTransfers: 3,
    stabilityRetryDelay: 5000
  };
  
  // 创建传输选项
  const transportOptions: TransportOptions = {
    enabled: true,
    protocol: 'ftp',
    host: TEST_CONFIG.ftpServer.host,
    port: TEST_CONFIG.ftpServer.port,
    username: TEST_CONFIG.ftpServer.username,
    password: TEST_CONFIG.ftpServer.password,
    remotePath: TEST_CONFIG.ftpServer.remotePath,
    packageSize: 5,
    retryCount: 3,
    timeout: 30000,
    debug: true
  };
  
  // 创建扫描选项
  const scanOptions: ScanOptions = {
    rootDir: TEST_CONFIG.rootDir,
    matchRules: TEST_CONFIG.matchRules,
    depth: -1,
    maxFileSize: 500 * 1024 * 1024, // 500MB
    skipDirs: ['node_modules', '.git'],
    scanNestedArchives: true,
    maxNestedLevel: 3,
    stabilityCheck: stabilityOptions,
    queue: queueOptions,
    transport: transportOptions,
    calculateMd5: true,
    createPackage: true,
    packageNamePattern: 'package_{date}_{index}'
  };
  
  // 添加进度回调
  scanOptions.onProgress = (progress, matchedFile) => {
    console.log(`扫描进度: ${progress.scannedFiles} 文件, ${progress.matchedFiles} 匹配`);
    if (matchedFile) {
      console.log(`找到匹配文件: ${matchedFile.path}`);
    }

    // 如果有队列状态，打印它
    if (progress.queueStats) {
      console.log('队列状态:', JSON.stringify(progress.queueStats));
    }
    
    // 打印MD5计算和打包进度
    if (progress.processedMd5Count) {
      console.log(`MD5计算: ${progress.processedMd5Count} 文件`);
    }
    
    if (progress.packagedFilesCount) {
      console.log(`打包进度: ${progress.packagedFilesCount} 文件`);
    }
    
    if (progress.transportedFilesCount) {
      console.log(`传输进度: ${progress.transportedFilesCount} 文件`);
    }
  };
  
  try {
    // 1. 运行扫描过程
    console.log('开始扫描文件...');
    const scanResult = await scanFiles(scanOptions);
    
    console.log(`扫描完成. 找到 ${scanResult.results.length} 个匹配文件.`);
    console.log(`失败: ${scanResult.failures.length} 项`);
    
    if (scanResult.failures.length > 0) {
      console.log('失败详情:');
      scanResult.failures.forEach(failure => {
        console.log(`- ${failure.type}: ${failure.path}, ${failure.error}`);
      });
    }
    
    // 如果扫描结果中包含了处理后的文件和传输结果，则测试已经完成
    if (scanResult.processedFiles && scanResult.transportResults) {
      console.log('扫描器已包含集成的处理和传输步骤:');
      
      if (scanResult.processedFiles) {
        console.log(`处理的文件数: ${scanResult.processedFiles.length}`);
        console.log('处理的文件:');
        scanResult.processedFiles.forEach(file => {
          console.log(`- ${file.name} (MD5: ${file.md5 || '未计算'})`);
        });
      }
      
      if (scanResult.packages) {
        console.log(`创建的包数: ${scanResult.packages.length}`);
        console.log('包文件:');
        scanResult.packages.forEach(pkg => {
          console.log(`- ${pkg}`);
        });
      }
      
      if (scanResult.transportResults) {
        console.log(`传输结果数: ${scanResult.transportResults.length}`);
        console.log('传输结果:');
        scanResult.transportResults.forEach(result => {
          console.log(`- ${result.filePath} -> ${result.remotePath} (${result.success ? '成功' : '失败: ' + result.error})`);
        });
      }
      
      console.log('集成测试完成。');
      return;
    }
    
    // 否则，需要手动运行集成测试
    console.log('扫描器未包含集成处理步骤，进行手动测试...');
    
    // 准备测试环境
    const testFiles = scanResult.results
      .filter(file => file.origin === 'filesystem') // 只使用文件系统的文件，不使用压缩包内的文件
      .slice(0, Math.min(5, scanResult.results.length));
    console.log(`选择 ${testFiles.length} 个文件进行测试。`);
    
    // 2. 测试稳定性检测
    console.log('\n===== 稳定性检测测试 =====');
    for (const file of testFiles) {
      console.log(`检测文件 ${file.path} 的稳定性...`);
      const status = await checkFileStability(file.path); 
      const isStable = status === FileStabilityStatus.STABLE;
      console.log(`${path.basename(file.path)}: ${isStable ? '稳定' : '不稳定'} (状态: ${status})`);
    }
    
    // 3. 测试MD5计算
    console.log('\n===== MD5计算测试 =====');
    console.log('MD5计算结果:');
    for (const file of testFiles) {
      const md5 = await calculateMd5(file.path);
      console.log(`- ${path.basename(file.path)}: ${md5}`);
    }
    
    // 4. 测试文件打包
    console.log('\n===== 文件打包测试 =====');
    const packagePath = path.join(TEST_CONFIG.outputDir, `test_package_${Date.now()}.zip`);
    
    await createBatchPackage(
      testFiles.map(f => ({ 
        path: f.path, 
        name: f.name, 
        size: f.size, 
        createTime: f.createTime, 
        modifyTime: f.modifyTime 
      })), // 移除临时 any，假设 testFiles 结构兼容 FileItem
      packagePath, 
      { // 第三个参数是 PackageOptions
        onProgress: (_progress: PackageProgress) => {
          console.log(`打包进度: ${Math.floor(_progress.percentage)}%, ${_progress.processedFiles}/${_progress.totalFiles}`);
        }
      }
    );
    
    console.log(`打包成功: ${packagePath}`);
    console.log(`包含 ${testFiles.length} 个文件`);
    
    // 5. 测试文件传输
    console.log('\n===== 文件传输测试 =====');
    const transportAdapter = createTransportAdapter(transportOptions);
    
    if (!transportAdapter) {
      throw new Error('创建传输适配器失败');
    }
    
    try {
      // 连接到服务器
      console.log(`连接到FTP服务器 ${transportOptions.host}:${transportOptions.port}...`);
      await transportAdapter.connect();
      console.log('连接成功');
      
      // 上传文件
      console.log(`上传文件 ${packagePath} 到 ${transportOptions.remotePath}...`);
      const uploadResult = await transportAdapter.upload(
        packagePath,
        path.basename(packagePath)
      );
      
      if (uploadResult.success) {
        console.log(`传输成功: ${uploadResult.filePath} -> ${uploadResult.remotePath}`);
        console.log(`开始时间: ${uploadResult.startTime}`);
        console.log(`结束时间: ${uploadResult.endTime}`);
        console.log(`传输耗时: ${(uploadResult.endTime.getTime() - uploadResult.startTime.getTime()) / 1000} 秒`);
      } else {
        console.error('传输失败:', uploadResult.error);
      }
      
      // 断开连接
      await transportAdapter.disconnect();
      console.log('已断开FTP服务器连接');
    } catch (error: any) {
      console.error('传输过程发生错误:', error?.message || error);
    }
    
    console.log('\n集成测试完成');
  } catch (error: any) {
    console.error('集成测试失败:', error?.message || error);
  }
}

// 运行测试
runIntegrationTest().catch(error => {
  console.error('测试执行错误:', error);
  process.exit(1);
}); 