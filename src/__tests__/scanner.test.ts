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
    await fs.ensureDir(path.join(testDir, 'subdir', 'deep'));
    await fs.writeFile(
      path.join(testDir, 'subdir', 'deep', 'test4.txt'),
      'deep content'
    );
  });

  afterAll(async () => {
    // 清理测试文件
    await fs.remove(testDir);
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