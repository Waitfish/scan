/**
 * @file 文件去重测试
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import {
  Deduplicator,
  createDeduplicator
} from '../core/deduplication';
import { FileItem } from '../types';
import {DeduplicationType} from  '../types/deduplication'

describe('文件去重功能', () => {
  // 测试目录
  const testDir = path.join(os.tmpdir(), 'deduplication-test');
  // 历史记录文件路径
  const historyFilePath = path.join(testDir, 'historical-uploads.json');
  
  // 创建测试文件项
  const createFileItem = (name: string, md5: string): FileItem => ({
    path: path.join(testDir, name),
    name,
    size: 1024,
    createTime: new Date(),
    modifyTime: new Date(),
    md5
  });

  beforeAll(async () => {
    // 创建测试目录
    await fs.ensureDir(testDir);
  });

  afterAll(async () => {
    // 删除测试目录
    await fs.remove(testDir);
  });

  beforeEach(async () => {
    // 每个测试前清理历史记录文件
    if (await fs.pathExists(historyFilePath)) {
      await fs.remove(historyFilePath);
    }
  });

  describe('基本功能', () => {
    test('创建去重器实例', () => {
      const deduplicator = createDeduplicator();
      expect(deduplicator).toBeInstanceOf(Deduplicator);
    });

    test('自定义选项创建去重器', () => {
      const options = {
        enabled: true,
        useHistoricalDeduplication: false,
        useTaskDeduplication: true,
        historyFilePath: path.join(testDir, 'custom-history.json'),
        autoSaveInterval: 10000
      };
      
      const deduplicator = createDeduplicator(options);
      expect(deduplicator).toBeInstanceOf(Deduplicator);
    });

    test('禁用去重功能', () => {
      const deduplicator = createDeduplicator({ enabled: false });
      
      // 创建相同MD5的文件项
      const fileItem1 = createFileItem('file1.txt', 'same-md5');
      const fileItem2 = createFileItem('file2.txt', 'same-md5');
      
      // 禁用去重时，所有文件都不应该被识别为重复
      const result1 = deduplicator.checkDuplicate(fileItem1);
      const result2 = deduplicator.checkDuplicate(fileItem2);
      
      expect(result1.isDuplicate).toBe(false);
      expect(result2.isDuplicate).toBe(false);
    });
  });

  describe('任务内去重', () => {
    test('检测任务内重复文件', () => {
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: false,
        useTaskDeduplication: true
      });
      
      // 创建相同MD5的文件项
      const fileItem1 = createFileItem('file1.txt', 'same-md5');
      const fileItem2 = createFileItem('file2.txt', 'same-md5');
      const fileItem3 = createFileItem('file3.txt', 'different-md5');
      
      // 第一个文件不重复
      const result1 = deduplicator.checkDuplicate(fileItem1);
      // 第二个文件应该被识别为任务内重复
      const result2 = deduplicator.checkDuplicate(fileItem2);
      // 第三个文件有不同的MD5，不重复
      const result3 = deduplicator.checkDuplicate(fileItem3);
      
      expect(result1.isDuplicate).toBe(false);
      expect(result1.type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      expect(result2.isDuplicate).toBe(true);
      expect(result2.type).toBe(DeduplicationType.TASK_DUPLICATE);
      
      expect(result3.isDuplicate).toBe(false);
      expect(result3.type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      // 验证任务内重复文件列表
      const skippedDuplicates = deduplicator.getSkippedTaskDuplicates();
      expect(skippedDuplicates.length).toBe(1);
      expect(skippedDuplicates[0].name).toBe('file2.txt');
    });

    test('重置当前任务', () => {
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: false,
        useTaskDeduplication: true
      });
      
      // 创建相同MD5的文件项
      const fileItem1 = createFileItem('file1.txt', 'same-md5');
      const fileItem2 = createFileItem('file2.txt', 'same-md5');
      
      // 第一个文件不重复
      deduplicator.checkDuplicate(fileItem1);
      // 第二个文件应该被识别为任务内重复
      deduplicator.checkDuplicate(fileItem2);
      
      // 验证任务内重复文件列表
      expect(deduplicator.getSkippedTaskDuplicates().length).toBe(1);
      
      // 重置当前任务
      deduplicator.resetCurrentTask();
      
      // 验证重置后的状态
      expect(deduplicator.getSkippedTaskDuplicates().length).toBe(0);
      expect(deduplicator.getCurrentTaskMd5Set().size).toBe(0);
      
      // 重置后，相同的文件不应该被识别为重复
      const result1 = deduplicator.checkDuplicate(fileItem1);
      expect(result1.isDuplicate).toBe(false);
    });

    test('禁用任务内去重', () => {
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: false,
        useTaskDeduplication: false
      });
      
      // 创建相同MD5的文件项
      const fileItem1 = createFileItem('file1.txt', 'same-md5');
      const fileItem2 = createFileItem('file2.txt', 'same-md5');
      
      // 两个文件都不应该被识别为重复
      const result1 = deduplicator.checkDuplicate(fileItem1);
      const result2 = deduplicator.checkDuplicate(fileItem2);
      
      expect(result1.isDuplicate).toBe(false);
      expect(result2.isDuplicate).toBe(false);
    });
  });

  describe('历史记录去重', () => {
    test('与历史记录去重', async () => {
      // 创建测试历史记录文件
      await fs.writeJson(historyFilePath, ['historical-md5']);
      
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: true,
        useTaskDeduplication: false,
        historyFilePath
      });
      
      // 初始化去重器
      await deduplicator.initialize();
      
      // 创建文件项
      const fileItem1 = createFileItem('file1.txt', 'historical-md5');
      const fileItem2 = createFileItem('file2.txt', 'new-md5');
      
      // 检查重复
      const result1 = deduplicator.checkDuplicate(fileItem1);
      const result2 = deduplicator.checkDuplicate(fileItem2);
      
      expect(result1.isDuplicate).toBe(true);
      expect(result1.type).toBe(DeduplicationType.HISTORICAL_DUPLICATE);
      
      expect(result2.isDuplicate).toBe(false);
      expect(result2.type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      // 验证历史重复文件列表
      const skippedHistorical = deduplicator.getSkippedHistoricalDuplicates();
      expect(skippedHistorical.length).toBe(1);
      expect(skippedHistorical[0].name).toBe('file1.txt');
    });

    test('添加文件到历史记录', async () => {
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: true,
        useTaskDeduplication: true,
        historyFilePath
      });
      
      // 创建文件项
      const fileItem = createFileItem('file.txt', 'new-md5');
      
      // 添加到历史记录
      const added = deduplicator.addToHistory(fileItem);
      expect(added).toBe(true);
      
      // 再次添加相同MD5的文件应该返回false
      const addedAgain = deduplicator.addToHistory(fileItem);
      expect(addedAgain).toBe(false);
      
      // 保存历史记录
      const saved = await deduplicator.saveHistoricalMd5();
      expect(saved).toBe(true);
      
      // 验证历史记录文件
      expect(await fs.pathExists(historyFilePath)).toBe(true);
      
      // 读取历史记录文件
      const historyContent = await fs.readJson(historyFilePath);
      expect(historyContent).toContain('new-md5');
    });

    test('批量添加文件到历史记录', () => {
      const deduplicator = createDeduplicator();
      
      // 创建文件项
      const fileItems = [
        createFileItem('file1.txt', 'md5-1'),
        createFileItem('file2.txt', 'md5-2'),
        createFileItem('file3.txt', 'md5-3')
      ];
      
      // 批量添加
      const addedCount = deduplicator.addBatchToHistory(fileItems);
      expect(addedCount).toBe(3);
      
      // 重复添加应该返回0
      const addedAgain = deduplicator.addBatchToHistory(fileItems);
      expect(addedAgain).toBe(0);
    });

    test('加载不存在的历史记录文件', async () => {
      const nonExistentPath = path.join(testDir, 'non-existent.json');
      
      const deduplicator = createDeduplicator({
        historyFilePath: nonExistentPath
      });
      
      // 加载不存在的文件应该成功，但集合为空
      const loaded = await deduplicator.loadHistoricalMd5();
      expect(loaded).toBe(true);
      expect(deduplicator.getHistoricalMd5Set().size).toBe(0);
    });

    test('加载格式错误的历史记录文件', async () => {
      // 创建格式错误的历史记录文件
      const invalidPath = path.join(testDir, 'invalid-history.json');
      await fs.writeFile(invalidPath, '{ "invalid": "format" }');
      
      const deduplicator = createDeduplicator({
        historyFilePath: invalidPath
      });
      
      // 加载格式错误的文件应该失败，但不抛出异常
      const loaded = await deduplicator.loadHistoricalMd5();
      expect(loaded).toBe(false);
      // 集合应该初始化为空
      expect(deduplicator.getHistoricalMd5Set().size).toBe(0);
    });
  });

  describe('综合功能测试', () => {
    test('历史记录和任务内去重综合测试', async () => {
      // 创建测试历史记录文件
      await fs.writeJson(historyFilePath, ['historical-md5']);
      
      const deduplicator = createDeduplicator({
        historyFilePath
      });
      
      // 初始化
      await deduplicator.initialize();
      
      // 创建文件项
      const fileItems = [
        createFileItem('file1.txt', 'historical-md5'), // 历史重复
        createFileItem('file2.txt', 'task-md5'),      // 不重复
        createFileItem('file3.txt', 'task-md5'),      // 任务内重复
        createFileItem('file4.txt', 'new-md5')        // 不重复
      ];
      
      // 检查重复
      const results = fileItems.map(item => deduplicator.checkDuplicate(item));
      
      // 验证结果
      expect(results[0].isDuplicate).toBe(true);
      expect(results[0].type).toBe(DeduplicationType.HISTORICAL_DUPLICATE);
      
      expect(results[1].isDuplicate).toBe(false);
      expect(results[1].type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      expect(results[2].isDuplicate).toBe(true);
      expect(results[2].type).toBe(DeduplicationType.TASK_DUPLICATE);
      
      expect(results[3].isDuplicate).toBe(false);
      expect(results[3].type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      // 验证去重结果集合
      expect(deduplicator.getSkippedHistoricalDuplicates().length).toBe(1);
      expect(deduplicator.getSkippedTaskDuplicates().length).toBe(1);
      expect(deduplicator.getCurrentTaskMd5Set().size).toBe(2); // task-md5, new-md5
    });

    test('处理没有MD5值的文件项', () => {
      const deduplicator = createDeduplicator();
      
      // 创建没有MD5值的文件项
      const fileItem: FileItem = {
        path: path.join(testDir, 'no-md5.txt'),
        name: 'no-md5.txt',
        size: 1024,
        createTime: new Date(),
        modifyTime: new Date()
        // 没有md5字段
      };
      
      // 检查重复
      const result = deduplicator.checkDuplicate(fileItem);
      
      // 没有MD5值的文件应该被识别为非重复
      expect(result.isDuplicate).toBe(false);
      expect(result.type).toBe(DeduplicationType.NOT_DUPLICATE);
      
      // 添加到历史记录应该失败
      const added = deduplicator.addToHistory(fileItem);
      expect(added).toBe(false);
    });

    test('销毁资源', () => {
      const deduplicator = createDeduplicator({
        autoSaveInterval: 1000
      });
      
      // 获取自动保存计时器
      const timerSpy = jest.spyOn(global, 'clearInterval');
      
      // 销毁资源
      deduplicator.dispose();
      
      // 应该调用clearInterval
      expect(timerSpy).toHaveBeenCalled();
      
      timerSpy.mockRestore();
    });

    // 新增：测试从压缩文件中提取的文件去重计数
    test('测试压缩文件与正常文件的历史去重计数', async () => {
      // 创建测试历史记录文件，包含一些MD5
      const md5Values = ['historical-md5-1', 'historical-md5-2', 'historical-md5-3'];
      await fs.writeJson(historyFilePath, md5Values);
      
      const deduplicator = createDeduplicator({
        useHistoricalDeduplication: true,
        useTaskDeduplication: true,
        historyFilePath
      });
      
      // 初始化去重器
      await deduplicator.initialize();
      
      // 确认历史记录已加载
      expect(deduplicator.getHistoricalMd5Set().size).toBe(3);
      
      // 创建基础文件项
      const baseFiles = [
        // 普通文件，与历史记录中的文件重复
        {
          path: path.join(testDir, 'file1.txt'),
          name: 'file1.txt',
          size: 1024,
          createTime: new Date(),
          modifyTime: new Date(),
          md5: 'historical-md5-1',
          origin: 'filesystem' as const
        },
        // 普通文件，不重复
        {
          path: path.join(testDir, 'file2.txt'),
          name: 'file2.txt',
          size: 1024,
          createTime: new Date(),
          modifyTime: new Date(),
          md5: 'new-md5-1',
          origin: 'filesystem' as const
        }
      ];
      
      // 创建模拟压缩包中的文件项
      const archiveFiles = [
        // 压缩包中的文件，与历史记录中的文件重复
        {
          path: path.join(testDir, 'archive/file3.txt'),
          name: 'file3.txt',
          size: 1024,
          createTime: new Date(),
          modifyTime: new Date(),
          md5: 'historical-md5-2',
          origin: 'archive' as const,
          archivePath: path.join(testDir, 'test.zip'),
          internalPath: 'file3.txt'
        },
        // 压缩包中的另一个文件，与历史记录中的文件重复
        {
          path: path.join(testDir, 'archive/file4.txt'),
          name: 'file4.txt',
          size: 1024,
          createTime: new Date(),
          modifyTime: new Date(),
          md5: 'historical-md5-3',
          origin: 'archive' as const,
          archivePath: path.join(testDir, 'test.zip'),
          internalPath: 'file4.txt'
        }
      ];
      
      // 合并所有文件
      const allFiles = [...baseFiles, ...archiveFiles];
      
      // 检查重复
      for (const file of allFiles) {
        deduplicator.checkDuplicate(file);
      }
      
      // 获取历史重复文件列表
      const skippedHistorical = deduplicator.getSkippedHistoricalDuplicates();
      
      // 应该有3个历史重复文件（1个普通文件和2个压缩包文件）
      expect(skippedHistorical.length).toBe(3);
      
      // 统计不同来源的文件数量
      const filesystemFiles = skippedHistorical.filter(f => f.origin === 'filesystem' || !f.origin);
      const archiveFilesResult = skippedHistorical.filter(f => f.origin === 'archive');
      
      // 验证来源统计
      expect(filesystemFiles.length).toBe(1); // 1个普通文件
      expect(archiveFilesResult.length).toBe(2); // 2个压缩包文件
      
      // 打印详细结果，帮助诊断
      console.log('历史重复文件列表详情:');
      skippedHistorical.forEach((file, index) => {
        console.log(`[${index+1}] 路径: ${file.path}, MD5: ${file.md5}, 来源: ${file.origin || 'filesystem'}`);
      });
      
      // 确认队列中没有重复计数的文件
      const pathMap = new Map<string, number>();
      skippedHistorical.forEach(file => {
        const path = file.path;
        pathMap.set(path, (pathMap.get(path) || 0) + 1);
      });
      
      // 检查是否有路径出现多次
      const duplicatePaths = Array.from(pathMap.entries()).filter(([_, count]) => count > 1);
      expect(duplicatePaths.length).toBe(0); // 不应该有重复计数的文件
    });
  });
}); 