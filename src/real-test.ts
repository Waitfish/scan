/**
 * @file 真实环境测试 - 本地扫描并上传到FTPS服务器
 */

import * as path from 'path';
import * as fs from 'fs-extra';
// import * as compressing from 'compressing'; // 暂时移除压缩包测试以简化
import { scanAndTransport } from './facade';
import { MatchRule } from './types';
import { ScanAndTransportConfig } from './types/facade-v2';

// 测试目录设置
const testBaseDir = path.join(__dirname, '../temp/real-multi-root-test'); // 基础目录
const testRootDir1 = path.join(testBaseDir, 'source1'); // 第一个独立源目录
const testRootDir2 = path.join(testBaseDir, 'source2'); // 第二个独立源目录
const outputDir = path.join(testBaseDir, 'output'); // 输出目录放在基础目录下
const resultsDir = path.join(testBaseDir, 'results'); // 结果目录放在基础目录下
const historyFilePath = path.join(testBaseDir, 'historical-uploads.json'); // 历史记录放在基础目录下

/**
 * 创建独立的测试目录和文件结构
 * @param baseDir 基础目录
 * @param rootDirs 要创建的根目录路径数组
 * @param outputDir 输出目录
 * @param resultsDir 结果目录
 * @param clean 是否清空基础目录，默认为true
 */
async function createIndependentTestDirectories(
  baseDir: string,
  rootDirs: string[],
  outputDir: string,
  resultsDir: string,
  clean: boolean = true
): Promise<void> {
  console.log(`准备测试环境，基础目录: ${baseDir}`);
  try {
    if (clean) {
      console.log('清理之前的测试基础目录...');
      await fs.remove(baseDir);
    }
    
    // 创建基础目录结构
    await fs.ensureDir(baseDir);
    await fs.ensureDir(outputDir);
    await fs.ensureDir(resultsDir);
    console.log('基础目录结构创建完成。');

    // 定义一些共享内容用于测试跨目录去重
    const sharedContent1 = 'This content is shared across roots for deduplication testing.';
    const sharedContent2 = 'Another shared content.';

    // 循环创建每个根目录及其内容
    for (const rootDir of rootDirs) {
      const rootName = path.basename(rootDir); // 获取 source1 或 source2
      console.log(`- 正在创建根目录: ${rootDir}`);
      await fs.ensureDir(rootDir);
      
      // --- 在当前 rootDir 中创建文件和子目录 ---
      
      // 1. 独有文件
      await fs.writeFile(path.join(rootDir, `unique-file-${rootName}.docx`), `Unique MeiTuan content for ${rootName}`);
      await fs.writeFile(path.join(rootDir, `unique-data-${rootName}.pdf`), `Unique BuYunSou data for ${rootName}`);
      await fs.writeFile(path.join(rootDir, `image-${rootName}.jpg`), Buffer.alloc(512, rootName.slice(0, 1)));

      // 2. 不同根目录下，同名但内容不同的文件
      await fs.writeFile(path.join(rootDir, 'shared-name.pdf'), `BuYunSou data (version from ${rootName})`);

      // 3. 不同根目录下，内容相同但名称/路径不同的文件 (用于跨目录去重)
      if (rootName === 'source1') {
        await fs.writeFile(path.join(rootDir, 'shared-content-a.doc'), sharedContent1);
        await fs.writeFile(path.join(rootDir, 'shared-content-b.xls'), sharedContent2);
      } else { // source2
        // 确保 source2/sub 目录存在
        await fs.ensureDir(path.join(rootDir, 'sub'));
        await fs.writeFile(path.join(rootDir, 'sub', 'shared-content-a-altname.doc'), sharedContent1);
        await fs.writeFile(path.join(rootDir, 'shared-content-b.pdf'), sharedContent2);
      }

      // 4. 子目录和嵌套文件
      const subDir = path.join(rootDir, 'sub');
      await fs.ensureDir(subDir); // 确保子目录存在 (可能重复调用，但 fs-extra 会处理)
      await fs.writeFile(path.join(subDir, `nested-data-${rootName}.xls`), `Nested BuYunSou data for ${rootName}`);
      await fs.writeFile(path.join(subDir, `readme-${rootName}.txt`), `Readme for ${rootName}`); // 不会被规则匹配

      // 5. 需要被跳过的目录
      const nodeModulesDir = path.join(rootDir, 'node_modules');
      await fs.ensureDir(nodeModulesDir);
      await fs.writeFile(path.join(nodeModulesDir, `dummy-${rootName}.js`), 'ignore me');
      
      const gitDir = path.join(rootDir, '.git');
      await fs.ensureDir(gitDir);
      await fs.writeFile(path.join(gitDir, 'config'), `[core] in ${rootName}`);
      
      console.log(`  - 完成根目录创建: ${rootDir}`);
    }

    // --- 暂时移除压缩文件创建 --- 
    // console.log('跳过压缩文件创建以简化测试...');

    console.log('所有测试目录和文件创建完成。');

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
    
    // 调用新的测试目录创建函数
    await createIndependentTestDirectories(
      testBaseDir, 
      [testRootDir1, testRootDir2], 
      outputDir, 
      resultsDir, 
      cleanDir
    );

    // 匹配规则 (保持不变)
    const rules: MatchRule[] = [
      [['mjs'], 'clean.*'], 
      [['docx', 'doc'], '^MeiTuan.*|unique-file.*|shared-content-a.*|shared-content-a-altname.*'], // 调整规则以匹配新文件名
      [['pdf', 'xls'], '^BuYunSou.*|unique-data.*|shared-name.*|nested-data.*|shared-content-b.*'], // 调整规则以匹配新文件名
      [['jpg'], '.*\.jpg$'] // 确保只匹配jpg
    ];
    
    // 定义扫描和传输配置
    const config: ScanAndTransportConfig = {
      rootDirs: [testRootDir1, testRootDir2], // 使用独立的根目录列表
      rules: rules,
      taskId: `real-multi-root-test-1`,
      outputDir: outputDir,
      resultsDir: resultsDir,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      // skipDirs 保持相对路径或绝对路径。outputDir 现在在外面，也添加到 skip 列表。
      skipDirs: ['node_modules', '.git', outputDir], // 确保 outputDir 被跳过
      depth: -1, // 无限深度
      scanNestedArchives: false, // 暂时禁用嵌套扫描，因为没创建压缩包
      calculateMd5: true,
      packagingTrigger: {
        maxFiles: 4,  // 调小打包数量以便更快看到多个包
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
          // 显示绝对路径以避免混淆
          console.log(`\n正在扫描目录: ${progress.currentDir}`);
          console.log(`扫描进度统计 (当前根):`);
          console.log(`  - 已扫描文件数: ${progress.scannedFiles} 个`);
          console.log(`  - 匹配文件数: ${progress.matchedFiles} 个`);
          console.log(`  - 已扫描目录数: ${progress.scannedDirs} 个`);
          console.log(`  - 已跳过目录数: ${progress.skippedDirs} 个`);
          // console.log(`  - 已处理压缩包数: ${progress.archivesScanned} 个`); // 移除压缩包相关日志
          // console.log(`  - 已处理嵌套压缩包数: ${progress.nestedArchivesScanned || 0} 个`);
          console.log(`  - 已忽略大文件数: ${progress.ignoredLargeFiles} 个`);
          // if (progress.currentNestedLevel && progress.currentNestedLevel > 0) { // 移除压缩包相关日志
          //   console.log(`  - 当前压缩包嵌套层级: ${progress.currentNestedLevel}`);
          // }
        }
      }
    };

    console.log('\n开始扫描、打包和传输 (独立多目录测试)...');
    console.log('RootDirs:', config.rootDirs);
    console.log('OutputDir:', outputDir);
    console.log('ResultsDir:', resultsDir);
    console.log('Skip Dirs (resolved):', (config.skipDirs || []).map(d => path.resolve(testBaseDir, d))); // 相对于 testBaseDir 解析

    // 执行扫描和传输
    const result = await scanAndTransport(config);

    // 输出结果 (保持不变)
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

    console.log(`\n测试基础目录位于: ${testBaseDir}`);
    console.log(`测试源目录: ${testRootDir1}, ${testRootDir2}`);
    console.log(`历史记录文件位置: ${historyFilePath}`);
    console.log('\n再次运行此测试可测试历史去重功能');
  } catch (error) {
    console.error('\n处理过程中出错:', error);
  }
}

// 执行测试
main(); 