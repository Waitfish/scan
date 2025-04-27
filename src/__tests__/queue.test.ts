import path from 'path';
import fs from 'fs/promises';
import { FileItem, QueueOptions } from '../types';
import { FileProcessingQueue } from '../core/queue';

// 测试用的模拟文件项
const createMockFileItem = (name: string, size = 1024): FileItem => ({
  path: `/test/path/${name}`,
  name,
  createTime: new Date(),
  modifyTime: new Date(),
  size,
  origin: 'filesystem',
  nestedLevel: 0
});

// 创建一个测试延时函数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('FileProcessingQueue', () => {
  describe('基础队列功能', () => {
    test('应该能够添加文件到队列', () => {
      // 初始化队列系统
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      const file = createMockFileItem('test.txt');
      
      queue.addToMatchedQueue(file);
      
      expect(queue.getQueueStats().matched).toBe(1);
      expect(queue.getQueueStats().total).toBe(1);
    });
    
    test('应该能够从一个队列移动到另一个队列', async () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      const file = createMockFileItem('test.txt');
      
      queue.addToMatchedQueue(file);
      expect(queue.getQueueStats().matched).toBe(1);
      
      // 模拟文件处理流程
      const processCb = jest.fn();
      queue.processNextBatch('stability', 1, processCb);
      
      expect(processCb).toHaveBeenCalledWith([file]);
      expect(queue.getQueueStats().matched).toBe(0);
      expect(queue.getQueueStats().stability).toBe(1);
    });
    
    test('批量处理文件', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 5,
        maxConcurrentTransfers: 5,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      const files = Array(10).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.forEach(file => queue.addToMatchedQueue(file));
      expect(queue.getQueueStats().matched).toBe(10);
      
      const processCb = jest.fn();
      queue.processNextBatch('stability', 5, processCb);
      
      expect(processCb).toHaveBeenCalledTimes(1);
      expect(processCb.mock.calls[0][0].length).toBe(5);
      expect(queue.getQueueStats().matched).toBe(5);
      expect(queue.getQueueStats().stability).toBe(5);
    });
  });
  
  describe('重试机制', () => {
    test('添加文件到重试队列，并在延迟后重新处理', async () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 100 // 使用较短的延迟以加快测试
      };
      
      const queue = new FileProcessingQueue(options);
      const file = createMockFileItem('test.txt');
      
      // 添加到重试队列
      queue.addToRetryQueue(file, 'stability');
      expect(queue.getQueueStats().retrying).toBe(1);
      
      // 等待重试延迟
      await delay(150);
      
      const processCb = jest.fn();
      // 处理重试队列
      queue.processRetryQueue(processCb);
      
      expect(processCb).toHaveBeenCalledWith([file], 'stability');
      expect(queue.getQueueStats().retrying).toBe(0);
    });
    
    test('重试次数超过上限应移至失败队列', async () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 100
      };
      
      const queue = new FileProcessingQueue(options, { maxRetries: 2 });
      const file = createMockFileItem('test.txt');
      
      // 添加到重试队列并设置重试次数
      queue.addToRetryQueue(file, 'stability');
      queue.incrementRetryCount(file.path);
      queue.incrementRetryCount(file.path);
      queue.incrementRetryCount(file.path);
      
      await delay(150);
      
      const processCb = jest.fn();
      queue.processRetryQueue(processCb);
      
      // 检查是否移至失败队列
      expect(processCb).not.toHaveBeenCalled();
      expect(queue.getQueueStats().retrying).toBe(0);
      expect(queue.getQueueStats().failed).toBe(1);
    });
  });
  
  describe('并发控制', () => {
    test('应该遵守最大并发限制', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 3,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      const files = Array(10).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.forEach(file => queue.addToMatchedQueue(file));
      
      // 检查稳定性队列处理
      const stabilityProcessCb = jest.fn();
      queue.processNextBatch('stability', options.maxConcurrentChecks, stabilityProcessCb);
      
      expect(stabilityProcessCb).toHaveBeenCalledTimes(1);
      expect(stabilityProcessCb.mock.calls[0][0].length).toBe(3);
      
      // 模拟文件已经通过稳定性检测和MD5计算，添加到打包队列中
      const packagingFiles = files.slice(0, 5);
      packagingFiles.forEach(file => queue.addToQueue('packaging', file));
      
      // 检查传输队列处理
      const transportProcessCb = jest.fn();
      queue.processNextBatch('transport', options.maxConcurrentTransfers, transportProcessCb);
      
      expect(transportProcessCb).toHaveBeenCalledTimes(1);
      expect(transportProcessCb.mock.calls[0][0].length).toBe(2);
    });
  });
  
  describe('队列状态追踪', () => {
    test('应该准确报告各队列状态', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      
      // 添加文件到不同队列
      const file1 = createMockFileItem('test1.txt');
      const file2 = createMockFileItem('test2.txt');
      const file3 = createMockFileItem('test3.txt');
      const file4 = createMockFileItem('test4.txt');
      
      queue.addToMatchedQueue(file1);
      queue.addToQueue('stability', file2);
      queue.addToQueue('md5', file3);
      queue.addToRetryQueue(file4, 'stability');
      
      const stats = queue.getQueueStats();
      
      expect(stats.matched).toBe(1);
      expect(stats.stability).toBe(1);
      expect(stats.md5).toBe(1);
      expect(stats.retrying).toBe(1);
      expect(stats.total).toBe(4);
    });
    
    test('应该更新处理进度', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      
      const files = Array(5).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.forEach(file => queue.addToMatchedQueue(file));
      
      // 处理第一批
      const processCb = jest.fn();
      queue.processNextBatch('stability', 2, processCb);
      
      // 标记一个文件为完成
      queue.markAsCompleted(files[0].path);
      
      const stats = queue.getQueueStats();
      expect(stats.matched).toBe(3);
      expect(stats.stability).toBe(1); // 一个已移到稳定性队列，一个已完成
      expect(stats.completed).toBe(1);
    });
  });
  
  describe('队列清理和完成检查', () => {
    test('应该清理所有队列', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      
      // 添加文件到不同队列
      const files = Array(10).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.slice(0, 3).forEach(file => queue.addToMatchedQueue(file));
      files.slice(3, 6).forEach(file => queue.addToQueue('stability', file));
      files.slice(6, 9).forEach(file => queue.addToQueue('md5', file));
      queue.addToRetryQueue(files[9], 'stability');
      
      expect(queue.getQueueStats().total).toBe(10);
      
      queue.clear();
      
      expect(queue.getQueueStats().total).toBe(0);
    });
    
    test('应该检测所有队列处理完成', () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 1000
      };
      
      const queue = new FileProcessingQueue(options);
      
      // 添加并处理一些文件
      const files = Array(5).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.forEach(file => queue.addToMatchedQueue(file));
      
      // 初始状态不应完成
      expect(queue.isAllProcessed()).toBe(false);
      
      // 全部标记为完成
      files.forEach(file => queue.markAsCompleted(file.path));
      
      // 现在应该完成
      expect(queue.isAllProcessed()).toBe(true);
    });
    
    test('如果还有重试队列中的文件，应该不是完成状态', async () => {
      const options: QueueOptions = {
        enabled: true,
        maxConcurrentChecks: 2,
        maxConcurrentTransfers: 2,
        stabilityRetryDelay: 100
      };
      
      const queue = new FileProcessingQueue(options);
      
      // 添加一些文件
      const files = Array(3).fill(null).map((_, i) => 
        createMockFileItem(`test${i}.txt`)
      );
      
      files.slice(0, 2).forEach(file => queue.addToMatchedQueue(file));
      queue.addToRetryQueue(files[2], 'stability');
      
      // 标记匹配队列中的文件为完成
      files.slice(0, 2).forEach(file => queue.markAsCompleted(file.path));
      
      // 重试队列非空，不应完成
      expect(queue.isAllProcessed()).toBe(false);
      
      // 等待重试延迟后，将重试队列的文件标记为完成
      await delay(150);
      const processCb = jest.fn((files) => {
        files.forEach(file => queue.markAsCompleted(file.path));
      });
      queue.processRetryQueue(processCb);
      
      // 现在应该完成
      expect(queue.isAllProcessed()).toBe(true);
    });
  });
}); 