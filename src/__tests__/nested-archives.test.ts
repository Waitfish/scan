import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { scanFiles, ScanOptions } from '../index';
import AdmZip from 'adm-zip';

describe('嵌套压缩文件扫描测试', () => {
  // 测试数据准备的基础目录
  const baseTestDir = path.join(os.tmpdir(), 'scan-nested-base-' + Date.now());
  
  // 在所有测试之前创建测试目录
  beforeAll(async () => {
    await fs.ensureDir(baseTestDir);
  });

  // 在所有测试之后清理测试目录
  afterAll(async () => {
    await fs.remove(baseTestDir);
  });

  // 创建单个测试的目录
  async function createTestDir(): Promise<string> {
    const testDir = path.join(baseTestDir, `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    await fs.ensureDir(testDir);
    return testDir;
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
    const { results, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    expect(failures.length).toBe(0);

    // 找到嵌套级别=1的docx文件
    const level1DocxFiles = results.filter(file => 
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
    const { results, failures } = await scanFiles(scanOptions);
    
    // 验证结果
    expect(failures.length).toBe(0);

    // 找到独立提取的docx文件 (nestedLevel=0, origin=archive)
    const standaloneFiles = results.filter(file => 
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
    const { results } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = results.filter(file => 
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
    const { results } = await scanFiles(scanOptions);
    
    // 验证结果 - 不应该找到第6层的文件
    const docxFiles = results.filter(file => 
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
    const { results } = await scanFiles(scanOptions);
    
    // 验证结果 - 不应该找到内部压缩文件中的匹配文件
    const nestedDocxFiles = results.filter(file => 
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
    const { results } = await scanFiles(scanOptions);
    
    // 验证结果
    const docxFiles = results.filter(file => 
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
}); 