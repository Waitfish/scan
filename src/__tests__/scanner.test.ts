/**
 * @file 文件扫描器测试
 */

import { scanFiles } from '../core/scanner';
import * as path from 'path';
import * as fs from 'fs-extra';

describe('文件扫描器', () => {
  const testDir = path.join(__dirname, '../../test-files');
  
  beforeAll(async () => {
    // 创建测试目录和文件
    await fs.ensureDir(testDir);
    await fs.writeFile(
      path.join(testDir, 'test1.txt'),
      'test content'
    );
    await fs.writeFile(
      path.join(testDir, 'test2.js'),
      'console.log("test")'
    );
    await fs.ensureDir(path.join(testDir, 'subdir'));
    await fs.writeFile(
      path.join(testDir, 'subdir', 'test3.txt'),
      'subdir content'
    );
    await fs.writeFile(
      path.join(testDir, 'subdir', 'test4.js'),
      'subdir js content'
    );
    await fs.ensureDir(path.join(testDir, 'subdir', 'deep'));
    await fs.writeFile(
      path.join(testDir, 'subdir', 'deep', 'test5.txt'),
      'deep content'
    );
    // 创建用于测试大小限制的目录和文件
    await fs.ensureDir(path.join(testDir, 'large-files'));
    await fs.writeFile(
      path.join(testDir, 'large-files', 'large-file.bin'), 
      Buffer.alloc(1024 * 1024, 'a') // 创建一个 1MB 的文件
    );
  });

  afterAll(async () => {
    // 清理测试文件
    await fs.remove(testDir);
  });

  describe('文件大小限制', () => {
    test('应该忽略超过大小限制的文件', async () => {
      const smallFileSize = 1024; // 1KB
      const progressUpdates: any[] = [];

      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*', // 扫描所有文件以确保 large-file.bin 会被检查
        depth: -1,
        maxFileSize: smallFileSize, // 设置一个比 1MB 小的限制
        onProgress: (progress) => {
          progressUpdates.push({ ...progress });
        }
      });

      // 确认 1MB 的文件没有被包含在结果中
      expect(results.some(file => file.name === 'large-file.bin')).toBe(false);
      
      // 确认进度报告中 ignoredLargeFiles 计数增加了
      const lastProgress = progressUpdates[progressUpdates.length - 1];
      expect(lastProgress).toBeDefined();
      if (lastProgress) { // Type guard
        expect(lastProgress.ignoredLargeFiles).toBeGreaterThan(0);
      }
    });
  });

  describe('目录跳过功能', () => {
    test('应该跳过完全匹配的目录', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['subdir']
      });
      
      // 不应该包含 subdir 下的文件
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
    });

    test('应该跳过子目录', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['subdir/deep']
      });
      
      // 不应该包含 deep 目录下的文件
      expect(results.some(file => file.path.includes('deep'))).toBe(false);
      // 应该包含 subdir 下的其他文件
      expect(results.some(file => 
        file.path.includes('subdir') && !file.path.includes('deep')
      )).toBe(true);
    });

    test('应该跳过父目录及其所有子目录', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['subdir']
      });
      
      // 不应该包含 subdir 及其子目录下的任何文件
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
    });

    test('应该正确处理相对路径', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['./subdir', '../subdir', 'subdir/']
      });
      
      // 所有相对路径形式都应该被正确识别
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
    });

    test('应该正确处理大小写', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['SUBDIR', 'SubDir']
      });
      
      // 大小写不敏感匹配
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
    });

    test('应该正确处理路径分隔符', async () => {
      const results = await scanFiles({
        rootDir: testDir,
        pattern: '.*',
        depth: -1,
        skipDirs: ['subdir\\deep', 'subdir/deep']
      });
      
      // 不同路径分隔符都应该被正确识别
      expect(results.some(file => file.path.includes('deep'))).toBe(false);
    });
  });

  test('应该能扫描到指定目录下的所有文件', async () => {
    const results = await scanFiles({
      rootDir: testDir,
      pattern: '.*',
      depth: 1
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('path');
    expect(results[0]).toHaveProperty('name');
    expect(results[0]).toHaveProperty('createTime');
    expect(results[0]).toHaveProperty('modifyTime');
  });

  test('应该能根据文件名模式过滤文件', async () => {
    const results = await scanFiles({
      rootDir: testDir,
      pattern: '.*\\.txt$',
      depth: 1
    });
    expect(results.every(file => file.name.endsWith('.txt'))).toBe(true);
  });

  test('应该能限制扫描深度', async () => {
    const results = await scanFiles({
      rootDir: testDir,
      pattern: '.*',
      depth: 0
    });
    const hasSubdirFile = results.some(file => 
      file.path.includes('subdir')
    );
    expect(hasSubdirFile).toBe(false);
  });

  test('应该能扫描到最深层的文件（深度-1）', async () => {
    const results = await scanFiles({
      rootDir: testDir,
      pattern: '.*\\.txt$',
      depth: -1
    });
    const hasDeepFile = results.some(file => 
      file.path.includes('deep')
    );
    expect(hasDeepFile).toBe(true);
  });

  test('应该返回正确的文件信息', async () => {
    const results = await scanFiles({
      rootDir: testDir,
      pattern: 'test1\\.txt$',
      depth: 1
    });
    expect(results.length).toBe(1);
    const file = results[0];
    
    // 验证路径
    expect(file.path).toBe(path.join(testDir, 'test1.txt'));
    
    // 验证文件名
    expect(file.name).toBe('test1.txt');
    
    // 验证时间戳
    const stats = await fs.stat(file.path);
    expect(file.createTime.getTime()).toBeCloseTo(
      stats.birthtime.getTime(),
      -2
    );
    expect(file.modifyTime.getTime()).toBeCloseTo(
      stats.mtime.getTime(),
      -2
    );
  });

  test('应该正确报告扫描进度', async () => {
    const progressUpdates: any[] = [];
    
    await scanFiles({
      rootDir: testDir,
      pattern: '.*',
      depth: -1,
      onProgress: (progress) => {
        progressUpdates.push({ ...progress });
      }
    });

    expect(progressUpdates.length).toBeGreaterThan(0);
    const lastProgress = progressUpdates[progressUpdates.length - 1];
    expect(lastProgress.scannedDirs).toBeGreaterThan(0);
    expect(lastProgress.scannedFiles).toBeGreaterThan(0);
  });
}); 