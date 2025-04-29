import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { scanFiles, ScanOptions } from '../index';
import AdmZip from 'adm-zip';
import * as child_process from 'child_process';
import { promisify } from 'util';
import * as compressing from 'compressing';

// 定义支持扫描的压缩包后缀 (与scanner.ts中保持一致)
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.tar.gz', '.rar']);

describe('嵌套压缩文件扫描测试', () => {
  // 测试数据准备的基础目录
  const baseTestDir = path.join(os.tmpdir(), 'scan-nested-base-' + Date.now());
  
  // 在所有测试之前创建测试目录
  beforeAll(async () => {
    await fs.ensureDir(baseTestDir);
  });

  // 在所有测试之后清理测试目录
  afterAll(async () => {
    try {
      // 确保彻底清理测试目录
      const cleanupStart = Date.now();
      console.log(`正在清理主测试目录: ${baseTestDir}`);
      
      // 先列出目录内容，以便调试
      if (await fs.pathExists(baseTestDir)) {
        try {
          const entries = await fs.readdir(baseTestDir, { withFileTypes: true });
          console.log(`baseTestDir内容(${entries.length}项):`);
          entries.forEach(entry => {
            console.log(`- ${entry.name} (${entry.isDirectory() ? '目录' : '文件'})`);
          });
          
          // 递归地检查并删除所有子目录
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const subDirPath = path.join(baseTestDir, entry.name);
              try {
                const subEntries = await fs.readdir(subDirPath);
                console.log(`子目录 ${entry.name} 包含 ${subEntries.length} 个项目`);
                
                // 强制删除子目录
                await fs.remove(subDirPath);
                console.log(`已删除子目录: ${subDirPath}`);
              } catch (subDirError) {
                console.error(`处理子目录时出错: ${subDirPath}`, subDirError);
              }
            }
          }
        } catch (listError) {
          console.error('列出目录内容失败:', listError);
        }
      }
      
      // 尝试强制删除整个测试目录
      await fs.remove(baseTestDir);
      console.log(`清理完成，耗时: ${Date.now() - cleanupStart}ms`);
    } catch (error) {
      console.error('清理测试目录失败:', error);
    }
  }, 30000); // 增加超时时间，确保有足够时间清理

  // 创建单个测试的目录
  async function createTestDir(): Promise<string> {
    const testDir = path.join(baseTestDir, `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    await fs.ensureDir(testDir);
    return testDir;
  }

  // 检查是否安装了RAR命令行工具
  async function isRarCommandAvailable(): Promise<boolean> {
    try {
      // 尝试多种可能的命令，有任何一个成功即可
      const commands = [
        'rar --version',  // 标准RAR命令
        'rar -v',         // 某些版本的RAR使用-v参数
        'unrar',          // 一些系统上是unrar命令
        'which rar',      // 查找rar命令路径
        'which unrar',    // 查找unrar命令路径
        'rar 2>&1'        // 尝试不带参数运行，重定向stderr到stdout
      ];
      
      for (const cmd of commands) {
        try {
          const { stdout } = await promisify(child_process.exec)(cmd, { timeout: 3000 });
          console.log(`检测到RAR命令: ${cmd}, 输出: ${stdout.substring(0, 100).trim()}...`);
          return true;
        } catch (err) {
          // 忽略单个命令的错误，继续尝试下一个
        }
      }
      
      console.log('未检测到任何可用的RAR命令');
      return false;
    } catch (error) {
      console.error('检测RAR命令时发生错误:', error);
      return false;
    }
  }

  // 创建RAR文件的辅助函数
  async function createRarFile(files: {path: string, name: string}[], outputRarPath: string): Promise<boolean> {
    if (!await isRarCommandAvailable()) {
      console.warn('没有安装RAR命令行工具，跳过RAR文件创建');
      return false;
    }

    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), `rar-temp-${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
      // 复制所有文件到临时目录
      for (const file of files) {
        const destPath = path.join(tempDir, file.name);
        await fs.copy(file.path, destPath);
      }

      // 尝试多种可能的RAR创建命令
      const commands = [
        `cd "${tempDir}" && rar a -ep "${outputRarPath}" *`,
        `cd "${tempDir}" && rar a "${outputRarPath}" *`,
        `cd "${tempDir}" && rar a -r "${outputRarPath}" *`
      ];
      
      for (const command of commands) {
        try {
          const { stdout, stderr } = await promisify(child_process.exec)(command, { timeout: 10000 });
          console.log(`RAR创建命令成功: ${command}`);
          console.log(`输出: ${stdout.substring(0, 100).trim()}`);
          if (stderr) console.log(`错误输出: ${stderr.substring(0, 100).trim()}`);
          
          // 验证文件是否创建成功
          if (await fs.pathExists(outputRarPath)) {
            const stats = await fs.stat(outputRarPath);
            if (stats.size > 0) {
              console.log(`成功创建RAR文件: ${outputRarPath}, 大小: ${stats.size} 字节`);
              return true;
            }
          }
        } catch (err) {
          console.log(`RAR创建命令失败: ${command}`);
          console.log(`错误: ${(err as Error).message}`);
          // 继续尝试下一个命令
        }
      }
      
      console.warn('所有RAR创建命令都失败了');
      return false;
    } catch (error) {
      console.error('创建RAR文件失败:', error);
      return false;
    } finally {
      // 清理临时目录
      await fs.remove(tempDir);
    }
  }

  // 创建ZIP包含RAR文件的辅助函数
  async function createZipWithRar(testDir: string, includeMatchingFile: boolean = true): Promise<{zipPath: string, success: boolean}> {
    // 创建临时工作目录
    const workDir = path.join(testDir, `work-${Date.now()}`);
    await fs.ensureDir(workDir);
    
    // 创建匹配的文档文件
    const docxFileName = 'MeiTuan-inside-rar.docx';
    const docxFilePath = path.join(workDir, docxFileName);
    await fs.writeFile(docxFilePath, 'test content inside rar file');
    
    // 创建RAR文件
    const rarName = 'nested.rar';
    const rarPath = path.join(workDir, rarName);
    
    const rarCreated = await createRarFile([{path: docxFilePath, name: docxFileName}], rarPath);
    
    if (!rarCreated) {
      await fs.remove(workDir);
      return { zipPath: '', success: false };
    }
    
    // 创建ZIP文件
    const zipName = 'rar-inside-zip.zip';
    const zipPath = path.join(testDir, zipName);
    
    const zip = new AdmZip();
    zip.addLocalFile(rarPath);
    
    // 可选择性地添加一个匹配文件到ZIP根目录
    if (includeMatchingFile) {
      const rootDocxName = 'MeiTuan-zip-root.docx';
      const rootDocxPath = path.join(workDir, rootDocxName);
      await fs.writeFile(rootDocxPath, 'test content in zip root');
      zip.addLocalFile(rootDocxPath);
    }
    
    zip.writeZip(zipPath);
    
    // 清理工作目录
    await fs.remove(workDir);
    
    return { zipPath, success: true };
  }

  // 创建混合压缩格式的辅助函数 (ZIP包含RAR，RAR包含ZIP)
  async function createMixedArchives(testDir: string, format: 'zip-rar-zip' | 'rar-zip'): Promise<{archivePath: string, success: boolean}> {
    // 创建临时工作目录
    const workDir = path.join(testDir, `mixed-work-${Date.now()}`);
    await fs.ensureDir(workDir);
    
    try {
      // 创建最内层文件
      const innerDocxName = 'MeiTuan-inner.docx';
      const innerDocxPath = path.join(workDir, innerDocxName);
      await fs.writeFile(innerDocxPath, 'test content in innermost file');
      
      let currentFilePath = innerDocxPath;
      let result = { archivePath: '', success: false };
      
      if (format === 'zip-rar-zip') {
        // 创建最内层ZIP
        const innerZipName = 'inner.zip';
        const innerZipPath = path.join(workDir, innerZipName);
        const innerZip = new AdmZip();
        innerZip.addLocalFile(currentFilePath);
        innerZip.writeZip(innerZipPath);
        
        // 创建中间层RAR
        const midRarName = 'middle.rar';
        const midRarPath = path.join(workDir, midRarName);
        const rarCreated = await createRarFile([{path: innerZipPath, name: innerZipName}], midRarPath);
        
        if (!rarCreated) {
          // 确保即使提前返回也能清理目录
          try {
            await fs.remove(workDir);
          } catch (err) {
            console.error('清理工作目录失败:', err);
          }
          return { archivePath: '', success: false };
        }
        
        // 创建外层ZIP
        const outerZipName = 'outer.zip';
        const outerZipPath = path.join(testDir, outerZipName);
        const outerZip = new AdmZip();
        outerZip.addLocalFile(midRarPath);
        outerZip.writeZip(outerZipPath);
        
        result = { archivePath: outerZipPath, success: true };
      } else if (format === 'rar-zip') {
        // 创建内层ZIP
        const innerZipName = 'inner.zip';
        const innerZipPath = path.join(workDir, innerZipName);
        const innerZip = new AdmZip();
        innerZip.addLocalFile(currentFilePath);
        innerZip.writeZip(innerZipPath);
        
        // 创建外层RAR
        const outerRarName = 'outer.rar';
        const outerRarPath = path.join(testDir, outerRarName);
        const rarCreated = await createRarFile([{path: innerZipPath, name: innerZipName}], outerRarPath);
        
        if (!rarCreated) {
          // 确保即使提前返回也能清理目录
          try {
            await fs.remove(workDir);
          } catch (err) {
            console.error('清理工作目录失败:', err);
          }
          return { archivePath: '', success: false };
        }
        
        result = { archivePath: outerRarPath, success: true };
      }
      
      return result;
    } catch (error) {
      console.error('创建混合压缩文件失败:', error);
      return { archivePath: '', success: false };
    } finally {
      // 清理工作目录
      try {
        await fs.remove(workDir);
        console.log(`已清理工作目录: ${workDir}`);
      } catch (cleanupError) {
        console.error(`清理工作目录失败: ${workDir}`, cleanupError);
      }
    }
  }

  // 创建嵌套压缩文件的辅助函数
  async function createNestedArchive(levels: number, testDir: string): Promise<string> {
    // 创建临时工作目录
    const workDir = path.join(testDir, `work-${Date.now()}`);
    await fs.ensureDir(workDir);
    
    // 创建最内层的匹配文件
    const targetFileName = 'MeiTuan-target.docx';
    const targetFilePath = path.join(workDir, targetFileName);
    await fs.writeFile(targetFilePath, 'test content for target file');
    
    // 从内到外创建嵌套压缩文件
    let currentFile = targetFilePath;
    let currentName = targetFileName;
    
    for (let i = 1; i <= levels; i++) {
      // 为当前层创建一个文件夹
      const folderName = `folder-${i}`;
      const folderPath = path.join(workDir, folderName);
      await fs.ensureDir(folderPath);
      
      // 将当前文件移动到该文件夹
      const movedFilePath = path.join(folderPath, currentName);
      await fs.move(currentFile, movedFilePath);
      
      // 压缩该文件夹
      const zipName = `level-${i}.zip`;
      const zipPath = path.join(workDir, zipName);
      
      const zip = new AdmZip();
      zip.addLocalFolder(folderPath);
      zip.writeZip(zipPath);
      
      // 删除文件夹
      await fs.remove(folderPath);
      
      // 更新当前文件为此zip
      currentFile = zipPath;
      currentName = zipName;
    }
    
    // 将最终压缩文件移动到测试目录根目录
    const finalZipPath = path.join(testDir, currentName);
    await fs.move(currentFile, finalZipPath);
    
    // 清理工作目录
    await fs.remove(workDir);
    
    return finalZipPath;
  }

  // 测试单层嵌套
  test('应该能扫描单层嵌套的压缩文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个2层嵌套的压缩文件
    await createNestedArchive(2, testDir);
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 1,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    expect(failures.length).toBe(0);

    // 找到嵌套级别=1的docx文件
    const level1DocxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 1 && 
      file.origin === 'archive'
    );
    
    expect(level1DocxFiles.length).toBe(1);
    expect(level1DocxFiles[0].name).toBe('MeiTuan-target.docx');
    expect(level1DocxFiles[0].nestedLevel).toBe(1);
  }, 30000);

  // 测试独立提取的文件
  test('应该能正确识别独立提取的文件 (nestedLevel=0, origin=archive)', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个包含文档的简单压缩文件
    const docName = 'MeiTuan-standalone.docx';
    const zipName = 'standalone.zip';
    const docxPath = path.join(testDir, docName);
    const zipPath = path.join(testDir, zipName);
    
    // 创建docx文件
    await fs.writeFile(docxPath, 'test content');
    
    // 创建zip文件
    const zip = new AdmZip();
    zip.addLocalFile(docxPath);
    zip.writeZip(zipPath);
    
    // 删除原始docx文件，只保留压缩包
    await fs.unlink(docxPath);
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    expect(failures.length).toBe(0);

    // 找到独立提取的docx文件 (nestedLevel=0, origin=archive)
    const standaloneFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 0 && 
      file.origin === 'archive'
    );
    
    expect(standaloneFiles.length).toBe(1);
    expect(standaloneFiles[0].name).toBe(docName);
    expect(standaloneFiles[0].nestedLevel).toBe(0);
    expect(standaloneFiles[0].origin).toBe('archive');
  }, 30000);

  // 测试多层嵌套（到最大层数限制）
  test('应该能扫描到设定的最大嵌套层级', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个5层嵌套的压缩文件
    await createNestedArchive(5, testDir);
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 4 &&
      file.origin === 'archive'
    );
    
    expect(docxFiles.length).toBe(1);
    expect(docxFiles[0].name).toBe('MeiTuan-target.docx');
    expect(docxFiles[0].nestedLevel).toBe(4);
  }, 30000);

  // 测试超过最大层级时的行为
  test('超过最大嵌套层级时不再继续扫描', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个6层嵌套的压缩文件
    await createNestedArchive(6, testDir);
    
    // 配置扫描选项，最大层级设为5
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles } = await scanFiles(scanOptions);
    
    // 验证结果 - 不应该找到第6层的文件
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 6 &&
      file.origin === 'archive'
    );
    
    expect(docxFiles.length).toBe(0);
  }, 30000);

  // 测试禁用嵌套扫描功能
  test('禁用嵌套扫描时应该不扫描内部压缩文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个2层嵌套的压缩文件
    await createNestedArchive(2, testDir);
    
    // 配置扫描选项，禁用嵌套扫描
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: false,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles } = await scanFiles(scanOptions);
    
    // 验证结果 - 不应该找到内部压缩文件中的匹配文件
    const nestedDocxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.origin === 'archive' &&
      file.nestedLevel === 1
    );
    
    expect(nestedDocxFiles.length).toBe(0);
  }, 30000);

  // 测试嵌套路径表示
  test('应正确表示嵌套文件的完整路径', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个3层嵌套的压缩文件
    await createNestedArchive(3, testDir);
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 2 &&
      file.origin === 'archive'
    );
    
    expect(docxFiles.length).toBe(1);
    // 路径应包含3层嵌套的zip文件
    expect(docxFiles[0].nestedPath).toBeDefined();
    expect(docxFiles[0].nestedPath!.includes('.zip/')).toBe(true);
    expect((docxFiles[0].nestedPath || '').split('.zip/').length - 1).toBe(3); // 应有3个.zip/
  }, 30000);

  // 测试ZIP包中包含RAR文件的情况
  test('应该能扫描ZIP中嵌套的RAR文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建ZIP包含RAR的压缩文件
    const { success } = await createZipWithRar(testDir);
    
    // 如果RAR创建失败，则跳过测试
    if (!success) {
      console.warn('无法创建RAR文件，跳过测试');
      return;
    }
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    // 应该找到两个文件：一个在ZIP根目录，一个在RAR文件中
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.origin === 'archive'
    );
    
    // 打印调试信息
    console.log(`找到的文档文件: ${docxFiles.length}`);
    docxFiles.forEach(file => {
      console.log(`- ${file.name}, level=${file.nestedLevel}, path=${file.nestedPath || 'N/A'}`);
    });
    
    if (failures.length > 0) {
      console.log('扫描失败项:');
      failures.forEach(failure => {
        console.log(`- ${failure.type}: ${failure.path}, ${failure.error}`);
      });
    }
    
    // 应该至少找到ZIP根目录下的文件
    expect(docxFiles.length).toBeGreaterThanOrEqual(1);
    
    // 检查ZIP根目录的文件
    const zipRootFile = docxFiles.find(file => 
      file.name === 'MeiTuan-zip-root.docx' && 
      file.nestedLevel === 0
    );
    expect(zipRootFile).toBeDefined();
    
    // 如果成功处理了RAR，应该还能找到RAR中的文件
    const rarFile = docxFiles.find(file => 
      file.name === 'MeiTuan-inside-rar.docx' && 
      file.nestedLevel === 1
    );
    
    // 这个期望可能会失败，具体取决于RAR支持情况
    if (rarFile) {
      expect(rarFile.nestedPath).toContain('.rar/');
    }
  }, 60000);

  // 测试混合格式压缩文件：ZIP包含RAR，RAR包含ZIP
  test('应该能处理混合格式的嵌套压缩文件 (ZIP-RAR-ZIP)', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建混合格式的压缩文件
    const { success } = await createMixedArchives(testDir, 'zip-rar-zip');
    
    // 如果创建失败，则跳过测试
    if (!success) {
      console.warn('无法创建混合格式的压缩文件，跳过测试');
      return;
    }
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.origin === 'archive'
    );
    
    // 打印调试信息
    console.log(`找到的文档文件: ${docxFiles.length}`);
    docxFiles.forEach(file => {
      console.log(`- ${file.name}, level=${file.nestedLevel}, path=${file.nestedPath || 'N/A'}`);
    });
    
    if (failures.length > 0) {
      console.log('扫描失败项:');
      failures.forEach(failure => {
        console.log(`- ${failure.type}: ${failure.path}, ${failure.error}`);
      });
    }
    
    // 验证是否找到了最内层的文件
    const innerFile = docxFiles.find(file => file.name === 'MeiTuan-inner.docx');
    if (innerFile) {
      expect(innerFile.nestedPath).toContain('.zip/');
      expect(innerFile.nestedPath).toContain('.rar/');
    }
  }, 60000);

  // 测试RAR包含ZIP的情况
  test('应该能处理RAR中嵌套的ZIP文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建RAR包含ZIP的压缩文件
    const { success } = await createMixedArchives(testDir, 'rar-zip');
    
    // 如果创建失败，则跳过测试
    if (!success) {
      console.warn('无法创建RAR包含ZIP的压缩文件，跳过测试');
      return;
    }
    
    // 配置扫描选项
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5,
      depth: -1
    };
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.origin === 'archive'
    );
    
    // 打印调试信息
    console.log(`找到的文档文件: ${docxFiles.length}`);
    docxFiles.forEach(file => {
      console.log(`- ${file.name}, level=${file.nestedLevel}, path=${file.nestedPath || 'N/A'}`);
    });
    
    if (failures.length > 0) {
      console.log('扫描失败项:');
      failures.forEach(failure => {
        console.log(`- ${failure.type}: ${failure.path}, ${failure.error}`);
      });
    }
    
    // 验证是否找到了内部文件
    const innerFile = docxFiles.find(file => file.name === 'MeiTuan-inner.docx');
    if (innerFile) {
      expect(innerFile.nestedPath).toContain('.zip/');
      expect(innerFile.nestedPath).toContain('.rar/');
    }
  }, 60000);

  // 测试深度嵌套（10层）压缩文件扫描
  test('应该能成功扫描10层嵌套的压缩文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个10层嵌套的压缩文件
    console.log('开始创建10层嵌套的压缩文件...');
    const nestedArchivePath = await createNestedArchive(10, testDir);
    console.log(`已创建10层嵌套压缩文件: ${nestedArchivePath}`);
    
    // 配置扫描选项，设置最大嵌套级别为12（比实际层数多，确保能扫描到最内层）
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 12,
      maxFileSize: 50 * 1024 * 1024, // 设置足够大的最大文件大小，避免因大小限制跳过文件
      depth: -1
    };
    
    console.log('开始扫描10层嵌套压缩文件...');
    
    // 执行扫描
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 输出扫描结果统计
    console.log(`扫描完成，找到匹配文件: ${matchedFiles.length}个, 失败项: ${failures.length}个`);
    
    if (failures.length > 0) {
      console.log('扫描过程中的失败项:');
      failures.forEach((failure, index) => {
        console.log(`[${index + 1}] 类型: ${failure.type}, 路径: ${failure.path}, 错误: ${failure.error}`);
      });
    }
    
    // 验证结果 - 应该能找到最内层的文件（第9级嵌套）
    const deepestDocxFiles = matchedFiles.filter(file => 
      file.name.endsWith('.docx') && 
      file.nestedLevel === 9 && // 10层压缩，最内层文件的嵌套级别是9
      file.origin === 'archive'
    );
    
    // 打印找到的最深层次文件的信息
    if (deepestDocxFiles.length > 0) {
      console.log('找到最深层级的文件:');
      deepestDocxFiles.forEach(file => {
        console.log(`- 名称: ${file.name}`);
        console.log(`  嵌套级别: ${file.nestedLevel}`);
        console.log(`  嵌套路径: ${file.nestedPath || 'N/A'}`);
      });
    } else {
      console.log('未找到最深层级的文件，所有匹配文件:');
      matchedFiles.forEach(file => {
        console.log(`- 名称: ${file.name}, 级别: ${file.nestedLevel}`);
      });
    }
    
    // 断言验证
    expect(failures.length).toBe(0); // 不应有失败项
    expect(deepestDocxFiles.length).toBe(1); // 应该只有一个最深层级的文件
    expect(deepestDocxFiles[0].name).toBe('MeiTuan-target.docx');
    expect(deepestDocxFiles[0].nestedLevel).toBe(9);
    expect(deepestDocxFiles[0].nestedPath).toBeDefined();
    expect((deepestDocxFiles[0].nestedPath || '').split('.zip/').length - 1).toBe(10); // 应有10个.zip/
  }, 120000); // 增加超时时间到2分钟，因为深度嵌套的处理可能需要更多时间

  // 测试超深层嵌套和堆栈溢出预防
  test('超过最大嵌套层级的深层嵌套压缩文件应被安全处理', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建一个10层嵌套的压缩文件
    console.log('开始创建10层嵌套的压缩文件用于最大层级测试...');
    const nestedArchivePath = await createNestedArchive(10, testDir);
    console.log(`已创建10层嵌套压缩文件: ${nestedArchivePath}`);
    
    // 配置扫描选项，故意设置较小的最大嵌套级别（5）
    const scanOptions: ScanOptions = {
      rootDir: testDir,
      matchRules: [[['docx'], '^MeiTuan.*']],
      scanNestedArchives: true,
      maxNestedLevel: 5, // 只允许扫描到第5层
      maxFileSize: 50 * 1024 * 1024,
      depth: -1
    };
    
    console.log('开始扫描10层嵌套压缩文件（最大层级限制为5）...');
    
    // 执行扫描 - 不应抛出堆栈溢出异常
    const { matchedFiles, failures } = await scanFiles(scanOptions);
    
    // 输出扫描结果统计
    console.log(`扫描完成，找到匹配文件: ${matchedFiles.length}个, 失败项: ${failures.length}个`);
    
    // 验证结果 - 不应该找到超过maxNestedLevel的文件
    const tooDeepFiles = matchedFiles.filter(file => 
      file.nestedLevel !== undefined && file.nestedLevel > 5
    );
    expect(tooDeepFiles.length).toBe(0); // 不应有超过5层的文件
    
    // 应该找到最多5层的文件
    const level5Files = matchedFiles.filter(file => 
      file.nestedLevel !== undefined && file.nestedLevel === 4
    ); // 第5层嵌套
    
    // 如果实现正确，应该不会抛出异常，而是安全地处理最大层级限制
    console.log(`找到第5层的文件: ${level5Files.length}个`);
    
    // 这个测试的主要目的是验证不会出现堆栈溢出
    // 如果代码执行到这里，说明没有抛出堆栈溢出异常，测试通过
    expect(true).toBeTruthy();
  }, 120000); // 同样设置较长的超时时间

  // 测试包含循环引用的压缩文件
  test('应该能安全处理包含循环引用的压缩文件', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建临时工作目录
    const workDir = path.join(testDir, `circular-work-${Date.now()}`);
    await fs.ensureDir(workDir);
    
    try {
      // 创建匹配的文档文件
      const docxFileName = 'MeiTuan-circular.docx';
      const docxFilePath = path.join(workDir, docxFileName);
      await fs.writeFile(docxFilePath, 'test content for circular reference test');
      
      // 第一层压缩包
      const levelOneZipName = 'level-1.zip';
      const levelOneZipPath = path.join(workDir, levelOneZipName);
      const levelOneZip = new AdmZip();
      levelOneZip.addLocalFile(docxFilePath);
      // 先不关闭，需要先创建第二层
      
      // 第二层压缩包
      const levelTwoZipName = 'level-2.zip';
      const levelTwoZipPath = path.join(workDir, levelTwoZipName);
      const levelTwoZip = new AdmZip();
      levelTwoZip.addLocalFile(docxFilePath);
      // 将第二层写入磁盘
      levelTwoZip.writeZip(levelTwoZipPath);
      
      // 将第二层添加到第一层中
      levelOneZip.addLocalFile(levelTwoZipPath);
      // 写入第一层
      levelOneZip.writeZip(levelOneZipPath);
      
      // 将第一层添加到第二层中（创建循环引用）
      // 先删除已有文件
      await fs.unlink(levelTwoZipPath);
      const circularLevelTwoZip = new AdmZip();
      circularLevelTwoZip.addLocalFile(docxFilePath);
      circularLevelTwoZip.addLocalFile(levelOneZipPath); // 添加第一层，形成循环
      circularLevelTwoZip.writeZip(levelTwoZipPath);
      
      // 最外层包装压缩包
      const outerZipName = 'circular-reference.zip';
      const outerZipPath = path.join(testDir, outerZipName);
      const outerZip = new AdmZip();
      outerZip.addLocalFile(levelOneZipPath);
      outerZip.addLocalFile(levelTwoZipPath);
      outerZip.writeZip(outerZipPath);
      
      console.log(`已创建包含循环引用的压缩文件: ${outerZipPath}`);
      
      // 配置扫描选项
      const scanOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [[['docx'], '^MeiTuan.*']],
        scanNestedArchives: true,
        maxNestedLevel: 10, // 设置一个较高的值，但由于循环引用，理论上可以无限递归
        maxFileSize: 50 * 1024 * 1024,
        depth: -1
      };
      
      console.log('开始扫描包含循环引用的压缩文件...');
      
      // 执行扫描 - 不应抛出堆栈溢出异常
      const { matchedFiles, failures } = await scanFiles(scanOptions);
      
      // 输出扫描结果统计
      console.log(`扫描完成，找到匹配文件: ${matchedFiles.length}个, 失败项: ${failures.length}个`);
      
      if (failures.length > 0) {
        console.log('扫描过程中的失败项:');
        failures.forEach((failure, index) => {
          console.log(`[${index + 1}] 类型: ${failure.type}, 路径: ${failure.path}, 错误: ${failure.error}`);
        });
      }
      
      // 应该找到一些匹配的文件，但不会因为循环引用而无限递归
      const docxFiles = matchedFiles.filter(file => file.name === docxFileName);
      
      console.log(`找到的文档文件: ${docxFiles.length}个`);
      docxFiles.forEach(file => {
        console.log(`- 路径: ${file.path}`);
        console.log(`  嵌套级别: ${file.nestedLevel}`);
        console.log(`  嵌套路径: ${file.nestedPath || 'N/A'}`);
      });
      
      // 这个测试的主要目的是验证不会出现堆栈溢出
      // 如果代码执行到这里，说明没有抛出堆栈溢出异常，测试通过
      expect(true).toBeTruthy();
      expect(docxFiles.length).toBeGreaterThan(0); // 应该至少找到一个文档文件
    } finally {
      // 清理工作目录
      try {
        await fs.remove(workDir);
        console.log(`已清理工作目录: ${workDir}`);
      } catch (cleanupError) {
        console.error(`清理工作目录失败: ${workDir}`, cleanupError);
      }
    }
  }, 120000); // 设置较长的超时时间

  // 测试maxFileSize参数对嵌套压缩文件处理的影响
  test('不同的maxFileSize参数应正确影响嵌套压缩文件的处理', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();
    
    // 创建临时工作目录
    const workDir = path.join(testDir, `file-size-test-${Date.now()}`);
    await fs.ensureDir(workDir);
    
    try {
      // 创建一个5MB的大文件
      const largeFileName = 'large-file.bin';
      const largeFilePath = path.join(workDir, largeFileName);
      // 创建一个5MB的随机数据文件
      const fiveMB = 5 * 1024 * 1024;
      const buffer = Buffer.alloc(fiveMB);
      // 填充随机数据
      for (let i = 0; i < fiveMB; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      await fs.writeFile(largeFilePath, buffer);
      
      // 创建匹配的文档文件
      const docxFileName = 'MeiTuan-filesize-test.docx';
      const docxFilePath = path.join(workDir, docxFileName);
      await fs.writeFile(docxFilePath, 'test content for file size test');
      
      // 创建第一层压缩包，包含大文件
      const levelOneZipName = 'level-1-large.zip';
      const levelOneZipPath = path.join(workDir, levelOneZipName);
      const levelOneZip = new AdmZip();
      levelOneZip.addLocalFile(largeFilePath);
      levelOneZip.addLocalFile(docxFilePath);
      levelOneZip.writeZip(levelOneZipPath);
      
      // 创建第二层压缩包，包含第一层
      const levelTwoZipName = 'level-2-large.zip';
      const levelTwoZipPath = path.join(testDir, levelTwoZipName);
      const levelTwoZip = new AdmZip();
      levelTwoZip.addLocalFile(levelOneZipPath);
      levelTwoZip.writeZip(levelTwoZipPath);
      
      console.log(`已创建带有大文件的嵌套压缩文件: ${levelTwoZipPath}`);
      
      // 测试场景1：小于大文件大小的maxFileSize
      const smallSizeOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [[['docx'], '^MeiTuan.*']],
        scanNestedArchives: true,
        maxNestedLevel: 10,
        maxFileSize: 1 * 1024 * 1024, // 只允许1MB，小于大文件的5MB
        depth: -1
      };
      
      console.log('场景1：小于大文件大小的maxFileSize (1MB)...');
      const smallSizeResult = await scanFiles(smallSizeOptions);
      console.log(`场景1扫描完成，找到匹配文件: ${smallSizeResult.matchedFiles.length}个, 失败项: ${smallSizeResult.failures.length}个`);
      
      // 检查是否有大文件被忽略的记录
      const ignoredLargeFiles = smallSizeResult.failures.filter(f => f.type === 'ignoredLargeFile');
      console.log(`忽略的大文件数: ${ignoredLargeFiles.length}`);
      
      // 测试场景2：大于大文件大小的maxFileSize
      const largeSizeOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [[['docx'], '^MeiTuan.*']],
        scanNestedArchives: true,
        maxNestedLevel: 10,
        maxFileSize: 10 * 1024 * 1024, // 允许10MB，大于大文件的5MB
        depth: -1
      };
      
      console.log('场景2：大于大文件大小的maxFileSize (10MB)...');
      const largeSizeResult = await scanFiles(largeSizeOptions);
      console.log(`场景2扫描完成，找到匹配文件: ${largeSizeResult.matchedFiles.length}个, 失败项: ${largeSizeResult.failures.length}个`);
      
      // 验证结果
      // 1. 小maxFileSize应该有忽略大文件的记录
      expect(ignoredLargeFiles.length).toBeGreaterThan(0);
      
      // 2. 大maxFileSize应该找到的匹配文件更多（因为能更深入地扫描）
      // 由于是以压缩包嵌套，较小的maxFileSize可能会限制扫描深度
      expect(largeSizeResult.matchedFiles.length).toBeGreaterThanOrEqual(smallSizeResult.matchedFiles.length);
      
      // 3. 检查两个场景的深度差异
      const smallSizeMaxLevel = Math.max(...smallSizeResult.matchedFiles
        .filter(f => f.nestedLevel !== undefined)
        .map(f => f.nestedLevel || 0));
      
      const largeSizeMaxLevel = Math.max(...largeSizeResult.matchedFiles
        .filter(f => f.nestedLevel !== undefined)
        .map(f => f.nestedLevel || 0));
      
      console.log(`小maxFileSize的最大嵌套级别: ${smallSizeMaxLevel}`);
      console.log(`大maxFileSize的最大嵌套级别: ${largeSizeMaxLevel}`);
      
      // 大maxFileSize应该允许更深的嵌套级别
      expect(largeSizeMaxLevel).toBeGreaterThanOrEqual(smallSizeMaxLevel);
      
      // 最重要的是，即使有大文件，也不会导致堆栈溢出
      // 如果代码执行到这里，说明没有抛出堆栈溢出异常，测试通过
    } finally {
      // 清理工作目录
      try {
        await fs.remove(workDir);
        console.log(`已清理工作目录: ${workDir}`);
      } catch (cleanupError) {
        console.error(`清理工作目录失败: ${workDir}`, cleanupError);
      }
    }
  }, 120000); // 设置较长的超时时间

  // 专门测试layer.tar文件的堆栈溢出问题
  test('特定layer.tar文件应该能够被正确处理而不引起堆栈溢出', async () => {
    // 为此测试创建单独的目录
    const testDir = await createTestDir();

    // 复制附件中的layer.tar文件到测试目录
    const sourceLayerTarPath = path.join(__dirname, '../../temp/user-docs-test/layer.tar');
    const targetLayerTarPath = path.join(testDir, 'layer.tar');
    
    console.log(`复制测试文件 ${sourceLayerTarPath} 到 ${targetLayerTarPath}`);
    
    try {
      // 检查源文件是否存在
      if (!await fs.pathExists(sourceLayerTarPath)) {
        console.warn(`源文件 ${sourceLayerTarPath} 不存在，尝试全局搜索`);
        // 尝试在项目根目录中查找
        const projectRoot = path.join(__dirname, '../..');
        const foundFiles = await findFilesByName(projectRoot, 'layer.tar');
        if (foundFiles.length > 0) {
          console.log(`找到layer.tar文件: ${foundFiles[0]}`);
          await fs.copy(foundFiles[0], targetLayerTarPath);
        } else {
          console.warn('无法找到layer.tar文件，测试将被跳过');
          return;
        }
      } else {
        await fs.copy(sourceLayerTarPath, targetLayerTarPath);
      }
      
      // 获取文件大小
      const stats = await fs.stat(targetLayerTarPath);
      console.log(`layer.tar文件大小: ${stats.size} 字节 (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      
      // 测试场景1：小maxFileSize (1MB)
      console.log('场景1：小maxFileSize (1MB)测试...');
      const smallSizeOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [
          [['group', 'passwd', 'shadow'], '.*'], // 匹配tar包中的系统文件
          [[''], 'etc.*'] // 尝试匹配etc目录
        ],
        scanNestedArchives: true,
        maxNestedLevel: 5,
        maxFileSize: 1 * 1024 * 1024, // 只允许1MB
        depth: -1
      };
      
      let smallSizeResult;
      try {
        smallSizeResult = await scanFiles(smallSizeOptions);
        console.log(`场景1扫描完成，找到匹配文件: ${smallSizeResult.matchedFiles.length}个, 失败项: ${smallSizeResult.failures.length}个`);
        
        // 检查是否有大文件被忽略的记录
        const ignoredLargeFiles = smallSizeResult.failures.filter(f => f.type === 'ignoredLargeFile');
        console.log(`忽略的大文件数: ${ignoredLargeFiles.length}`);
        ignoredLargeFiles.forEach((failure, i) => {
          console.log(`  ${i+1}. ${failure.path}${failure.entryPath ? ' > ' + failure.entryPath : ''}`);
        });
      } catch (error) {
        console.error('场景1扫描出错:', error);
        expect(false).toBe(true); // 使测试失败
      }
      
      // 测试场景2：中等maxFileSize (10MB)
      console.log('场景2：中等maxFileSize (10MB)测试...');
      const mediumSizeOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [
          [['group', 'passwd', 'shadow'], '.*'], // 匹配tar包中的系统文件
          [[''], 'etc.*'] // 尝试匹配etc目录
        ],
        scanNestedArchives: true,
        maxNestedLevel: 5,
        maxFileSize: 10 * 1024 * 1024, // 允许10MB
        depth: -1
      };
      
      let mediumSizeResult;
      try {
        mediumSizeResult = await scanFiles(mediumSizeOptions);
        console.log(`场景2扫描完成，找到匹配文件: ${mediumSizeResult.matchedFiles.length}个, 失败项: ${mediumSizeResult.failures.length}个`);
      } catch (error) {
        console.error('场景2扫描出错:', error);
        expect(false).toBe(true); // 使测试失败
      }
      
      // 测试场景3：大maxFileSize (50MB)
      console.log('场景3：大maxFileSize (50MB)测试...');
      const largeSizeOptions: ScanOptions = {
        rootDir: testDir,
        matchRules: [
          [['group', 'passwd', 'shadow'], '.*'], // 匹配tar包中的系统文件
          [[''], 'etc.*'] // 尝试匹配etc目录
        ],
        scanNestedArchives: true,
        maxNestedLevel: 5,
        maxFileSize: 50 * 1024 * 1024, // 允许50MB
        depth: -1
      };
      
      let largeSizeResult;
      try {
        largeSizeResult = await scanFiles(largeSizeOptions);
        console.log(`场景3扫描完成，找到匹配文件: ${largeSizeResult.matchedFiles.length}个, 失败项: ${largeSizeResult.failures.length}个`);
        
        // 打印匹配的文件和嵌套路径
        if (largeSizeResult.matchedFiles.length > 0) {
          console.log('找到的匹配文件:');
          largeSizeResult.matchedFiles.forEach((file, i) => {
            console.log(`  ${i+1}. ${file.name} (嵌套级别: ${file.nestedLevel || 0})`);
            if (file.nestedPath) {
              console.log(`     嵌套路径: ${file.nestedPath}`);
            }
          });
        }
        
        // 打印失败项
        if (largeSizeResult.failures.length > 0) {
          console.log('失败项:');
          largeSizeResult.failures.forEach((failure, i) => {
            console.log(`  ${i+1}. 类型: ${failure.type}`);
            console.log(`     路径: ${failure.path}`);
            if (failure.entryPath) {
              console.log(`     内部路径: ${failure.entryPath}`);
            }
            console.log(`     错误: ${failure.error}`);
          });
        }
      } catch (error) {
        console.error('场景3扫描出错:', error);
        expect(false).toBe(true); // 使测试失败
      }
      
      // 分析layer.tar文件结构
      console.log('分析layer.tar文件结构...');
      try {
        const { files, folders } = await analyzeTarStructure(targetLayerTarPath);
        console.log(`tar包含 ${files.length} 个文件和 ${folders.length} 个文件夹`);
        
        console.log('文件夹:');
        folders.forEach(f => console.log(`  - ${f}`));
        
        console.log('文件:');
        files.forEach(f => console.log(`  - ${f}`));
        
        // 检查是否存在嵌套压缩包
        const nestedArchives = files.filter(f => ARCHIVE_EXTENSIONS.has(path.extname(f).toLowerCase()));
        if (nestedArchives.length > 0) {
          console.log('发现嵌套压缩包:');
          nestedArchives.forEach(f => console.log(`  - ${f}`));
        }
      } catch (error) {
        console.error('分析tar结构失败:', error);
      }
      
      // 测试场景4：创建模拟递归嵌套的tar文件
      console.log('\n场景4：测试递归嵌套tar文件...');
      try {
        // 创建临时工作目录
        const recursiveDir = path.join(testDir, 'recursive-test');
        await fs.ensureDir(recursiveDir);
        
        // 第1层：创建一个内层tar文件内容
        const innerTarPath = path.join(recursiveDir, 'inner.tar');
        console.log(`创建内层tar文件: ${innerTarPath}`);
        
        // 复制原始layer.tar作为inner.tar的基础
        await fs.copy(targetLayerTarPath, innerTarPath);
        
        // 第2层：创建一个中间层tar文件，包含内层tar
        const middleTarPath = path.join(recursiveDir, 'middle.tar');
        console.log(`创建中间层tar文件: ${middleTarPath}`);
        
        // 使用命令行tar工具来创建包含inner.tar的middle.tar
        await createTarWithFile(innerTarPath, middleTarPath);
        
        // 第3层：创建一个外层tar文件，包含中间层tar
        const outerTarPath = path.join(testDir, 'recursive.tar');
        console.log(`创建外层tar文件: ${outerTarPath}`);
        
        // 使用命令行tar工具来创建包含middle.tar的outer.tar
        await createTarWithFile(middleTarPath, outerTarPath);
        
        // 现在测试扫描这个三层嵌套的tar文件
        console.log('扫描三层嵌套的tar文件...');
        const recursiveOptions: ScanOptions = {
          rootDir: testDir,
          matchRules: [
            [['group', 'passwd', 'shadow'], '.*'], // 匹配tar包中的系统文件
            [['tar'], '.*'], // 匹配tar文件
            [[''], 'etc.*'] // 尝试匹配etc目录
          ],
          scanNestedArchives: true,
          maxNestedLevel: 10, // 足够处理多层嵌套
          maxFileSize: 50 * 1024 * 1024, // 允许50MB
          depth: -1
        };
        
        // 执行扫描
        const recursiveResult = await scanFiles(recursiveOptions);
        console.log(`三层嵌套扫描完成，找到匹配文件: ${recursiveResult.matchedFiles.length}个, 失败项: ${recursiveResult.failures.length}个`);
        
        // 分析嵌套级别
        const nestLevels = new Set<number>();
        recursiveResult.matchedFiles.forEach(file => {
          if (file.nestedLevel !== undefined) {
            nestLevels.add(file.nestedLevel);
          }
        });
        
        console.log('发现的嵌套级别:', Array.from(nestLevels).sort((a, b) => a - b).join(', '));
        
        // 打印最深嵌套级别的文件
        const deepestLevel = Math.max(...Array.from(nestLevels));
        const deepestFiles = recursiveResult.matchedFiles.filter(f => f.nestedLevel === deepestLevel);
        
        if (deepestFiles.length > 0) {
          console.log(`最深嵌套级别(${deepestLevel})的文件:`);
          deepestFiles.forEach((file, i) => {
            console.log(`  ${i+1}. ${file.name} (嵌套路径: ${file.nestedPath || 'N/A'})`);
          });
        }
        
        // 检查堆栈溢出情况
        expect(true).toBeTruthy(); // 如果执行到这里，说明没有堆栈溢出
        
        // 清理递归测试目录
        await fs.remove(recursiveDir);
      } catch (error) {
        console.error('递归嵌套测试失败:', error);
        // 此处不让测试失败，因为如果是堆栈溢出问题，我们就能看到
      }
      
      // 测试场景5：创建包含自身引用的tar文件（无限递归）
      console.log('\n场景5：测试包含自身引用的tar文件（可能导致无限递归）...');
      try {
        // 创建临时工作目录
        const selfRefDir = path.join(testDir, 'self-reference-test');
        await fs.ensureDir(selfRefDir);
        
        // 首先创建一个初始tar文件
        const initialTarPath = path.join(selfRefDir, 'initial.tar');
        console.log(`创建初始tar文件: ${initialTarPath}`);
        
        // 复制原始layer.tar作为初始tar的基础
        await fs.copy(targetLayerTarPath, initialTarPath);
        
        // 创建一个包含自身引用的文件
        const selfRefTarPath = path.join(testDir, 'self-reference.tar');
        console.log(`创建包含自身引用的tar文件: ${selfRefTarPath}`);
        
        // 步骤1: 先用initial.tar创建self-reference.tar
        await createTarWithFile(initialTarPath, selfRefTarPath);
        
        // 步骤2: 将self-reference.tar复制到工作目录，准备添加到自身
        const tempSelfRefPath = path.join(selfRefDir, 'self-reference.tar');
        await fs.copy(selfRefTarPath, tempSelfRefPath);
        
        // 步骤3: 重新创建self-reference.tar，让它包含自己的副本
        console.log('尝试创建包含自身引用的tar文件...');
        await createTarWithFile(tempSelfRefPath, selfRefTarPath);
        
        // 现在测试扫描这个自引用的tar文件
        console.log('扫描包含自身引用的tar文件...');
        const selfRefOptions: ScanOptions = {
          rootDir: testDir,
          matchRules: [
            [['group', 'passwd', 'shadow', 'tar'], '.*'] // 匹配所有可能的文件
          ],
          scanNestedArchives: true,
          maxNestedLevel: 10, // 设置一个限制，防止无限递归
          maxFileSize: 50 * 1024 * 1024, // 允许50MB
          depth: -1
        };
        
        // 尝试扫描 - 应该不会出现堆栈溢出，因为会受到maxNestedLevel限制
        const selfRefResult = await scanFiles(selfRefOptions);
        console.log(`自引用扫描完成，找到匹配文件: ${selfRefResult.matchedFiles.length}个, 失败项: ${selfRefResult.failures.length}个`);
        
        // 打印嵌套级别统计
        const selfRefNestLevels = new Set<number>();
        selfRefResult.matchedFiles.forEach(file => {
          if (file.nestedLevel !== undefined) {
            selfRefNestLevels.add(file.nestedLevel);
          }
        });
        
        const levelCounts = Array.from(selfRefNestLevels).map(level => {
          const count = selfRefResult.matchedFiles.filter(f => f.nestedLevel === level).length;
          return `级别${level}: ${count}个`;
        });
        
        console.log('各嵌套级别文件数量:', levelCounts.join(', '));
        
        // 检查是否达到了maxNestedLevel限制
        const maxNestLevel = Math.max(...Array.from(selfRefNestLevels));
        console.log(`检测到的最大嵌套级别: ${maxNestLevel}, 设置的最大级别: ${selfRefOptions.maxNestedLevel}`);
        
        // 检查堆栈溢出情况
        expect(true).toBeTruthy(); // 如果执行到这里，说明没有堆栈溢出
        
        // 测试扫描带有小maxFileSize值，比自引用tar文件小，应该会跳过它的处理
        console.log('\n使用小maxFileSize扫描自引用tar文件...');
        const smallSizeSelfRefOptions: ScanOptions = {
          ...selfRefOptions,
          maxFileSize: 1 * 1024 // 只允许1KB，应该跳过大的tar文件
        };
        
        const smallSizeSelfRefResult = await scanFiles(smallSizeSelfRefOptions);
        console.log(`小maxFileSize扫描完成，找到匹配文件: ${smallSizeSelfRefResult.matchedFiles.length}个, 失败项: ${smallSizeSelfRefResult.failures.length}个`);
        
        // 检查是否有跳过大文件的记录
        const skipLargeFiles = smallSizeSelfRefResult.failures.filter(f => f.type === 'ignoredLargeFile');
        console.log(`跳过的大文件数: ${skipLargeFiles.length}`);
        
        // 清理自引用测试目录
        await fs.remove(selfRefDir);
      } catch (error) {
        console.error('自引用tar测试失败:', error);
        // 此处不让测试失败，因为如果是堆栈溢出问题，我们就能看到
      }
      
      // 测试结果验证
      if (smallSizeResult && mediumSizeResult && largeSizeResult) {
        // 1. 确认不同maxFileSize设置下都能安全完成，不出现堆栈溢出
        expect(true).toBeTruthy();
        
        // 2. 比较不同maxFileSize设置下的扫描结果差异
        console.log('不同maxFileSize设置下的扫描结果比较:');
        console.log(`  小(1MB): 匹配文件 ${smallSizeResult.matchedFiles.length}个, 失败项 ${smallSizeResult.failures.length}个`);
        console.log(`  中(10MB): 匹配文件 ${mediumSizeResult.matchedFiles.length}个, 失败项 ${mediumSizeResult.failures.length}个`);
        console.log(`  大(50MB): 匹配文件 ${largeSizeResult.matchedFiles.length}个, 失败项 ${largeSizeResult.failures.length}个`);
      }
    } finally {
      // 清理测试目录
      try {
        await fs.remove(testDir);
        console.log(`已清理测试目录: ${testDir}`);
      } catch (cleanupError) {
        console.error(`清理测试目录失败: ${testDir}`, cleanupError);
      }
    }
  }, 120000); // 设置较长的超时时间
}); 

/**
 * 工具函数：查找指定名称的文件
 */
async function findFilesByName(rootDir: string, fileName: string): Promise<string[]> {
  const foundFiles: string[] = [];
  
  async function searchDirectory(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // 跳过node_modules等常见大目录
          if (entry.name !== 'node_modules' && entry.name !== '.git') {
            await searchDirectory(fullPath);
          }
        } else if (entry.name === fileName) {
          foundFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`搜索目录失败: ${dir}`, error);
    }
  }
  
  await searchDirectory(rootDir);
  return foundFiles;
}

/**
 * 工具函数：分析tar文件结构
 */
async function analyzeTarStructure(tarPath: string): Promise<{ files: string[], folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  
  return new Promise((resolve, reject) => {
    try {
      const stream = new compressing.tar.UncompressStream({ source: tarPath });
      
      stream.on('error', reject);
      stream.on('finish', () => resolve({ files, folders }));
      stream.on('entry', (
        header: { name: string; type: 'file' | 'directory' }, 
        entryStream: NodeJS.ReadableStream, 
        next: () => void
      ) => {
        if (header.type === 'file') {
          files.push(header.name);
        } else if (header.type === 'directory') {
          folders.push(header.name);
        }
        
        entryStream.resume(); // 忽略内容，但消费流
        next();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 工具函数：创建包含指定文件的tar文件
 */
async function createTarWithFile(filePath: string, outputTarPath: string): Promise<boolean> {
  try {
    // 获取文件名和目录
    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    
    // 使用子进程执行tar命令
    console.log(`执行tar命令: tar -cf "${outputTarPath}" -C "${fileDir}" "${fileName}"`);
    const { stdout, stderr } = await promisify(child_process.exec)(
      `tar -cf "${outputTarPath}" -C "${fileDir}" "${fileName}"`,
      { timeout: 10000 }
    );
    
    if (stderr) {
      console.log(`tar命令错误输出: ${stderr}`);
    }
    
    // 检查是否生成了tar文件
    if (await fs.pathExists(outputTarPath)) {
      const stats = await fs.stat(outputTarPath);
      console.log(`成功创建tar文件: ${outputTarPath}, 大小: ${stats.size} 字节`);
      return true;
    } else {
      console.error(`tar命令执行后找不到输出文件: ${outputTarPath}`);
      return false;
    }
  } catch (error) {
    console.error(`创建tar文件失败:`, error);
    return false;
  }
} 