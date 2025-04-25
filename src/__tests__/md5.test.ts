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
    createReadStream: jest.fn()
  };
});

// 导入fs模块
import * as fsNode from 'fs'; // 引入原生fs模块

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
  });
}); 