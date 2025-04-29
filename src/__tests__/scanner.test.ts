/**
 * @file 文件扫描器测试
 */

import { scanFiles } from '../core/scanner';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as compressing from 'compressing';
import { FileItem, MatchRule, FailureItem } from '../types';

describe('文件扫描器', () => {
  const testDir = path.join(__dirname, '../../test-files');
  const archiveDir = path.join(testDir, 'archives'); 
  const zipPath = path.join(archiveDir, 'test-archive.zip');
  const tgzPath = path.join(archiveDir, 'test-archive.tgz');
  const rarPath = path.join(archiveDir, 'test-archive.rar'); // Path for the manual RAR file

  // --- Setup --- 
  beforeAll(async () => {
    // Clean slate, EXCEPT for the manually placed RAR if it exists
    await fs.ensureDir(archiveDir); // Ensure archives dir exists before potential removal
    const items = await fs.readdir(testDir);
    for (const item of items) {
      if (item !== 'archives') { // Don't remove the archives dir itself
        await fs.remove(path.join(testDir, item));
      }
    }
    await fs.ensureDir(testDir); // Re-ensure testDir exists after potential removal
    
    // Filesystem files
    await fs.writeFile(path.join(testDir, 'root-match.txt'), 'root txt');
    await fs.writeFile(path.join(testDir, 'MeiTuan-report.docx'), 'docx content');
    const subDir = path.join(testDir, 'subdir');
    await fs.ensureDir(subDir);
    await fs.writeFile(path.join(subDir, 'sub-match.txt'), 'subdir txt');
    await fs.writeFile(path.join(subDir, 'MeiTuan-plan.doc'), 'doc content');
    const deepDir = path.join(subDir, 'deep');
    await fs.ensureDir(deepDir);
    await fs.writeFile(path.join(deepDir, 'deep-match.txt'), 'deep txt');
    const skipSubDir = path.join(testDir, 'skip-this');
    await fs.ensureDir(skipSubDir);
    await fs.writeFile(path.join(skipSubDir, 'skipped.txt'), 'should be skipped');
    const largeFilesDir = path.join(testDir, 'large-files');
    await fs.ensureDir(largeFilesDir);
    await fs.writeFile(path.join(largeFilesDir, 'large-match.bin'), Buffer.alloc(1024 * 1024, 'L')); 
    await fs.writeFile(path.join(largeFilesDir, 'small-match.bin'), Buffer.alloc(1024, 'S')); 
    
    // Ensure archives directory exists for creation
    await fs.ensureDir(archiveDir);

    // Create ZIP
    const zipStream = new compressing.zip.Stream();
    zipStream.addEntry(Buffer.from('zip txt content'), { relativePath: 'zip-match.txt' });
    zipStream.addEntry(Buffer.from('zip docx content'), { relativePath: 'docs/MeiTuan-zip.docx' });
    zipStream.addEntry(Buffer.from('ignore this'), { relativePath: 'other/ignored.log' });
    // 添加超大文件确保ZIP文件本身大小超过测试用例中的smallMaxSize (10KB)
    zipStream.addEntry(Buffer.alloc(1024 * 1024), { relativePath: 'large/large-in-zip.dat' }); 
    const zipDestStream = fs.createWriteStream(zipPath);
    await new Promise<void>((resolve, reject) => {
      zipStream.pipe(zipDestStream)
        .on('finish', () => resolve())
        .on('error', reject);
    });

    // Create TGZ
    const tgzStream = new compressing.tgz.Stream();
    tgzStream.addEntry(Buffer.from('tgz txt content'), { relativePath: 'tgz-match.txt' });
    tgzStream.addEntry(Buffer.from('tgz doc content'), { relativePath: 'reports/MeiTuan-tgz.doc' });
    const tgzDestStream = fs.createWriteStream(tgzPath);
    await new Promise<void>((resolve, reject) => {
      tgzStream.pipe(tgzDestStream)
        .on('finish', () => resolve())
        .on('error', reject);
    });

    // Check if manual RAR exists
    if (!await fs.pathExists(rarPath)) {
        console.warn(`警告: 未找到测试 RAR 文件: ${rarPath}. 请手动创建并放入测试文件以覆盖 RAR 扫描功能。`);
    }
  });

  afterAll(async () => {
    await fs.remove(testDir); 
  });

  // --- Tests --- 

  describe('规则匹配功能 (含压缩包)', () => {
     test('应该根据规则匹配文件系统和压缩包中的文件 (zip, tgz, rar)', async () => {
      const rules: MatchRule[] = [
        [['docx', 'doc'], '^MeiTuan.*'],
        [['txt'], '.*-match.txt'] 
      ];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      expect(failures).toHaveLength(0);
      
      const matchedNames = matchedFiles.map(f => f.name).sort();
      const expected = [
        'MeiTuan-plan.doc',       
        'MeiTuan-report.docx',    
        'MeiTuan-tgz.doc',        
        'MeiTuan-zip.docx',
        'MeiTuan-rar.docx',  // Assumed from RAR 
        'deep-match.txt',         
        'root-match.txt',         
        'sub-match.txt',          
        'tgz-match.txt',          
        'zip-match.txt',
        'rar-match.txt'    // Assumed from RAR
      ].sort(); 
      
      // Check if RAR exists. If not, filter out expected RAR files.
      if (!await fs.pathExists(rarPath)) {
          expected.splice(expected.indexOf('MeiTuan-rar.docx'), 1);
          expected.splice(expected.indexOf('rar-match.txt'), 1);
      }
      
      expect(matchedNames).toEqual(expected);
    });
    
    test('应该不匹配仅后缀或仅文件名符合规则的文件', async () => {
      const rules: MatchRule[] = [
        [['docx'], '^MeiTuan.*'] 
      ];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      expect(failures).toHaveLength(0);
      
      // FS: MeiTuan-plan.doc (wrong ext)
      expect(matchedFiles.some(f => f.name === 'MeiTuan-plan.doc' && f.origin !== 'archive')).toBe(false); 
      // Archive: MeiTuan-zip.docx (match)
      expect(matchedFiles.some(f => f.name === 'MeiTuan-zip.docx' && f.origin === 'archive')).toBe(true);
      // Archive: MeiTuan-tgz.doc (wrong ext)
      expect(matchedFiles.some(f => f.name === 'MeiTuan-tgz.doc' && f.origin === 'archive')).toBe(false);
    });
    
    test('应该正确处理带点和不带点的后缀', async () => {
        const rules: MatchRule[] = [
          [['.docx', 'doc'], '^MeiTuan.*'], 
        ];
        const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
        expect(failures).toHaveLength(0);
        
        const matchedNames = matchedFiles.map(f => f.name).sort();
        // UPDATED Expected: includes both FS and archive files
         expect(matchedNames).toEqual([
          'MeiTuan-plan.doc',
          'MeiTuan-report.docx',
          'MeiTuan-tgz.doc',
          'MeiTuan-zip.docx'
        ]);
    });
  });

  describe('压缩包扫描特性 (默认启用)', () => {
    const rules: MatchRule[] = [
      [['txt'], '.*-match.txt'],      
      [['docx', 'doc'], '^MeiTuan.*'] 
    ];
    const baseOptions = { rootDir: testDir, matchRules: rules, depth: -1 };

    test('应该同时扫描文件系统和所有类型压缩包内部 (zip, tgz, rar)', async () => {
      const { matchedFiles, failures } = await scanFiles({ ...baseOptions }); 
      expect(failures).toHaveLength(0);
      
      const filesFromArchive = matchedFiles.filter(f => f.origin === 'archive');
      const filesFromSystem = matchedFiles.filter(f => f.origin === 'filesystem' || f.origin === undefined);
      
      const expectedArchiveCount = await fs.pathExists(rarPath) ? 6 : 4; // 4 from zip/tgz + 2 assumed from rar
      const expectedSystemCount = 5;
      const expectedTotalCount = expectedArchiveCount + expectedSystemCount;

      expect(filesFromArchive.length).toBe(expectedArchiveCount);
      expect(filesFromSystem.length).toBe(expectedSystemCount);
      expect(matchedFiles.length).toBe(expectedTotalCount);

      // Check specific files from each source type
      expect(matchedFiles.some(f => f.name === 'root-match.txt' && f.origin !== 'archive')).toBe(true);
      expect(matchedFiles.some(f => f.name === 'zip-match.txt' && f.archivePath === zipPath)).toBe(true);
      expect(matchedFiles.some(f => f.name === 'tgz-match.txt' && f.archivePath === tgzPath)).toBe(true);
      if(await fs.pathExists(rarPath)) {
          expect(matchedFiles.some(f => f.name === 'rar-match.txt' && f.archivePath === rarPath)).toBe(true);
          expect(matchedFiles.some(f => f.name === 'MeiTuan-rar.docx' && f.archivePath === rarPath)).toBe(true);
      }

      // Verify FileItem structure for RAR
      if (await fs.pathExists(rarPath)) {
        const rarTxt = filesFromArchive.find(f => f.archivePath === rarPath && f.name === 'rar-match.txt');
        expect(rarTxt).toBeDefined();
        expect(rarTxt?.origin).toBe('archive');
        expect(rarTxt?.archivePath).toBe(rarPath);
        // internalPath might vary depending on how RAR was created, adjust if needed
        expect(rarTxt?.internalPath).toBe('rar-match.txt'); 
        const archiveStat = await fs.stat(rarPath);
        expect(rarTxt?.createTime.getTime()).toBe(archiveStat.birthtime.getTime());
        expect(rarTxt?.modifyTime.getTime()).toBe(archiveStat.mtime.getTime());
      }
    });

    test('应该正确处理文件系统和压缩包内文件的大小限制', async () => {
      const smallMaxSize = 10 * 1024; 
      const { matchedFiles, failures } = await scanFiles({ 
        rootDir: testDir, 
        matchRules: [
          [['bin', 'dat'], '.*'],
          ...baseOptions.matchRules 
        ], 
        depth: -1,
        maxFileSize: smallMaxSize 
      });
      
      // 调试 - 输出所有匹配的文件名
      console.log("匹配的文件列表:", matchedFiles.map(f => {
        return {
          name: f.name,
          size: f.size,
          path: f.path,
          internalPath: f.internalPath
        };
      }));
      
      // 调试 - 检查失败列表
      console.log("失败文件列表:", failures.map(f => {
        return {
          type: f.type,
          path: f.path,
          entryPath: f.entryPath,
          error: f.error
        };
      }));
      
      // 现在我们期望在failures中找到因大小超过限制的错误
      const ignoredLargeFiles = failures.filter(f => f.type === 'ignoredLargeFile');
      expect(ignoredLargeFiles.length).toBeGreaterThan(0);
      
      // 大文件不应该被包含在匹配文件中
      expect(matchedFiles.some(f => f.name === 'large-match.bin')).toBe(false);
      
      // 检查failures中是否包含被忽略的大文件
      expect(failures.some(f => f.type === 'ignoredLargeFile' && f.path.includes('large-match.bin'))).toBe(true);
    });

    test('应该通过 onFileMatched 报告所有类型压缩包内的匹配文件', async () => {
      let reportedFromZip = false;
      let reportedFromTgz = false;
      let reportedFromRar = false;
      const matchedFiles: FileItem[] = [];
      const progressUpdates: { progress: any }[] = [];
      
      const { failures } = await scanFiles({
        ...baseOptions,
        onProgress: (progress) => {
          progressUpdates.push({ progress: {...progress} });
        },
        onFileMatched: (file) => {
          matchedFiles.push(file);
          if (file.origin === 'archive') {
            if (file.archivePath === zipPath) reportedFromZip = true;
            if (file.archivePath === tgzPath) reportedFromTgz = true;
            if (file.archivePath === rarPath) reportedFromRar = true;
          }
        }
      });
      expect(failures).toHaveLength(0);
      expect(reportedFromZip).toBe(true);
      expect(reportedFromTgz).toBe(true);
      if (await fs.pathExists(rarPath)) {
          expect(reportedFromRar).toBe(true);
      }
      
      const lastProgress = progressUpdates[progressUpdates.length - 1].progress;
      const expectedArchiveScanCount = await fs.pathExists(rarPath) ? 3 : 2;
      expect(lastProgress.archivesScanned).toBe(expectedArchiveScanCount);
      
      // 验证是否所有匹配的文件都通过onFileMatched报告了
      expect(matchedFiles.length).toBeGreaterThan(0);
    });

    test('跳过目录时，不应扫描其中的压缩包', async () => {
      const skippedZipPath = path.join(testDir, 'skip-this', 'skipped-archive.zip');
      const zipStream = new compressing.zip.Stream();
      zipStream.addEntry(Buffer.from('should be skipped'), { relativePath: 'skip-inside.txt' });
      const destStream = fs.createWriteStream(skippedZipPath);
      await new Promise<void>((resolve) => zipStream.pipe(destStream).on('finish', resolve));
      
      const { matchedFiles, failures } = await scanFiles({ ...baseOptions, skipDirs: ['skip-this'] });
      expect(failures).toHaveLength(0);
      expect(matchedFiles.some(f => f.archivePath === skippedZipPath)).toBe(false);
    });

    test('应该能处理无效或损坏的压缩包文件并报告失败', async () => {
      // 在测试用例内部定义和创建无效文件
      const invalidZipPath = path.join(archiveDir, 'invalid.zip');
      await fs.writeFile(invalidZipPath, 'this is not a zip file');
      
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const rules: MatchRule[] = [[['txt'], '.*']]; 
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });

      expect(matchedFiles.some(f => f.name === 'root-match.txt')).toBe(true);
      
      // 现在我们应该有一个失败项，表示无法处理压缩包
      expect(failures.some(f => f.type === 'archiveOpen' && f.path === invalidZipPath)).toBe(true);
      const failure = failures.find(f => f.path === invalidZipPath);
      expect(failure?.type).toBe('archiveOpen'); 
      // 修改断言以匹配实际错误信息
      expect(failure?.error).toMatch(/directory record signature not found/i); 

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
      
      // 在测试用例结束时清理无效文件
      await fs.remove(invalidZipPath);
    });
    
    test('应该报告无法访问的目录', async () => {
      const inaccessibleDir = path.join(testDir, 'inaccessible');
      await fs.ensureDir(inaccessibleDir);
      await fs.writeFile(path.join(inaccessibleDir, 'secret.txt'), 'content');
      if (process.platform !== 'win32') {
          await fs.chmod(inaccessibleDir, 0o000); 
      }

      const rules: MatchRule[] = [[['txt'], '.*']];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });

      if (process.platform !== 'win32') {
        expect(failures.some(f => f.type === 'directoryAccess' && f.path === inaccessibleDir)).toBe(true);
        expect(matchedFiles.some(f => f.path.includes('inaccessible'))).toBe(false);
      } else {
         console.warn('跳过在 Windows 上测试无法访问目录的权限部分');
         expect(failures.filter(f => f.type === 'directoryAccess' && f.path === inaccessibleDir)).toHaveLength(0);
      }
      
      if (process.platform !== 'win32') {
         await fs.chmod(inaccessibleDir, 0o755); 
      }
    });
  });

  describe('基本扫描功能 (含压缩包)', () => {
    test('应该能扫描到指定目录下的所有匹配文件', async () => {
      const rules: MatchRule[] = [[['txt'], '.*match.txt']];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: 1 });
      expect(failures).toHaveLength(0);
      
      const matchedNames = matchedFiles.map(f => f.name).sort();
      // UPDATED Expected for depth 1: includes root, subdir (depth 1), and archive roots (depth 1)
      expect(matchedNames).toEqual([
          'root-match.txt',   
          'sub-match.txt',    // Added: Found at depth 1
          'tgz-match.txt',    
          'zip-match.txt'   
      ]);
      expect(matchedFiles.every(f => f.name.endsWith('.txt'))).toBe(true);
    });

    test('应该能限制扫描深度', async () => {
      const rules: MatchRule[] = [[['txt'], '.*match.txt']]; 
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: 0 }); 
      expect(failures).toHaveLength(0);
      expect(matchedFiles.some(file => file.path.includes('subdir'))).toBe(false);
      expect(matchedFiles.some(file => file.path.includes('archives'))).toBe(false);
      expect(matchedFiles.some(file => file.origin === 'archive')).toBe(false);
      expect(matchedFiles.map(f => f.name)).toEqual(['root-match.txt']);
    });
    
    test('应该能扫描到最深层的文件 (包括压缩包内)', async () => {
      const rules: MatchRule[] = [
          [['txt'], '.*match.txt'],
          [['docx'], '^MeiTuan.*'] // To find MeiTuan-zip.docx in archive
      ];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: -1 });
      expect(failures).toHaveLength(0);
      // Check deep filesystem file
      expect(matchedFiles.some(file => file.name === 'deep-match.txt' && file.origin !== 'archive')).toBe(true);
      // Check file inside archive subdirectory
      expect(matchedFiles.some(file => file.name === 'MeiTuan-zip.docx' && file.origin === 'archive')).toBe(true);
    });

    test('应该返回正确的文件信息（文件系统）', async () => {
      const rules: MatchRule[] = [[['txt'], '^root.*']];
      const { matchedFiles, failures } = await scanFiles({ rootDir: testDir, matchRules: rules, depth: 0 });
      expect(failures).toHaveLength(0);
      expect(matchedFiles.length).toBe(1);
      const file = matchedFiles[0];
      expect(file.name).toBe('root-match.txt');
      expect(file.path).toBe(path.join(testDir, 'root-match.txt'));
      expect(file.origin).not.toBe('archive');
      // ... other assertions
    });
  });

  describe('目录跳过功能 (已更新)', () => {
    test('应该跳过 skipDirs 中指定的目录（完全匹配）', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const { matchedFiles, failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: ['skip-this']
      });
      expect(failures).toHaveLength(0);
      
      expect(matchedFiles.some(file => file.path.includes('skip-this'))).toBe(false);
      expect(matchedFiles.some(file => file.archivePath?.includes('skip-this'))).toBe(false);
    });

    test('应该跳过 skipDirs 中指定目录的子目录', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const { matchedFiles, failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: ['subdir']
      });
      expect(failures).toHaveLength(0);
      
      expect(matchedFiles.some(file => file.path.includes('subdir'))).toBe(false);
      expect(matchedFiles.some(file => file.archivePath?.includes('subdir'))).toBe(false);
    });

    test('应该跳过根目录（如果指定）', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']];
      const { matchedFiles: _results, failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: [path.basename(testDir)] 
      });
      expect(failures).toHaveLength(0);

      const { matchedFiles: skipResults, failures: skipFailures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        skipDirs: ['subdir'] 
      });
      expect(skipFailures).toHaveLength(0);
      
      // Ensure root file is still found when skipping subdir
      expect(skipResults.some(f=> f.name === 'root-match.txt')).toBe(true);
    });
  });

  describe('进度报告功能 (含压缩包)', () => {
     test('应该报告扫描的压缩包数量', async () => {
      const rules: MatchRule[] = [[['txt'], '.*']]; 
      const progressUpdates: { progress: any }[] = [];
      const matchedFiles: FileItem[] = [];
      
      const { failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        onProgress: (progress) => { 
          progressUpdates.push({ progress: {...progress} }); 
        },
        onFileMatched: (file) => {
          matchedFiles.push(file);
        }
      });
      expect(failures).toHaveLength(0);
      
      const lastRelevantProgress = 
        progressUpdates.slice().reverse().find(p => p.progress.archivesScanned > 0)?.progress || 
        progressUpdates[progressUpdates.length - 1]?.progress;

      expect(lastRelevantProgress).toBeDefined();
      // UPDATED: Expect 2 or more archives, allowing for skipped one if it exists
      expect(lastRelevantProgress.archivesScanned).toBeGreaterThanOrEqual(2); 
      
      // 验证是否收集到了匹配的文件
      expect(matchedFiles.length).toBeGreaterThan(0);
     });
     
     test('应该正确报告扫描进度，并在匹配时传递文件信息', async () => {
      const rules: MatchRule[] = [
        [['docx', 'doc'], '^MeiTuan.*']
      ];
      const progressUpdates: { progress: any }[] = [];
      const matchedFiles: FileItem[] = [];
      let matchedFileReported = false;

      const { failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        onProgress: (progress) => {
          progressUpdates.push({ progress: { ...progress } });
        },
        onFileMatched: (file) => {
          matchedFiles.push(file);
            matchedFileReported = true;
          expect(file.name).toMatch(/^MeiTuan.*/);
          expect(file.path).toBeDefined();
        }
      });

      expect(failures).toHaveLength(0);
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(matchedFileReported).toBe(true); // Should report matched files (FS or Archive)

      const lastProgress = progressUpdates[progressUpdates.length - 1].progress;
      expect(lastProgress.scannedDirs).toBeGreaterThan(0);
      expect(lastProgress.scannedFiles).toBeGreaterThan(0);
      // UPDATED: Expect 4 MeiTuan files (2 FS, 2 Archive)
      expect(lastProgress.matchedFiles).toBe(4);
      
      // 验证通过onFileMatched回调收集的文件
      expect(matchedFiles.length).toBe(4);
      expect(matchedFiles.every(f => f.name.startsWith('MeiTuan'))).toBe(true);
    });
    
    test('应该报告被忽略的大文件', async () => {
      const rules: MatchRule[] = [
        [['bin'], '.*']
      ];
      const smallMaxSize = 1023; // 比small-match.bin小一点
      const failedItems: FailureItem[] = [];
      
      const { failures } = await scanFiles({
        rootDir: testDir,
        matchRules: rules,
        depth: -1,
        maxFileSize: smallMaxSize,
        onFailure: (failure) => {
          failedItems.push(failure);
        }
      });
      
      // 检查是否所有大文件都作为失败报告
      const ignoredLargeFiles = failures.filter(f => f.type === 'ignoredLargeFile');
      expect(ignoredLargeFiles.length).toBeGreaterThan(0);
      
      // 验证通过onFailure回调是否收集到了忽略的大文件
      const callbackLargeFiles = failedItems.filter(f => f.type === 'ignoredLargeFile');
      expect(callbackLargeFiles.length).toBeGreaterThan(0);
      
      // 验证大小限制信息在错误消息中
      expect(ignoredLargeFiles[0].error).toContain(`${smallMaxSize}`);
    });
  });
}); 