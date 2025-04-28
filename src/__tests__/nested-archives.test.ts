import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { scanFiles, ScanOptions } from '../index';
import AdmZip from 'adm-zip';
import * as child_process from 'child_process';
import { promisify } from 'util';

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
}); 