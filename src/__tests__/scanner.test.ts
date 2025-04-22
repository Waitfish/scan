/**
 * @file 文件扫描器测试
 */

import { scanFiles } from '../core/scanner';
import * as path from 'path';
import * as fs from 'fs-extra';
import { FileItem, MatchRule } from '../types'; // Import FileItem and MatchRule

describe('文件扫描器', () => {
  const testDir = path.join(__dirname, '../../test-files');
  
  beforeAll(async () => {
    // 创建测试目录和文件
    await fs.ensureDir(testDir);
    await fs.writeFile(path.join(testDir, 'test1.txt'), 'test content');
    await fs.writeFile(path.join(testDir, 'test2.js'), 'console.log("test")');
    await fs.writeFile(path.join(testDir, 'MeiTuan-report.docx'), 'docx content');
    await fs.writeFile(path.join(testDir, 'BuYunSou-data.pdf'), 'pdf content');
    await fs.writeFile(path.join(testDir, 'other-report.docx'), 'other docx');
    
    await fs.ensureDir(path.join(testDir, 'subdir'));
    await fs.writeFile(path.join(testDir, 'subdir', 'test3.txt'), 'subdir content');
    await fs.writeFile(path.join(testDir, 'subdir', 'MeiTuan-summary.doc'), 'doc content');
    await fs.writeFile(path.join(testDir, 'subdir', 'BuYunSou-archive.zip'), 'zip content');

    await fs.ensureDir(path.join(testDir, 'subdir', 'deep'));
    await fs.writeFile(path.join(testDir, 'subdir', 'deep', 'test5.txt'), 'deep content');
    await fs.writeFile(path.join(testDir, 'subdir', 'deep', 'MeiTuan-final.docx'), 'deep docx');

    await fs.ensureDir(path.join(testDir, 'large-files'));
    await fs.writeFile(
      path.join(testDir, 'large-files', 'large-file.bin'), 
      Buffer.alloc(1024 * 1024, 'a') // 1MB file
    );
  });

  afterAll(async () => {
    await fs.remove(testDir);
  });

  // --- 测试新的匹配逻辑 ---
  describe('规则匹配功能', () => {
    test('应该根据规则匹配文件（后缀+文件名）', async () => {
      const rules: MatchRule[] = [
        [['docx', 'doc'], '^MeiTuan.*'], // 匹配 MeiTuan 的 docx 或 doc
        [['pdf'], '^BuYunSou.*']       // 匹配 BuYunSou 的 pdf
      ];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      
      const matchedNames = results.map(f => f.name).sort();
      expect(matchedNames).toEqual([
        'BuYunSou-data.pdf', 
        'MeiTuan-final.docx', 
        'MeiTuan-report.docx', 
        'MeiTuan-summary.doc'
      ]);
    });

    test('应该不匹配仅后缀或仅文件名符合规则的文件', async () => {
      const rules: MatchRule[] = [
        [['docx'], '^MeiTuan.*'] // 只匹配 MeiTuan 的 docx
      ];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      
      expect(results.some(f => f.name === 'other-report.docx')).toBe(false);
      expect(results.some(f => f.name === 'MeiTuan-summary.doc')).toBe(false);
    });
    
    test('应该正确处理带点的后缀和不带点的后缀', async () => {
      const rules: MatchRule[] = [
        [['.docx', 'doc'], '^MeiTuan.*'], 
      ];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      const matchedNames = results.map(f => f.name).sort();
       expect(matchedNames).toEqual([
        'MeiTuan-final.docx', 
        'MeiTuan-report.docx', 
        'MeiTuan-summary.doc'
      ]);
    });
  });

  // --- 更新现有测试以使用新接口 ---
  describe('基本扫描功能（已更新）', () => {
    test('应该能扫描到指定目录下的所有匹配文件', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: 1 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(f => f.name.endsWith('.txt'))).toBe(true);
      expect(results[0]).toHaveProperty('path');
      expect(results[0]).toHaveProperty('size');
    });

    test('应该能限制扫描深度', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: 0 });
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
      expect(results.some(file => file.name === 'test1.txt')).toBe(true);
    });

    test('应该能扫描到最深层的文件（深度-1）', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      expect(results.some(file => file.path.includes('deep'))).toBe(true);
    });

    test('应该返回正确的文件信息', async () => {
      const rules: MatchRule[] = [[['pdf'], '^BuYunSou.*']];
      const results = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      expect(results.length).toBe(1);
      const file = results[0];
      expect(file.name).toBe('BuYunSou-data.pdf');
      expect(file.path).toBe(path.join(testDir, 'BuYunSou-data.pdf'));
      expect(file.size).toBeGreaterThan(0);
      // 验证 createTime 是有效的 Date 对象
      expect(typeof file.createTime.getTime).toBe('function');
      expect(typeof file.createTime.getTime()).toBe('number');
      // 验证 modifyTime 是有效的 Date 对象
      expect(typeof file.modifyTime.getTime).toBe('function');
      expect(typeof file.modifyTime.getTime()).toBe('number');
    });
  });

  describe('进度报告功能（已更新）', () => {
    test('应该正确报告扫描进度，并在匹配时传递文件信息', async () => {
      const rules: MatchRule[] = [
        [['docx', 'doc'], '^MeiTuan.*']
      ];
      const progressUpdates: { progress: any, file?: FileItem }[] = [];
      let matchedFileReported = false;

      await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        onProgress: (progress, matchedFile) => {
          progressUpdates.push({ progress: { ...progress }, file: matchedFile });
          if (matchedFile) {
            matchedFileReported = true;
            expect(matchedFile.name).toMatch(/^MeiTuan.*/);
            expect(matchedFile.path).toBeDefined();
          }
        }
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(matchedFileReported).toBe(true);

      const lastProgress = progressUpdates[progressUpdates.length - 1].progress;
      expect(lastProgress.scannedDirs).toBeGreaterThan(0);
      expect(lastProgress.scannedFiles).toBeGreaterThan(0);
      expect(lastProgress.matchedFiles).toBe(3);
    });
  });

  describe('文件大小限制（已更新）', () => {
    test('应该忽略超过大小限制的文件', async () => {
      const rules: MatchRule[] = [[['bin'], '.*']];
      const smallFileSize = 1024;
      const progressUpdates: { progress: any, file?: FileItem }[] = [];

      const results = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        maxFileSize: smallFileSize,
        onProgress: (progress, matchedFile) => {
          progressUpdates.push({ progress: { ...progress }, file: matchedFile });
        }
      });

      expect(results.some(file => file.name === 'large-file.bin')).toBe(false);
      
      const lastProgress = progressUpdates.find(p => p.progress.ignoredLargeFiles > 0)?.progress;
      expect(lastProgress).toBeDefined();
      if (lastProgress) {
        expect(lastProgress.ignoredLargeFiles).toBeGreaterThan(0);
      }
    });
  });

  describe('目录跳过功能（已更新）', () => {
    test('应该跳过完全匹配的目录', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const results = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: ['subdir']
      });
      expect(results.some(file => file.path.includes('subdir'))).toBe(false);
      expect(results.some(file => file.name === 'test1.txt')).toBe(true);
    });

    test('应该跳过子目录', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const results = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: ['subdir/deep']
      });
      expect(results.some(file => file.path.includes('deep'))).toBe(false);
      expect(results.some(file => file.name === 'test3.txt')).toBe(true);
    });
  });
}); 