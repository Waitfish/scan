/**
 * @file 文件去重模块
 * 基于MD5实现文件去重，包括增量上传（与历史任务比较）和任务内去重
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { FileItem } from '../types';
import {
  DeduplicationType,
  DeduplicationResult,
  DeduplicatorOptions,
  HistoricalUploadsRecord
} from '../types/deduplication';




/**
 * 默认去重器配置
 */
const DEFAULT_OPTIONS: DeduplicatorOptions = {
  enabled: true,
  useHistoricalDeduplication: true,
  useTaskDeduplication: true,
  historyFilePath: path.join(process.cwd(), 'historical-uploads.json'),
  autoSaveInterval: 5 * 60 * 1000 // 5分钟
};

/**
 * 文件去重器类
 * 用于检测和记录重复文件
 */
export class Deduplicator {
  /** 当前任务中已处理的MD5集合 */
  private currentTaskMd5Set: Set<string>;
  
  /** 历史任务中已上传的MD5集合 */
  private historicalMd5Set: Set<string>;
  
  /** 与历史任务重复的文件 */
  private skippedHistoricalDuplicates: FileItem[];
  
  /** 任务内重复的文件 */
  private skippedTaskDuplicates: FileItem[];
  
  /** 配置选项 */
  private options: DeduplicatorOptions;
  
  /** 自动保存计时器 */
  private autoSaveTimer: NodeJS.Timeout | null = null;
  
  /** 上次保存时间 */
  private lastSaveTime: number = 0;
  
  /** 是否已修改（用于判断是否需要保存） */
  private isDirty: boolean = false;

  /**
   * 创建文件去重器实例
   * @param options 配置选项
   */
  constructor(options: Partial<DeduplicatorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.currentTaskMd5Set = new Set<string>();
    this.historicalMd5Set = new Set<string>();
    this.skippedHistoricalDuplicates = [];
    this.skippedTaskDuplicates = [];
    
    // 如果启用了自动保存，设置定时器
    if (this.options.enabled && this.options.autoSaveInterval && this.options.autoSaveInterval > 0) {
      this.startAutoSave();
    }
  }

  /**
   * 初始化去重器，加载历史记录
   */
  public async initialize(): Promise<void> {
    if (!this.options.enabled) {
      console.log(`[去重] 去重功能已禁用`);
      return;
    }

    console.log(`[去重] 初始化去重器，配置选项:`, {
      useHistoricalDeduplication: this.options.useHistoricalDeduplication,
      useTaskDeduplication: this.options.useTaskDeduplication,
      historyFilePath: this.options.historyFilePath
    });

    // 加载历史MD5记录
    if (this.options.useHistoricalDeduplication && this.options.historyFilePath) {
      const success = await this.loadHistoricalMd5();
      if (success) {
        console.log(`[去重] 成功加载历史MD5记录，共 ${this.historicalMd5Set.size} 条记录`);
      } else {
        console.log(`[去重] 无法加载历史MD5记录，将使用空集合`);
      }
    } else {
      console.log(`[去重] 未启用历史去重或未指定历史文件路径`);
    }
  }

  /**
   * 检查文件是否重复
   * @param fileItem 文件项
   * @returns 去重结果
   */
  public checkDuplicate(fileItem: FileItem): DeduplicationResult {
    // 如果未启用去重或文件没有MD5值，则视为非重复
    if (!this.options.enabled || !fileItem.md5) {
      console.log(`[去重] 跳过文件 ${fileItem.path} 的去重检查: ${!this.options.enabled ? '去重已禁用' : 'MD5值不存在'}`);
      return {
        isDuplicate: false,
        type: DeduplicationType.NOT_DUPLICATE,
        fileItem
      };
    }

    const fileMd5 = fileItem.md5;
    console.log(`[去重] 检查文件 ${fileItem.path} 是否重复, MD5: ${fileMd5}`);

    // 检查是否与历史记录重复
    if (this.options.useHistoricalDeduplication && this.historicalMd5Set.has(fileMd5)) {
      // 记录历史重复文件
      this.skippedHistoricalDuplicates.push(fileItem);
      console.log(`[去重] 文件 ${fileItem.path} 与历史记录中的文件重复 (MD5: ${fileMd5})`);
      
      return {
        isDuplicate: true,
        type: DeduplicationType.HISTORICAL_DUPLICATE,
        fileItem
      };
    }

    // 检查是否在当前任务中重复
    if (this.options.useTaskDeduplication && this.currentTaskMd5Set.has(fileMd5)) {
      // 记录任务内重复文件
      this.skippedTaskDuplicates.push(fileItem);
      console.log(`[去重] 文件 ${fileItem.path} 在当前任务中重复 (MD5: ${fileMd5})`);
      
      return {
        isDuplicate: true,
        type: DeduplicationType.TASK_DUPLICATE,
        fileItem
      };
    }

    // 如果不重复，将MD5值添加到当前任务集合中
    this.currentTaskMd5Set.add(fileMd5);
    console.log(`[去重] 文件 ${fileItem.path} 不重复，已添加到当前任务MD5集合 (MD5: ${fileMd5})`);
    
    return {
      isDuplicate: false,
      type: DeduplicationType.NOT_DUPLICATE,
      fileItem
    };
  }

  /**
   * 添加已处理文件到历史记录
   * @param fileItem 文件项
   * @returns 是否添加成功
   */
  public addToHistory(fileItem: FileItem): boolean {
    if (!this.options.enabled || !fileItem.md5) {
      return false;
    }

    const fileMd5 = fileItem.md5;
    
    // 添加到历史记录集合
    if (!this.historicalMd5Set.has(fileMd5)) {
      this.historicalMd5Set.add(fileMd5);
      this.isDirty = true;
      return true;
    }
    
    return false;
  }

  /**
   * 批量添加已处理文件到历史记录
   * @param fileItems 文件项数组
   * @returns 添加的文件数量
   */
  public addBatchToHistory(fileItems: FileItem[]): number {
    if (!this.options.enabled) {
      return 0;
    }

    let addedCount = 0;
    
    for (const fileItem of fileItems) {
      if (fileItem.md5 && this.addToHistory(fileItem)) {
        addedCount++;
      }
    }
    
    return addedCount;
  }

  /**
   * 保存历史MD5记录到文件
   * @returns 是否保存成功
   */
  public async saveHistoricalMd5(): Promise<boolean> {
    if (!this.options.enabled || !this.options.historyFilePath || !this.isDirty) {
      return false;
    }

    try {
      // 确保目录存在
      await fs.ensureDir(path.dirname(this.options.historyFilePath));
      
      // 将Set转换为数组
      const md5Array: HistoricalUploadsRecord = Array.from(this.historicalMd5Set);
      
      // 先写入临时文件，然后重命名，确保原子性写入
      const tempFilePath = `${this.options.historyFilePath}.tmp`;
      await fs.writeJson(tempFilePath, md5Array, { spaces: 2 });
      await fs.rename(tempFilePath, this.options.historyFilePath);
      
      this.lastSaveTime = Date.now();
      // lastSaveTime用于跟踪上次保存时间，用于后续优化自动保存策略
      this.isDirty = false;
      
      return true;
    } catch (error) {
      console.error('保存历史MD5记录失败:', error);
      return false;
    }
  }

  /**
   * 加载历史MD5记录
   * @returns 是否加载成功
   */
  public async loadHistoricalMd5(): Promise<boolean> {
    if (!this.options.enabled || !this.options.historyFilePath) {
      console.log(`[去重] 未启用去重或未指定历史文件路径`);
      return false;
    }

    try {
      // 检查文件是否存在
      console.log(`[去重] 尝试从 ${this.options.historyFilePath} 加载历史MD5记录`);
      if (!await fs.pathExists(this.options.historyFilePath)) {
        // 文件不存在，初始化为空集合
        console.log(`[去重] 历史文件不存在: ${this.options.historyFilePath}`);
        this.historicalMd5Set = new Set<string>();
        return true;
      }
      
      // 读取并解析历史记录文件
      console.log(`[去重] 正在读取历史记录文件: ${this.options.historyFilePath}`);
      const md5Array: HistoricalUploadsRecord = await fs.readJson(this.options.historyFilePath);
      
      // 转换为Set
      if (Array.isArray(md5Array)) {
        this.historicalMd5Set = new Set<string>(md5Array);
        console.log(`[去重] 成功加载历史MD5记录，共 ${this.historicalMd5Set.size} 条记录`);
        
        // 打印几个示例MD5值
        if (this.historicalMd5Set.size > 0) {
          const sampleMd5s = Array.from(this.historicalMd5Set).slice(0, 5);
          console.log(`[去重] 历史MD5记录示例: ${sampleMd5s.join(', ')}${this.historicalMd5Set.size > 5 ? '...' : ''}`);
        }
        
        return true;
      }
      
      throw new Error('历史记录文件格式不正确');
    } catch (error) {
      console.error(`[去重] 加载历史MD5记录失败:`, error);
      // 初始化为空集合
      this.historicalMd5Set = new Set<string>();
      return false;
    }
  }

  /**
   * 清空当前任务的MD5集合
   */
  public resetCurrentTask(): void {
    this.currentTaskMd5Set.clear();
    this.skippedHistoricalDuplicates = [];
    this.skippedTaskDuplicates = [];
  }

  /**
   * 获取当前任务中已处理的MD5集合
   */
  public getCurrentTaskMd5Set(): Set<string> {
    return new Set(this.currentTaskMd5Set);
  }

  /**
   * 获取历史任务中已上传的MD5集合
   */
  public getHistoricalMd5Set(): Set<string> {
    return new Set(this.historicalMd5Set);
  }

  /**
   * 获取与历史任务重复的文件
   */
  public getSkippedHistoricalDuplicates(): FileItem[] {
    return [...this.skippedHistoricalDuplicates];
  }

  /**
   * 获取任务内重复的文件
   */
  public getSkippedTaskDuplicates(): FileItem[] {
    return [...this.skippedTaskDuplicates];
  }

  /**
   * 开始自动保存
   */
  private startAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }
    
    this.autoSaveTimer = setInterval(async () => {
      if (this.isDirty) {
        await this.saveHistoricalMd5();
      }
    }, this.options.autoSaveInterval || DEFAULT_OPTIONS.autoSaveInterval);
  }

  /**
   * 停止自动保存
   */
  public stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * 清理资源，停止自动保存
   */
  public dispose(): void {
    this.stopAutoSave();
  }
  
  /**
   * 获取上次保存时间
   * @returns 上次保存的时间戳
   */
  public getLastSaveTime(): number {
    return this.lastSaveTime;
  }
}

/**
 * 创建去重器实例
 * @param options 配置选项
 * @returns 去重器实例
 */
export function createDeduplicator(options: Partial<DeduplicatorOptions> = {}): Deduplicator {
  return new Deduplicator(options);
} 