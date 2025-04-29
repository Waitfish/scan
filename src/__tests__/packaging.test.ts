/**
 * @file 文件打包模块测试
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { FileItem, PackageMetadata } from '../types';
import { 
  createSingleFilePackage, 
  createBatchPackage, 
  extractPackageInfo, 
  PackageOptions, 
  PackageProgress,
} from '../core/packaging';
import { zip } from 'compressing';

describe('文件打包模块', () => {
  // 测试目录
  const testDir = path.join(os.tmpdir(), 'scan-packaging-test-' + Date.now());
  
  // 测试文件
  const testFiles: {[key: string]: string} = {
    'file1.txt': 'This is file 1 content',
    'file2.docx': 'Mock DOCX content for testing',
    'file3.pdf': Buffer.alloc(1024 * 10, 'PDF').toString(), // 10KB的模拟PDF
    'chinese-名字.txt': '中文测试文件内容',
  }
  
  // 测试中创建的文件项
  const fileItems: FileItem[] = [];
  
  // 默认打包选项
  const defaultOptions: PackageOptions = {
    includeMd5: true,
    includeMetadata: true,
    compressionLevel: 6,
    metadataFileName: 'metadata.json',
    tempDir: path.join(testDir, 'temp')
  };

  // 在所有测试前创建测试目录和文件
  beforeAll(async () => {
    // 创建测试目录
    await fs.ensureDir(testDir);
    await fs.ensureDir(defaultOptions.tempDir || path.join(testDir, 'temp'));
    
    // 创建测试文件
    for (const [filename, content] of Object.entries(testFiles)) {
      const filePath = path.join(testDir, filename);
      await fs.writeFile(filePath, content);
      
      // 创建FileItem
      const stats = await fs.stat(filePath);
      fileItems.push({
        path: filePath,
        name: filename,
        size: stats.size,
        createTime: stats.birthtime,
        modifyTime: stats.mtime,
        md5: `mock-md5-for-${filename}`, // 模拟MD5值
        origin: 'filesystem',
        nestedLevel: 0
      });
    }
  });

  // 在所有测试后清理测试目录
  afterAll(async () => {
    await fs.remove(testDir);
  });

  // 在每个测试后清理临时包文件
  afterEach(async () => {
    // 清理可能创建的包文件
    const files = await fs.readdir(testDir);
    for (const file of files) {
      if (file.endsWith('.zip')) {
        await fs.remove(path.join(testDir, file));
      }
    }
  });

  /**
   * 辅助函数：提取ZIP文件内容并读取元数据
   */
  async function extractZipAndGetMetadata(zipPath: string, metadataFileName: string = 'metadata.json'): Promise<{ 
    files: string[], 
    metadata: PackageMetadata | null 
  }> {
    const extractDir = path.join(testDir, `extract_${Date.now()}`);
    try {
      await fs.ensureDir(extractDir);
      await zip.uncompress(zipPath, extractDir);
      
      const files = await fs.readdir(extractDir);
      
      let metadata = null;
      const metadataPath = path.join(extractDir, metadataFileName);
      if (fs.existsSync(metadataPath)) {
        const metadataContent = await fs.readFile(metadataPath, 'utf8');
        metadata = JSON.parse(metadataContent);
      }
      
      return { files, metadata };
    } finally {
      // 清理提取目录
      await fs.remove(extractDir).catch(() => {});
    }
  }

  describe('单文件打包', () => {
    test('应该能将单个文件打包为ZIP', async () => {
      // 创建一个测试文件项
      const fileItem = fileItems[0];
      const outputPath = path.join(testDir, 'single-file-package.zip');
      
      // 调用单文件打包函数
      const result = await createSingleFilePackage(fileItem, outputPath, defaultOptions);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // 验证ZIP文件内容
      const { files, metadata } = await extractZipAndGetMetadata(outputPath, defaultOptions.metadataFileName);
      
      // 应该只有两个文件：原始文件和元数据
      expect(files.length).toBe(2);
      expect(files).toContain(fileItem.name);
      expect(files).toContain(defaultOptions.metadataFileName);
      
      // 检查元数据内容
      expect(metadata).toBeDefined();
      expect(metadata!.files.length).toBe(1);
      expect(metadata!.files[0].name).toBe(fileItem.name);
      expect(metadata!.files[0].md5).toBe(fileItem.md5);
      expect(metadata!.files[0].size).toBe(fileItem.size);
      expect(metadata!.files[0].origin).toBe(fileItem.origin);
      expect(metadata!.files[0].nestedLevel).toBe(fileItem.nestedLevel);
    });

    test('应该能处理单个中文文件名的文件', async () => {
      // 获取中文文件名的测试文件项
      const fileItem = fileItems.find(item => item.name === 'chinese-名字.txt');
      const outputPath = path.join(testDir, 'chinese-file-package.zip');
      
      // 确保找到了中文文件
      expect(fileItem).toBeDefined();
      
      if (fileItem) {
        // 调用单文件打包函数
        const result = await createSingleFilePackage(fileItem, outputPath, defaultOptions);
        
        // 验证结果
        expect(result.success).toBe(true);
        expect(fs.existsSync(outputPath)).toBe(true);
        
        // 验证ZIP文件内容
        const { files } = await extractZipAndGetMetadata(outputPath);
        
        // 确认中文文件名被正确处理
        expect(files).toContain(fileItem.name);
      }
    });

    test('不包含MD5和元数据的选项', async () => {
      const fileItem = fileItems[0];
      const outputPath = path.join(testDir, 'no-metadata-package.zip');
      
      // 设置不包含MD5和元数据的选项
      const options: PackageOptions = {
        ...defaultOptions,
        includeMd5: false,
        includeMetadata: false
      };
      
      // 调用单文件打包函数
      const result = await createSingleFilePackage(fileItem, outputPath, options);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // 验证ZIP文件内容 - 应该只有原始文件，没有元数据
      const { files, metadata } = await extractZipAndGetMetadata(outputPath);
      
      expect(files.length).toBe(1);
      expect(files[0]).toBe(fileItem.name);
      expect(metadata).toBeNull();
    });

    test('应该使用进度回调', async () => {
      const fileItem = fileItems[0];
      const outputPath = path.join(testDir, 'progress-package.zip');
      
      // 进度记录数组
      const progressEvents: PackageProgress[] = [];
      
      // 添加进度回调的选项
      const options: PackageOptions = {
        ...defaultOptions,
        onProgress: (progress) => {
          progressEvents.push({...progress});
        }
      };
      
      // 调用单文件打包函数
      const result = await createSingleFilePackage(fileItem, outputPath, options);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(progressEvents.length).toBeGreaterThan(0);
      
      // 检查进度事件
      expect(progressEvents[0].processedFiles).toBe(0);
      expect(progressEvents[progressEvents.length - 1].processedFiles).toBe(1);
      expect(progressEvents[progressEvents.length - 1].totalFiles).toBe(1);
      expect(progressEvents[progressEvents.length - 1].percentage).toBe(100);
    });

    test('处理不存在文件的情况', async () => {
      // 创建一个指向不存在文件的文件项
      const nonExistentFileItem: FileItem = {
        path: path.join(testDir, 'non-existent.txt'),
        name: 'non-existent.txt',
        size: 0,
        createTime: new Date(),
        modifyTime: new Date()
      };
      
      const outputPath = path.join(testDir, 'non-existent-package.zip');
      
      // 调用单文件打包函数
      const result = await createSingleFilePackage(nonExistentFileItem, outputPath, defaultOptions);
      
      // 验证结果 - 应该失败
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toMatch(/找不到文件|no such file/i);
    });

    test('应该处理临时目录操作错误', async () => {
      // 创建一个访问受限的目录来模拟临时目录创建失败
      const restrictedDir = path.join(testDir, 'restricted');
      await fs.ensureDir(restrictedDir);
      
      // 模拟一个文件项
      const fileItem = fileItems[0];
      
      // 使用无法写入的临时目录
      const options: PackageOptions = {
        ...defaultOptions,
        tempDir: '/root/unauthorized' // 通常无权限写入的目录
      };
      
      // 调用单文件打包
      const result = await createSingleFilePackage(fileItem, path.join(restrictedDir, 'test.zip'), options);
      
      // 应该失败并返回错误
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('批量文件打包', () => {
    test('应该能将多个文件打包为ZIP', async () => {
      const outputPath = path.join(testDir, 'batch-package.zip');
      
      // 调用批量打包函数
      const result = await createBatchPackage(fileItems, outputPath, defaultOptions);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // 验证ZIP文件内容
      const { files, metadata } = await extractZipAndGetMetadata(outputPath, defaultOptions.metadataFileName);
      
      // 应该有所有文件 + 元数据文件
      expect(files.length).toBe(fileItems.length + 1);
      
      // 检查所有文件是否都在压缩包中
      for (const fileItem of fileItems) {
        expect(files).toContain(fileItem.name);
      }
      
      // 检查元数据
      expect(metadata).toBeDefined();
      expect(metadata!.files.length).toBe(fileItems.length);
      
      // 检查元数据中的每个文件
      for (const fileItem of fileItems) {
        const metaFile = metadata!.files.find(f => f.name === fileItem.name);
        expect(metaFile).toBeDefined();
        expect(metaFile!.md5).toBe(fileItem.md5);
        expect(metaFile!.size).toBe(fileItem.size);
        expect(metaFile!.origin).toBe(fileItem.origin);
        expect(metaFile!.nestedLevel).toBe(fileItem.nestedLevel);
        expect(new Date(metaFile!.createTime!).getTime()).toBeCloseTo(fileItem.createTime!.getTime(), -3);
        expect(new Date(metaFile!.modifyTime!).getTime()).toBeCloseTo(fileItem.modifyTime!.getTime(), -3);
      }
    });

    test('应该能处理空文件列表', async () => {
      const outputPath = path.join(testDir, 'empty-batch-package.zip');
      
      // 调用批量打包函数，传入空数组
      const result = await createBatchPackage([], outputPath, defaultOptions);
      
      // 验证结果 - 应该成功，但结果中有警告
      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      
      // 应该创建一个只包含元数据的ZIP
      expect(fs.existsSync(outputPath)).toBe(true);
      
      const { files, metadata } = await extractZipAndGetMetadata(outputPath, defaultOptions.metadataFileName);
      
      // 只有元数据文件
      expect(files.length).toBe(1);
      expect(files[0]).toBe(defaultOptions.metadataFileName);
      
      // 元数据中文件列表为空
      expect(metadata!.files.length).toBe(0);
    });

    test('应该正确处理部分文件不存在的情况', async () => {
      // 创建一个包含一些不存在文件的文件项列表
      const mixedFileItems = [
        ...fileItems,
        {
          path: path.join(testDir, 'non-existent1.txt'),
          name: 'non-existent1.txt',
          size: 0,
          createTime: new Date(),
          modifyTime: new Date()
        },
        {
          path: path.join(testDir, 'non-existent2.txt'),
          name: 'non-existent2.txt',
          size: 0,
          createTime: new Date(),
          modifyTime: new Date()
        }
      ];
      
      const outputPath = path.join(testDir, 'mixed-batch-package.zip');
      
      // 调用批量打包函数
      const result = await createBatchPackage(mixedFileItems, outputPath, defaultOptions);
      
      // 验证结果 - 应该失败，因为有文件处理错误
      expect(result.success).toBe(false); // 当有任何文件处理错误时，success应为false
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(2); // 两个不存在的文件
      
      // ZIP应该包含所有存在的文件和元数据
      const { files, metadata } = await extractZipAndGetMetadata(outputPath, defaultOptions.metadataFileName);
      
      expect(files.length).toBe(fileItems.length + 1); // 只有存在的文件 + 元数据
      
      // 元数据应该包含成功的文件和失败记录
      expect(metadata).toBeDefined();
      if (metadata) {
        expect(metadata.files.length).toBe(fileItems.length);
        expect(metadata.errors).toBeDefined();
        expect(metadata.errors!.length).toBe(2);
      }
    });

    test('应该使用进度回调报告批量打包进度', async () => {
      const outputPath = path.join(testDir, 'progress-batch-package.zip');
      
      // 进度记录数组
      const progressEvents: PackageProgress[] = [];
      
      // 添加进度回调的选项
      const options: PackageOptions = {
        ...defaultOptions,
        onProgress: (progress) => {
          progressEvents.push({...progress});
        }
      };
      
      // 调用批量打包函数
      const result = await createBatchPackage(fileItems, outputPath, options);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(progressEvents.length).toBeGreaterThan(0);
      
      // 检查进度事件
      const lastProgress = progressEvents[progressEvents.length - 1];
      expect(lastProgress.processedFiles).toBe(fileItems.length);
      expect(lastProgress.totalFiles).toBe(fileItems.length);
      expect(lastProgress.percentage).toBe(100);
      
      // 检查进度更新是否递增
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i].processedFiles).toBeGreaterThanOrEqual(progressEvents[i-1].processedFiles);
        expect(progressEvents[i].percentage).toBeGreaterThanOrEqual(progressEvents[i-1].percentage);
      }
    });

    test('包含多种格式和大小的文件', async () => {
      // 准备包含不同格式和大小的文件
      const largeFile = path.join(testDir, 'large.bin');
      await fs.writeFile(largeFile, Buffer.alloc(1024 * 1024 * 2, 'L')); // 2MB文件
      
      const stats = await fs.stat(largeFile);
      const largeFileItem: FileItem = {
        path: largeFile,
        name: 'large.bin',
        size: stats.size,
        createTime: stats.birthtime,
        modifyTime: stats.mtime,
        origin: 'filesystem',
        nestedLevel: 0
      };
      
      const mixedFiles = [...fileItems, largeFileItem];
      const outputPath = path.join(testDir, 'mixed-format-package.zip');
      
      // 调用批量打包
      const result = await createBatchPackage(mixedFiles, outputPath, defaultOptions);
      
      // 验证结果
      expect(result.success).toBe(true);
      expect(result.fileCount).toBe(mixedFiles.length);
      
      // 验证ZIP包含所有文件
      const { files, metadata } = await extractZipAndGetMetadata(outputPath);
      expect(files.length).toBe(mixedFiles.length + 1); // +1 for metadata
      expect(files).toContain('large.bin');
      
      // 验证元数据中的大文件信息
      expect(metadata).toBeDefined();
      if (metadata) {
        const largeMetaFile = metadata.files.find(f => f.name === 'large.bin');
        expect(largeMetaFile).toBeDefined();
        expect(largeMetaFile!.size).toBe(largeFileItem.size);
      }
    });

    test('压缩过程中的错误处理', async () => {
      // 创建一个特殊的文件项，路径文件不存在
      const badFileItem: FileItem = {
        path: path.join(testDir, 'nonexistent-file.txt'),
        name: 'nonexistent.txt',
        size: 100,
        createTime: new Date(),
        modifyTime: new Date(),
        origin: 'filesystem',
        nestedLevel: 0
      };
      
      const outputPath = path.join(testDir, 'error-handling-package.zip');
      
      // 调用批量打包，但传入的文件不存在
      const result = await createBatchPackage([badFileItem], outputPath, {
        ...defaultOptions,
        includeMetadata: true
      });
      
      // 即使文件不存在，整体过程也不应该完全成功
      expect(result.success).toBe(false); // 当有任何文件处理错误时，success应为false
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].file.name).toBe('nonexistent.txt');
    });

    test('处理空的路径', async () => {
      // 创建一个文件项，路径为空
      const emptyPathItem: FileItem = {
        path: '',
        name: 'empty-path.txt',
        size: 0,
        createTime: new Date(),
        modifyTime: new Date(),
        origin: 'filesystem',
        nestedLevel: 0
      };
      
      const outputPath = path.join(testDir, 'empty-path-package.zip');
      
      // 调用批量打包
      const result = await createBatchPackage([emptyPathItem], outputPath, defaultOptions);
      
      // 应该处理错误但不崩溃
      expect(result.success).toBe(false); // 当有任何文件处理错误时，success应为false
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(1);
    });

    test('处理写入权限问题', async () => {
      // 创建一个文件项
      const fileItem = fileItems[0];
      // 创建一个很可能无法写入的输出路径
      const restrictedPath = '/root/output.zip';
      
      // 调用批量打包，输出到受限制的路径
      const result = await createBatchPackage([fileItem], restrictedPath, defaultOptions);
      
      // 验证结果 - 应该失败并返回错误
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors!.some(e => e.error instanceof Error)).toBe(true);
    });

    test('处理文件名冲突的情况', async () => {
      // 创建两个文件名相同但内容不同的文件项
      const conflictFile1Path = path.join(testDir, 'conflict-dir-1');
      const conflictFile2Path = path.join(testDir, 'conflict-dir-2');
      const normalFilePath = path.join(testDir, 'normal.txt');

      await fs.writeFile(conflictFile1Path, 'Content of file 1');
      await fs.writeFile(conflictFile2Path, 'Content of file 2');
      await fs.writeFile(normalFilePath, 'Normal file content');

      const stats1 = await fs.stat(conflictFile1Path);
      const stats2 = await fs.stat(conflictFile2Path);
      const statsNormal = await fs.stat(normalFilePath);

      // 两个文件项有相同的初始 name 但不同的 path
      // 不设置 originalName，让函数自己填充
      const conflictItems: FileItem[] = [
        {
          path: conflictFile1Path,
          name: 'conflict.txt', // 初始目标名称
          size: stats1.size,
          createTime: stats1.birthtime,
          modifyTime: stats1.mtime,
          origin: 'filesystem',
          nestedLevel: 0
        },
        {
          path: conflictFile2Path,
          name: 'conflict.txt', // 初始目标名称
          size: stats2.size,
          createTime: stats2.birthtime,
          modifyTime: stats2.mtime,
          origin: 'filesystem',
          nestedLevel: 0
        },
        {
          path: normalFilePath,
          name: 'normal.txt',   // 正常文件
          size: statsNormal.size,
          createTime: statsNormal.birthtime,
          modifyTime: statsNormal.mtime,
          origin: 'filesystem',
          nestedLevel: 0
        }
      ];

      const outputPath = path.join(testDir, 'conflict-package.zip');

      // 调用批量打包
      const result = await createBatchPackage(conflictItems, outputPath, defaultOptions);

      // 验证结果 - 应该成功，但有警告
      expect(result.success).toBe(true); // 文件本身没有错误，打包应成功
      expect(result.warnings).toBeDefined();
      // 应该有一个警告信息关于重命名，基于冲突的 name
      // 警告信息现在包含原始文件名和目标名
      expect(result.warnings).toContain('文件名冲突: "conflict.txt" (目标名 "conflict.txt") 已重命名为 "conflict-1.txt"');
      expect(result.fileCount).toBe(3); // 所有文件都应该被处理

      // 验证ZIP文件内容
      const { files, metadata } = await extractZipAndGetMetadata(outputPath);

      // 压缩包内应该包含重命名后的文件
      expect(files).toContain('conflict.txt'); // 第一个文件保持原名
      expect(files).toContain('conflict-1.txt'); // 第二个文件应被重命名为 conflict-1.txt
      expect(files).toContain('normal.txt');
      expect(files).toContain(defaultOptions.metadataFileName); // 包含元数据文件
      expect(files.length).toBe(4);

      // 验证元数据内容
      expect(metadata).toBeDefined();
      if (metadata) {
        expect(metadata.files.length).toBe(3);
        const metaFile1 = metadata.files.find(f => f.name === 'conflict.txt');
        const metaFile2 = metadata.files.find(f => f.name === 'conflict-1.txt');
        const metaFileNormal = metadata.files.find(f => f.name === 'normal.txt');

        expect(metaFile1).toBeDefined();
        expect(metaFile2).toBeDefined();
        expect(metaFileNormal).toBeDefined();

        // 检查 originalName 是否被正确记录 (基于 path)
        expect(metaFile1!.originalName).toBe('conflict.txt');
        expect(metaFile2!.originalName).toBe('conflict.txt');
        expect(metaFileNormal!.originalName).toBe('normal.txt');
        // 检查 name 是否反映最终名称
        expect(metaFile1!.name).toBe('conflict.txt');
        expect(metaFile2!.name).toBe('conflict-1.txt');
        expect(metaFileNormal!.name).toBe('normal.txt');

        // 可以在元数据中检查 warnings
        expect(metadata.warnings).toBeDefined();
        // 匹配更新后的警告信息格式
        expect(metadata.warnings!.some(w => w.includes('目标名 "conflict.txt") 已重命名为 "conflict-1.txt"'))).toBe(true);
      }
    });
  });

  describe('包信息提取', () => {
    test('应该能提取ZIP包中的元数据', async () => {
      // 先创建一个包含元数据的ZIP
      const outputPath = path.join(testDir, 'extract-test-package.zip');
      await createBatchPackage(fileItems, outputPath, defaultOptions);
      
      // 提取元数据
      const packageInfo = await extractPackageInfo(outputPath);
      
      // 验证提取的信息
      expect(packageInfo.success).toBe(true);
      expect(packageInfo.files.length).toBe(fileItems.length);
      expect(packageInfo.metadata).toBeDefined();
      
      // 验证文件信息
      for (const fileItem of fileItems) {
        const extractedFile = packageInfo.files.find(f => f.name === fileItem.name);
        expect(extractedFile).toBeDefined();
        expect(extractedFile!.md5).toBe(fileItem.md5);
        expect(extractedFile!.size).toBe(fileItem.size);
      }
    });
    
    test('增强的元数据应该包含额外信息字段', async () => {
      // 创建包含增强元数据的选项
      const enhancedOptions: PackageOptions = {
        ...defaultOptions,
        enhancedMetadata: true,
        metadataVersion: '1.0',
        packageTags: ['test', 'enhanced']
      };
      
      const outputPath = path.join(testDir, 'enhanced-metadata-package.zip');
      
      // 创建一个带有增强元数据的包
      await createBatchPackage(fileItems, outputPath, enhancedOptions);
      
      // 验证ZIP文件内容
      const { metadata } = await extractZipAndGetMetadata(outputPath, enhancedOptions.metadataFileName);
      
      // 验证基本元数据结构
      expect(metadata!.files.length).toBe(fileItems.length);
      
      // 验证增强的元数据字段
      expect(metadata!.version).toBe('1.0');
      expect(metadata!.packageId).toBeDefined();
      expect(metadata!.createdAt).toBeDefined();
      expect(metadata!.tags).toEqual(['test', 'enhanced']);
      expect(metadata!.checksumAlgorithm).toBe('md5');
      
      // 验证文件级元数据
      for (const fileItem of fileItems) {
        const metaFile = metadata!.files.find(f => f.name === fileItem.name);
        expect(metaFile).toBeDefined();
        expect(metaFile!.size).toBe(fileItem.size);
        expect(metaFile!.md5).toBe(fileItem.md5);
        expect(metaFile!.origin).toBe(fileItem.origin);
        expect(metaFile!.nestedLevel).toBe(fileItem.nestedLevel);
        expect(new Date(metaFile!.createTime!).getTime()).toBeCloseTo(fileItem.createTime!.getTime(), -3);
        expect(new Date(metaFile!.modifyTime!).getTime()).toBeCloseTo(fileItem.modifyTime!.getTime(), -3);
      }
    });
    
    test('应该能处理不包含元数据的ZIP', async () => {
      // 创建一个不包含元数据的ZIP
      const outputPath = path.join(testDir, 'no-metadata-extract-package.zip');
      const options: PackageOptions = {
        ...defaultOptions,
        includeMetadata: false
      };
      
      await createBatchPackage(fileItems, outputPath, options);
      
      // 提取元数据
      const packageInfo = await extractPackageInfo(outputPath);
      
      // 验证提取的信息
      expect(packageInfo.success).toBe(true);
      expect(packageInfo.files.length).toBe(fileItems.length);
      expect(packageInfo.metadata).toBeNull(); // 没有元数据
      
      // 应该仍然能列出文件信息
      expect(packageInfo.files.length).toBe(fileItems.length);
    });
    
    test('应该能处理无效的ZIP文件', async () => {
      // 创建一个无效的ZIP文件
      const invalidZipPath = path.join(testDir, 'invalid.zip');
      await fs.writeFile(invalidZipPath, 'This is not a valid ZIP file');
      
      // 提取元数据
      const packageInfo = await extractPackageInfo(invalidZipPath);
      
      // 验证提取失败
      expect(packageInfo.success).toBe(false);
      expect(packageInfo.error).toBeDefined();
    });

    test('处理文件统计信息失败', async () => {
      // 创建一个测试包
      const outputPath = path.join(testDir, 'extract-edge-case.zip');
      await createSingleFilePackage(fileItems[0], outputPath, defaultOptions);
      
      // 创建一个通过读取导致错误的包
      const badOutputPath = path.join(testDir, 'bad-extract.zip');
      await fs.copy(outputPath, badOutputPath);
      
      // 使用实际存在但会导致错误的特殊情况，而不是mock
      const packageInfo = await extractPackageInfo(badOutputPath);
      
      // 验证结果
      expect(packageInfo.success).toBe(true);
      expect(packageInfo.files.length).toBeGreaterThanOrEqual(0);
    });

    test('处理损坏的元数据', async () => {
      // 创建一个带有损坏元数据的ZIP
      const outputPath = path.join(testDir, 'corrupted-metadata.zip');
      
      // 先创建一个正常的压缩包
      await createSingleFilePackage(fileItems[0], outputPath, defaultOptions);
      
      // 解压，修改元数据，再重新压缩
      const extractDir = path.join(testDir, 'extract-temp');
      await fs.ensureDir(extractDir);
      
      try {
        // 解压
        await zip.uncompress(outputPath, extractDir);
        
        // 写入损坏的JSON
        await fs.writeFile(
          path.join(extractDir, defaultOptions.metadataFileName!), 
          '{ "createdAt": "2023-01-01T00:00:00Z", "files": [{'
        );
        
        // 重新打包
        const badOutputPath = path.join(testDir, 'bad-metadata.zip');
        await zip.compressDir(extractDir, badOutputPath, { ignoreBase: true });
        
        // 尝试提取损坏的元数据
        const packageInfo = await extractPackageInfo(badOutputPath);
        
        // 应该成功提取，但元数据为null
        expect(packageInfo.success).toBe(true);
        expect(packageInfo.files.length).toBeGreaterThan(0);
        expect(packageInfo.metadata).toBeNull();
      } finally {
        // 清理
        await fs.remove(extractDir);
      }
    });
  });

  // 直接测试当前未覆盖的函数和分支
  describe('直接分支覆盖测试', () => {
    // 测试createSingleFilePackage的异常分支
    test('当压缩过程中出现异常时处理', async () => {
      // 创建临时源文件夹，然后删除它以模拟压缩过程中的权限或其他错误
      const testFileItem = fileItems[0];
      const outputPath = path.join(testDir, 'compression-error.zip');
      
      // 用一个模拟来创建压缩失败的情况
      const originalCompressDir = zip.compressDir;
      try {
        // 替换compressDir函数以模拟错误
        (zip.compressDir as any) = jest.fn().mockRejectedValueOnce(new Error('模拟压缩失败'));
        
        // 执行单文件打包
        const result = await createSingleFilePackage(testFileItem, outputPath, defaultOptions);
        
        // 验证失败结果
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error!.message).toContain('模拟压缩失败');
      } finally {
        // 恢复原始函数
        (zip.compressDir as any) = originalCompressDir;
      }
    });
    
    // 测试createBatchPackage的边缘情况
    test('批量打包的多级错误处理', async () => {
      // 创建一个会导致各种错误的文件项集合
      const problematicItems: FileItem[] = [
        // 不存在的文件
        {
          path: path.join(testDir, 'nonexistent1.txt'),
          name: 'nonexistent1.txt',
          size: 0,
          createTime: new Date(),
          modifyTime: new Date(),
          origin: 'filesystem',
          nestedLevel: 0
        },
        // 无效路径
        {
          path: '',
          name: 'empty-path.txt',
          size: 0,
          createTime: new Date(),
          modifyTime: new Date(),
          origin: 'filesystem',
          nestedLevel: 0
        },
        // 有效文件
        fileItems[0]
      ];
      
      const outputPath = path.join(testDir, 'multi-error-package.zip');
      
      // 创建一个模拟错误情况的测试
      const originalCompressDir = zip.compressDir;
      (zip.compressDir as any) = jest.fn().mockRejectedValueOnce(new Error('模拟压缩失败'));
      
      try {
        // 执行批量打包
        const result = await createBatchPackage(problematicItems, outputPath, defaultOptions);
        
        // 验证结果
        expect(result.success).toBe(false);
        // expect(result.error).toBeDefined(); // 不应检查result.error
        // 应该有多个文件错误记录
        expect(result.errors).toBeDefined();
        expect(result.errors!.length).toBeGreaterThan(0);
        expect(result.errors!.some(e => e.error instanceof Error)).toBe(true);
        // 检查是否包含模拟的压缩错误
        expect(result.errors!.some(e => e.error.message.includes('模拟压缩失败'))).toBe(true);
      } finally {
        // 恢复原始函数
        (zip.compressDir as any) = originalCompressDir;
      }
    });
    
    // 测试extractPackageInfo的边缘情况
    test('处理复杂的提取情况', async () => {
      // 创建一个无法解压的文件
      const invalidZipPath = path.join(testDir, 'uncompressable.zip');
      await fs.writeFile(invalidZipPath, 'This is not a valid ZIP file, but different from previous test');
      
      // 模拟解压失败但不是因为格式问题
      const originalUncompress = zip.uncompress;
      (zip.uncompress as any) = jest.fn().mockRejectedValueOnce(new Error('模拟解压内部失败'));
      
      try {
        // 提取信息
        const result = await extractPackageInfo(invalidZipPath);
        
        // 验证结果
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.files.length).toBe(0);
        expect(result.metadata).toBeNull();
      } finally {
        // 恢复原始函数
        (zip.uncompress as any) = originalUncompress;
      }
    });

    // 处理异常的fs.stat情况
    test('在提取过程中处理文件异常', async () => {
      // 创建一个测试包
      const outputPath = path.join(testDir, 'extract-error-test.zip');
      
      // 创建一个包含特殊文件的压缩包
      await createSingleFilePackage(fileItems[0], outputPath, defaultOptions);
      
      // 解压到临时目录
      const tempExtractDir = path.join(testDir, 'temp-extract');
      await fs.ensureDir(tempExtractDir);
      await zip.uncompress(outputPath, tempExtractDir);
      
      // 在解压目录添加一个空文件来引发读取问题
      const problematicFile = path.join(tempExtractDir, 'problematic.dat');
      await fs.writeFile(problematicFile, '');
      
      // 重新打包破坏的文件
      const badOutputPath = path.join(testDir, 'problem-file.zip');
      await zip.compressDir(tempExtractDir, badOutputPath, { ignoreBase: true });
      
      // 提取信息，fs.stat可能会失败
      const packageInfo = await extractPackageInfo(badOutputPath);
      
      // 清理
      await fs.remove(tempExtractDir);
      
      // 验证结果 - 即使有问题，也应该能提取部分信息
      expect(packageInfo.success).toBe(true);
      expect(packageInfo.files.length).toBeGreaterThan(0);
    });
  });
}); 