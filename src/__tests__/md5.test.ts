/**
 * @file MD5计算测试
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as crypto from 'crypto';
import { 
  calculateMd5, 
  calculateFileMd5,
  calculateBatchMd5,
  calculateOptimizedMd5,
  Md5Options
} from '../core/md5';
import { FileItem } from '../types';

// 在引入fs模块前模拟它
jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    createReadStream: jest.fn().mockImplementation((filePath, options) => {
      // 使用真实的 createReadStream 创建流，避免流为undefined的问题
      const stream = original.createReadStream(filePath, options);
      // 返回原始流
      return stream;
    })
  };
});

// 导入fs模块
// import * as fsNode from 'fs'; // 引入原生fs模块

const TEST_DIR = path.join(os.tmpdir(), 'scan-md5-test');

describe('MD5计算', () => {
  beforeAll(async () => {
    // 创建测试目录
    await fs.ensureDir(TEST_DIR);
  });

  afterAll(async () => {
    // 清理测试目录
    await fs.remove(TEST_DIR);
  });

  beforeEach(async () => {
    // 清空测试目录内容
    const files = await fs.readdir(TEST_DIR);
    await Promise.all(files.map(file => fs.remove(path.join(TEST_DIR, file))));
    // 重置所有模拟
    jest.restoreAllMocks();
  });

  describe('基础MD5计算', () => {
    test('计算文件MD5', async () => {
      const testContent = 'test content for md5';
      const testFile = path.join(TEST_DIR, 'test-md5.txt');
      await fs.writeFile(testFile, testContent);
      
      // 计算预期的MD5
      const expectedMd5 = crypto.createHash('md5').update(testContent).digest('hex');
      
      // 使用模块计算MD5
      const md5 = await calculateMd5(testFile);
      
      expect(md5).toBe(expectedMd5);
    });

    test('计算文件项MD5', async () => {
      const testContent = 'test content for file item';
      const testFile = path.join(TEST_DIR, 'test-file-md5.txt');
      await fs.writeFile(testFile, testContent);
      
      const stats = await fs.stat(testFile);
      
      // 创建文件项
      const fileItem: FileItem = {
        path: testFile,
        name: path.basename(testFile),
        size: stats.size,
        createTime: stats.birthtime,
        modifyTime: stats.mtime
      };
      
      // 计算预期的MD5
      const expectedMd5 = crypto.createHash('md5').update(testContent).digest('hex');
      
      // 使用模块计算文件项的MD5
      const updatedFileItem = await calculateFileMd5(fileItem);
      
      expect(updatedFileItem.md5).toBe(expectedMd5);
    });

    test('处理不存在的文件', async () => {
      const nonExistentFile = path.join(TEST_DIR, 'non-existent.txt');
      
      // 创建文件项
      const fileItem: FileItem = {
        path: nonExistentFile,
        name: path.basename(nonExistentFile),
        size: 0,
        createTime: new Date(),
        modifyTime: new Date()
      };
      
      // 使用模块计算文件项的MD5（应该返回原始文件项，没有md5值）
      const updatedFileItem = await calculateFileMd5(fileItem);
      
      // 原始文件项应保持不变
      expect(updatedFileItem).toEqual(fileItem);
      expect(updatedFileItem.md5).toBeUndefined();
    });

    test('计算不存在文件的MD5应抛出错误', async () => {
      const nonExistentFile = path.join(TEST_DIR, 'non-existent.txt');
      
      // 使用模块计算MD5应该抛出错误
      await expect(calculateMd5(nonExistentFile)).rejects.toThrow(/计算MD5失败/);
    });

    test('标准MD5计算处理流错误', async () => {
      jest.setTimeout(5000); // 增加超时时间，以便异步测试有足够时间
      
      // 创建一个测试文件
      const testFile = path.join(TEST_DIR, 'stream-error-test.txt');
      await fs.writeFile(testFile, 'test content');
      
      // 模拟fs.createReadStream，使其返回一个会触发error事件的流
      const originalCreateReadStream = require('fs').createReadStream;
      
      // 创建一个可以触发error事件的mock
      const mockCreateReadStream = jest.fn().mockImplementation(() => {
        const mockStream = {
          on: function(event: string, callback: Function) {
            if (event === 'error') {
              setTimeout(() => {
                callback(new Error('模拟的流读取错误'));
              }, 10);
            }
            return this;
          }
        };
        return mockStream;
      });
      
      try {
        // 替换原始函数
        require('fs').createReadStream = mockCreateReadStream;
        
        // 执行测试
        await expect(calculateMd5(testFile)).rejects.toThrow('模拟的流读取错误');
      } finally {
        // 恢复原始函数
        require('fs').createReadStream = originalCreateReadStream;
      }
    });
  });

  describe('高级功能测试', () => {
    test('流式处理大文件MD5', async () => {
      // 创建一个中等大小的测试文件（为测试目的，我们降低大文件阈值）
      const largeFileThreshold = 1024; // 1KB，便于测试
      const testFile = path.join(TEST_DIR, 'large-test-file.txt');
      
      // 创建一个比阈值大的文件
      const buffer = Buffer.alloc(largeFileThreshold + 100, 'x');
      await fs.writeFile(testFile, buffer);
      
      // 计算预期的MD5
      const expectedMd5 = crypto.createHash('md5').update(buffer).digest('hex');
      
      // 使用流式处理计算MD5
      const options: Md5Options = {
        useStreamProcessing: true,
        largeFileThreshold
      };
      
      const md5 = await calculateMd5(testFile, options);
      
      expect(md5).toBe(expectedMd5);
    });
    
    test('带进度回调的MD5计算', async () => {
      const testFile = path.join(TEST_DIR, 'progress-test-file.txt');
      
      // 创建测试文件
      const buffer = Buffer.alloc(1024 * 10, 'x'); // 10KB
      await fs.writeFile(testFile, buffer);
      
      // 计算预期的MD5
      const expectedMd5 = crypto.createHash('md5').update(buffer).digest('hex');
      
      // 进度记录
      const progressEvents: number[] = [];
      
      // 使用进度回调
      const options: Md5Options = {
        useStreamProcessing: true,
        largeFileThreshold: 1024, // 1KB，确保使用流处理
        onProgress: (progress) => {
          progressEvents.push(progress);
        }
      };
      
      const md5 = await calculateMd5(testFile, options);
      
      expect(md5).toBe(expectedMd5);
      
      // 进度回调应该被调用多次
      expect(progressEvents.length).toBeGreaterThan(0);
      
      // 最后一个进度回调应为100%
      expect(progressEvents[progressEvents.length - 1]).toBe(100);
    });
    
    test('批量计算多个文件的MD5', async () => {
      // 创建多个测试文件
      const testContent1 = 'test content 1';
      const testContent2 = 'test content 2';
      const testContent3 = 'test content 3';
      
      const testFile1 = path.join(TEST_DIR, 'batch-test-1.txt');
      const testFile2 = path.join(TEST_DIR, 'batch-test-2.txt');
      const testFile3 = path.join(TEST_DIR, 'batch-test-3.txt');
      
      await fs.writeFile(testFile1, testContent1);
      await fs.writeFile(testFile2, testContent2);
      await fs.writeFile(testFile3, testContent3);
      
      // 计算预期的MD5值
      const expectedMd5_1 = crypto.createHash('md5').update(testContent1).digest('hex');
      const expectedMd5_2 = crypto.createHash('md5').update(testContent2).digest('hex');
      const expectedMd5_3 = crypto.createHash('md5').update(testContent3).digest('hex');
      
      // 创建文件项数组
      const stats1 = await fs.stat(testFile1);
      const stats2 = await fs.stat(testFile2);
      const stats3 = await fs.stat(testFile3);
      
      const fileItems: FileItem[] = [
        {
          path: testFile1,
          name: path.basename(testFile1),
          size: stats1.size,
          createTime: stats1.birthtime,
          modifyTime: stats1.mtime
        },
        {
          path: testFile2,
          name: path.basename(testFile2),
          size: stats2.size,
          createTime: stats2.birthtime,
          modifyTime: stats2.mtime
        },
        {
          path: testFile3,
          name: path.basename(testFile3),
          size: stats3.size,
          createTime: stats3.birthtime,
          modifyTime: stats3.mtime
        }
      ];
      
      // 批量计算MD5
      const updatedItems = await calculateBatchMd5(fileItems, {}, 2); // 并发数为2
      
      // 验证结果
      expect(updatedItems[0].md5).toBe(expectedMd5_1);
      expect(updatedItems[1].md5).toBe(expectedMd5_2);
      expect(updatedItems[2].md5).toBe(expectedMd5_3);
    });
    
    test('优化的MD5计算策略', async () => {
      // 创建一个小文件
      const smallContent = 'small file content';
      const smallFile = path.join(TEST_DIR, 'small-optimized.txt');
      await fs.writeFile(smallFile, smallContent);
      
      // 创建一个中等文件（为测试目的，我们仅创建一个略大的文件）
      const mediumFile = path.join(TEST_DIR, 'medium-optimized.txt');
      const mediumBuffer = Buffer.alloc(1024 * 20, 'y'); // 20KB
      await fs.writeFile(mediumFile, mediumBuffer);
      
      // 计算预期的MD5值
      const expectedSmallMd5 = crypto.createHash('md5').update(smallContent).digest('hex');
      const expectedMediumMd5 = crypto.createHash('md5').update(mediumBuffer).digest('hex');
      
      // 使用优化的MD5计算策略
      const smallMd5 = await calculateOptimizedMd5(smallFile);
      const mediumMd5 = await calculateOptimizedMd5(mediumFile);
      
      expect(smallMd5).toBe(expectedSmallMd5);
      expect(mediumMd5).toBe(expectedMediumMd5);
    });

    test('优化的MD5计算 - 不存在的文件应抛出错误', async () => {
      const nonExistentFile = path.join(TEST_DIR, 'non-existent-optimized.txt');
      
      // 使用优化MD5计算不存在的文件应该抛出错误
      await expect(calculateOptimizedMd5(nonExistentFile)).rejects.toThrow(/计算优化MD5失败/);
    });
    
    test('批量计算MD5 - 自动计算并发数', async () => {
      // 创建测试文件
      const testFile = path.join(TEST_DIR, 'batch-auto-concurrency.txt');
      await fs.writeFile(testFile, 'test content');
      
      const stats = await fs.stat(testFile);
      const fileItem: FileItem = {
        path: testFile,
        name: path.basename(testFile),
        size: stats.size,
        createTime: stats.birthtime,
        modifyTime: stats.mtime
      };
      
      // 不指定并发数，让函数自动计算
      const updatedItems = await calculateBatchMd5([fileItem]);
      
      // 验证计算结果
      expect(updatedItems[0].md5).toBeDefined();
    });

    test('批量计算MD5 - 空数组应返回空数组', async () => {
      const result = await calculateBatchMd5([]);
      expect(result).toEqual([]);
    });

    test('流式处理MD5的错误处理', async () => {
      jest.setTimeout(5000); // 增加超时时间，以便异步测试有足够时间
      
      // 创建一个测试文件
      const testFile = path.join(TEST_DIR, 'stream-error-stream-test.txt');
      await fs.writeFile(testFile, 'test content');
      
      // 保存原始的createReadStream实现
      const originalCreateReadStream = require('fs').createReadStream;
      
      // 创建一个可以触发error事件的mock
      const mockCreateReadStream = jest.fn().mockImplementation(() => {
        const mockStream = {
          on: function(event: string, callback: Function) {
            if (event === 'error') {
              setTimeout(() => {
                callback(new Error('模拟的流读取错误'));
              }, 10);
            }
            return this;
          }
        };
        return mockStream;
      });
      
      try {
        // 替换原始函数
        require('fs').createReadStream = mockCreateReadStream;
        
        // 设置选项以确保使用流处理
        const options: Md5Options = {
          useStreamProcessing: true,
          largeFileThreshold: 0 // 确保使用流处理
        };
        
        // 执行测试
        await expect(calculateMd5(testFile, options)).rejects.toThrow('模拟的流读取错误');
      } finally {
        // 恢复原始函数
        require('fs').createReadStream = originalCreateReadStream;
      }
    });

    // 新增测试用例 - 计算空文件的MD5
    test('计算空文件的MD5', async () => {
      const emptyFile = path.join(TEST_DIR, 'empty-file.txt');
      await fs.writeFile(emptyFile, ''); // 创建空文件
      
      // 空文件的标准MD5值
      const expectedMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
      
      const md5 = await calculateMd5(emptyFile);
      expect(md5).toBe(expectedMd5);
    });
    
    // 新增测试用例 - 测试禁用流处理选项
    test('禁用流处理选项', async () => {
      const testFile = path.join(TEST_DIR, 'no-stream.txt');
      const content = 'test content for disabled stream processing';
      await fs.writeFile(testFile, content);
      
      const expectedMd5 = crypto.createHash('md5').update(content).digest('hex');
      
      // 强制使用非流式处理，即使文件较大
      const md5 = await calculateMd5(testFile, {
        useStreamProcessing: false,
        largeFileThreshold: 1 // 设置极小的阈值，但由于禁用了流处理，不会使用流
      });
      
      expect(md5).toBe(expectedMd5);
    });
    
    // 新增测试用例 - 测试calculateOptimizedMd5函数的大文件分支
    test('优化的MD5计算 - 大文件策略', async () => {
      // 模拟文件大小介于10MB-1GB之间的情况
      const testFile = path.join(TEST_DIR, 'medium-optimized.txt');
      // 为了测试方便，我们只创建一个小文件，但模拟其stats的大小
      await fs.writeFile(testFile, 'medium file content');
      
      // 保存并模拟fs.promises.stat方法
      const originalStat = fs.promises.stat;
      fs.promises.stat = jest.fn().mockResolvedValue({
        size: 20 * 1024 * 1024, // 20MB
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      });
      
      try {
        // 计算预期的MD5
        const expectedMd5 = crypto.createHash('md5').update('medium file content').digest('hex');
        
        // 使用优化的MD5计算
        const md5 = await calculateOptimizedMd5(testFile);
        
        expect(md5).toBe(expectedMd5);
      } finally {
        // 恢复原始函数
        fs.promises.stat = originalStat;
      }
    });
    
    // 新增测试用例 - 测试calculateOptimizedMd5函数的超大文件分支
    test('优化的MD5计算 - 超大文件策略', async () => {
      // 模拟文件大小超过1GB的情况
      const testFile = path.join(TEST_DIR, 'large-optimized.txt');
      // 为了测试方便，我们只创建一个小文件，但模拟其stats的大小
      await fs.writeFile(testFile, 'very large file content');
      
      // 保存并模拟fs.promises.stat方法
      const originalStat = fs.promises.stat;
      fs.promises.stat = jest.fn().mockResolvedValue({
        size: 2 * 1024 * 1024 * 1024, // 2GB
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      });
      
      try {
        // 计算预期的MD5
        const expectedMd5 = crypto.createHash('md5').update('very large file content').digest('hex');
        
        // 使用优化的MD5计算
        const md5 = await calculateOptimizedMd5(testFile);
        
        expect(md5).toBe(expectedMd5);
      } finally {
        // 恢复原始函数
        fs.promises.stat = originalStat;
      }
    });
    
    // 新增测试用例 - 测试带有filePath的进度回调
    test('进度回调应该包含文件路径', async () => {
      const testFile = path.join(TEST_DIR, 'progress-path-test.txt');
      const buffer = Buffer.alloc(1024 * 5, 'y'); // 5KB
      await fs.writeFile(testFile, buffer);
      
      // 路径和进度记录
      const progressPaths: string[] = [];
      const progressValues: number[] = [];
      
      const options: Md5Options = {
        useStreamProcessing: true,
        largeFileThreshold: 1024, // 1KB
        onProgress: (progress, filePath) => {
          // 记录传递给回调的文件路径和进度值
          progressPaths.push(filePath);
          progressValues.push(progress);
        }
      };
      
      await calculateMd5(testFile, options);
      
      // 确保回调中提供了正确的文件路径
      expect(progressPaths.length).toBeGreaterThan(0);
      expect(progressPaths[0]).toBe(testFile);
      // 检查是否有进度值
      expect(progressValues.length).toBeGreaterThan(0);
    });
    
    // 新增测试用例 - 测试手动设置并发数的批量计算
    test('批量计算MD5 - 指定具体并发数', async () => {
      // 创建一个测试文件
      const testFile = path.join(TEST_DIR, 'concurrency-test.txt');
      await fs.writeFile(testFile, 'concurrency test content');
      
      const stats = await fs.stat(testFile);
      const fileItem: FileItem = {
        path: testFile,
        name: path.basename(testFile),
        size: stats.size,
        createTime: stats.birthtime,
        modifyTime: stats.mtime
      };
      
      // 明确指定并发数为1
      const updatedItems = await calculateBatchMd5([fileItem], {}, 1);
      
      // 验证计算结果
      expect(updatedItems[0].md5).toBeDefined();
    });

    // 添加大文件测试套件
    describe('真实大文件测试', () => {
      const testDir = path.join(__dirname, '../../temp-test');
      const smallFile = path.join(testDir, 'small-test-file.dat');
      const mediumFile = path.join(testDir, 'medium-test-file.dat');
      const largeFile = path.join(testDir, 'large-test-file.dat');
      
      const KB = 1024;
      const MB = 1024 * KB;
      const SMALL_SIZE = 1 * MB;
      const MEDIUM_SIZE = 10 * MB;
      // 测试文件太小时，会导致和进度回调相关的测试失败
      const LARGE_SIZE = 1000 * MB;

      beforeEach(async () => {
        // 确保测试目录存在
        if (!fs.existsSync(testDir)) {
          await fs.promises.mkdir(testDir, { recursive: true });
        }
      });

      afterAll(async () => {
        // 测试完成后清理文件
        if (fs.existsSync(smallFile)) await fs.promises.unlink(smallFile);
        if (fs.existsSync(mediumFile)) await fs.promises.unlink(mediumFile);
        if (fs.existsSync(largeFile)) await fs.promises.unlink(largeFile);
        
        // 尝试删除测试目录
        try {
          await fs.promises.rmdir(testDir);
        } catch (err) {
          console.warn('无法删除测试目录', err);
        }
      });

      /**
       * 创建指定大小的测试文件
       */
      async function createTestFile(filePath: string, sizeInBytes: number): Promise<void> {
        return new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(filePath);
          let bytesWritten = 0;
          const chunkSize = 1 * MB; // 每次写入1MB
          
          const writeChunk = () => {
            const remainingBytes = sizeInBytes - bytesWritten;
            if (remainingBytes <= 0) {
              writeStream.end(() => resolve());
              return;
            }
            
            const currentChunkSize = Math.min(chunkSize, remainingBytes);
            // 创建有规律的数据块，以便MD5值可以被验证
            const buffer = Buffer.alloc(currentChunkSize);
            for (let i = 0; i < currentChunkSize; i++) {
              buffer[i] = (bytesWritten + i) % 256;
            }
            
            const canContinue = writeStream.write(buffer);
            bytesWritten += currentChunkSize;
            
            if (canContinue) {
              process.nextTick(writeChunk);
            } else {
              writeStream.once('drain', writeChunk);
            }
          };
          
          writeStream.on('error', reject);
          writeChunk();
        });
      }

      // 跳过真正的大文件测试，因为它们会花费很长时间
      // 如果需要运行这些测试，可以删除 .skip
      test('创建并验证1MB测试文件', async () => {
        await createTestFile(smallFile, SMALL_SIZE);
        
        expect(fs.existsSync(smallFile)).toBe(true);
        const stats = await fs.promises.stat(smallFile);
        expect(stats.size).toBe(SMALL_SIZE);
        
        // 计算并验证MD5
        const md5 = await calculateMd5(smallFile);
        expect(md5).toMatch(/^[a-f0-9]{32}$/); // 应该是一个有效的MD5哈希
        
        console.log(`1MB文件MD5: ${md5}`);
      }, 30000);
      
      test('创建并验证10MB测试文件', async () => {
        await createTestFile(mediumFile, MEDIUM_SIZE);
        
        expect(fs.existsSync(mediumFile)).toBe(true);
        const stats = await fs.promises.stat(mediumFile);
        expect(stats.size).toBe(MEDIUM_SIZE);
        
        // 计算并验证MD5
        const md5Standard = await calculateMd5(mediumFile, { useStreamProcessing: false });
        const md5Stream = await calculateMd5(mediumFile, { useStreamProcessing: true });
        
        // 两种方法计算的MD5应该相同
        expect(md5Standard).toMatch(/^[a-f0-9]{32}$/);
        expect(md5Stream).toMatch(/^[a-f0-9]{32}$/);
        expect(md5Standard).toBe(md5Stream);
        
        console.log(`10MB文件MD5: ${md5Standard}`);
      }, 60000);
      
      test('创建并验证100MB测试文件', async () => {
        await createTestFile(largeFile, LARGE_SIZE);
        
        expect(fs.existsSync(largeFile)).toBe(true);
        const stats = await fs.promises.stat(largeFile);
        expect(stats.size).toBe(LARGE_SIZE);
        
        // 记录进度更新
        const progressUpdates: number[] = [];
        
        // 计算并验证MD5
        const md5 = await calculateMd5(largeFile, {
          useStreamProcessing: true,
          onProgress: (progress) => {
            progressUpdates.push(progress);
          }
        });
        
        expect(md5).toMatch(/^[a-f0-9]{32}$/);
        
        // 验证进度回调
        expect(progressUpdates.length).toBeGreaterThan(0);
        expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
        
        console.log(`100MB文件MD5: ${md5}`);
        console.log(`进度更新次数: ${progressUpdates.length}`);
      }, 120000);
    });
  });
}); 