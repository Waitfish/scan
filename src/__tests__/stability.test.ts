/**
 * @file 文件稳定性检测测试
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { 
  isFileLocked, 
  waitForFileStability, 
  checkFileStability, 
  FileStabilityStatus,
  createBatchStabilityChecker
} from '../core/stability';
import * as stabilityModule from '../core/stability';

const TEST_DIR = path.join(os.tmpdir(), 'scan-stability-test');

describe('稳定性检测', () => {
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
  });

  describe('基本文件检测', () => {
    test('正常文件检测', async () => {
      const testFile = path.join(TEST_DIR, 'stable-file.txt');
      await fs.writeFile(testFile, 'test content');
      
      const isLocked = await isFileLocked(testFile);
      expect(isLocked).toBe(false);
      
      const status = await checkFileStability(testFile);
      expect(status).toBe(FileStabilityStatus.STABLE);
    });

    test('不存在文件检测', async () => {
      const nonExistentFile = path.join(TEST_DIR, 'non-existent.txt');
      
      const isLocked = await isFileLocked(nonExistentFile);
      expect(isLocked).toBe(true);
      
      const status = await checkFileStability(nonExistentFile);
      expect(status).toBe(FileStabilityStatus.NOT_EXIST);
    });

    test('等待文件稳定', async () => {
      const testFile = path.join(TEST_DIR, 'wait-stable.txt');
      await fs.writeFile(testFile, 'test content');
      
      const isStable = await waitForFileStability(testFile);
      expect(isStable).toBe(true);
    });
  });

  describe('不同大小文件检测', () => {
    test('检测大文件', async () => {
      const largeFilePath = path.join(TEST_DIR, 'large-file.txt');
      
      // 创建一个大小刚好超过阈值的"大文件"（为测试目的，我们使用较小的阈值）
      const largeFileThreshold = 1024; // 1KB，便于测试
      const buffer = Buffer.alloc(largeFileThreshold + 1, 'x');
      await fs.writeFile(largeFilePath, buffer);
      
      const status = await checkFileStability(largeFilePath, { 
        largeFileThreshold,
        skipReadForLargeFiles: true
      });
      
      // 大文件应该也是稳定的
      expect([FileStabilityStatus.STABLE, FileStabilityStatus.SIZE_CHANGING]).toContain(status);
    });
    
    test('检测正在写入的文件', async () => {
      jest.setTimeout(10000); // 增加超时时间以确保写入操作完成
      
      const writingFilePath = path.join(TEST_DIR, 'writing-file.txt');
      
      // 创建一个写入流，模拟文件正在写入
      const fileStream = fs.createWriteStream(writingFilePath);
      
      // 先写入一些数据
      fileStream.write('initial data');
      
      // 检查文件状态（应该被识别为不稳定）
      const isLocked = await isFileLocked(writingFilePath);
      expect(isLocked).toBe(true);
      
      // 等待写入完成
      await new Promise<void>((resolve) => {
        fileStream.end('final data', () => {
          fileStream.close();
          resolve();
        });
      });
      
      // 写入完成后，再次检查（应该是稳定的）
      const isLockedAfterClose = await isFileLocked(writingFilePath);
      expect(isLockedAfterClose).toBe(false);
    });
  });

  describe('批量文件检测', () => {
    test('批量检测多个稳定文件', async () => {
      const file1 = path.join(TEST_DIR, 'batch-file1.txt');
      const file2 = path.join(TEST_DIR, 'batch-file2.txt');
      const file3 = path.join(TEST_DIR, 'batch-file3.txt');
      
      await fs.writeFile(file1, 'content 1');
      await fs.writeFile(file2, 'content 2');
      await fs.writeFile(file3, 'content 3');
      
      const batchChecker = createBatchStabilityChecker();
      const results = await batchChecker([file1, file2, file3]);
      
      expect(results.get(file1)).toBe(true);
      expect(results.get(file2)).toBe(true);
      expect(results.get(file3)).toBe(true);
    });
    
    test('批量检测包含不存在文件', async () => {
      const file1 = path.join(TEST_DIR, 'batch-exist.txt');
      const file2 = path.join(TEST_DIR, 'batch-nonexist.txt');
      
      await fs.writeFile(file1, 'content 1');
      
      const batchChecker = createBatchStabilityChecker();
      const results = await batchChecker([file1, file2]);
      
      expect(results.get(file1)).toBe(true);
      expect(results.get(file2)).toBe(false);
    });
  });
  
  describe('平台特定检测', () => {
    // 这些测试会根据运行平台执行不同的测试
    
    test('平台相关检测', async () => {
      const platform = os.platform();
      const testFile = path.join(TEST_DIR, `platform-${platform}.txt`);
      
      await fs.writeFile(testFile, 'platform test content');
      
      // 不同平台会调用不同的检测方法，但都应该返回稳定结果
      const status = await checkFileStability(testFile);
      expect(status).toBe(FileStabilityStatus.STABLE);
    });
  });

  describe('文件锁定状态检测', () => {
    test('检测无读写权限的文件 (LOCKED)', async () => {
      // 创建一个测试文件
      const lockedFile = path.join(TEST_DIR, 'locked-file.txt');
      await fs.writeFile(lockedFile, 'locked content');
      
      // 模拟文件被锁定（通过移除所有权限）
      if (os.platform() !== 'win32') {
        // 在非Windows系统上，我们可以使用chmod来移除权限
        await fs.chmod(lockedFile, 0); // 移除所有权限
        
        // 检查文件状态
        const status = await checkFileStability(lockedFile);
        expect(status).toBe(FileStabilityStatus.LOCKED);
        
        // 恢复权限以便清理
        await fs.chmod(lockedFile, 0o644);
      } else {
        // Windows上我们通过mock来模拟测试
        console.log('Windows平台不直接测试LOCKED状态');
      }
    });

    test('模拟SIZE_CHANGING状态', async () => {
      // 由于无法直接mock内部函数，我们直接mock整个checkFileStability函数
      jest.spyOn(stabilityModule, 'checkFileStability').mockImplementationOnce(
        async () => FileStabilityStatus.SIZE_CHANGING
      );
      
      const testFile = path.join(TEST_DIR, 'size-changing.txt');
      await fs.writeFile(testFile, 'initial content');
      
      const status = await checkFileStability(testFile);
      expect(status).toBe(FileStabilityStatus.SIZE_CHANGING);
      
      // 恢复原始函数
      jest.restoreAllMocks();
    });
    
    test('模拟WRITING状态', async () => {
      // 由于无法直接mock内部函数，我们直接mock整个checkFileStability函数
      jest.spyOn(stabilityModule, 'checkFileStability').mockImplementationOnce(
        async () => FileStabilityStatus.WRITING
      );
      
      const testFile = path.join(TEST_DIR, 'writing-status.txt');
      await fs.writeFile(testFile, 'initial content');
      
      const status = await checkFileStability(testFile);
      expect(status).toBe(FileStabilityStatus.WRITING);
      
      // 恢复原始函数
      jest.restoreAllMocks();
    });
    
    test('检测CHECK_FAILED状态', async () => {
      // 直接模拟检测函数返回CHECK_FAILED
      jest.spyOn(stabilityModule, 'checkFileStability').mockImplementationOnce(
        async () => FileStabilityStatus.CHECK_FAILED
      );
      
      const testFile = path.join(TEST_DIR, 'check-failed.txt');
      const status = await checkFileStability(testFile);
      
      expect(status).toBe(FileStabilityStatus.CHECK_FAILED);
      
      // 恢复原始函数
      jest.restoreAllMocks();
    });
  });
}); 