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
  
  /** 任务文件映射表 */
  private taskFiles: Map<string, FileItem> = new Map();
  
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
   * 判断文件是否重复，如果重复则给出重复类型
   * @param file 文件项
   * @param checkTask 是否检查任务内重复
   * @param checkHistorical 是否检查历史任务重复
   * @returns 去重结果
   */
  public checkDuplicate(
    file: FileItem,
    checkTask = true,
    checkHistorical = true,
  ): DeduplicationResult {
    // 文件必须要有md5
    if (!file.md5) {
      console.log(`[去重] 文件缺少MD5，无法进行去重检查: ${file.path}`);
      return {
        isDuplicate: false,
        type: DeduplicationType.NOT_DUPLICATE,
        fileItem: file
      };
    }

    const md5 = file.md5;
    console.log(`[去重] 检查文件: ${file.path}，MD5: ${md5.substring(0, 8)}...`);

    // 检查文件是否与历史任务的文件重复
    if (checkHistorical && this.options.useHistoricalDeduplication && this.historicalMd5Set.has(md5)) {
      // 记录文件被判定为历史重复时的详细信息
      console.log(`[去重] 检测到历史重复文件: ${file.path}`);
      console.log(`  - 文件名: ${file.name}`);
      console.log(`  - 大小: ${file.size} 字节`);
      console.log(`  - MD5: ${file.md5}`);
      console.log(`  - 来源: ${file.origin || 'filesystem'}`);
      if (file.origin === 'archive' && file.archivePath) {
        console.log(`  - 归档文件路径: ${file.archivePath}`);
      }
      
      // 将文件添加到历史重复列表
      this.skippedHistoricalDuplicates.push(file);
      console.log(`[去重] 已添加到历史重复列表，当前列表长度: ${this.skippedHistoricalDuplicates.length}`);
      
      return {
        isDuplicate: true,
        type: DeduplicationType.HISTORICAL_DUPLICATE,
        fileItem: file
      };
    }

    // 检查文件是否与当前任务的文件重复
    if (checkTask && this.options.useTaskDeduplication && this.currentTaskMd5Set.has(md5)) {
      // 记录文件被判定为任务重复时的详细信息
      console.log(`[去重] 检测到任务内重复文件: ${file.path}`);
      console.log(`  - 文件名: ${file.name}`);
      console.log(`  - 大小: ${file.size} 字节`);
      console.log(`  - MD5: ${file.md5}`);
      console.log(`  - 来源: ${file.origin || 'filesystem'}`);
      if (file.origin === 'archive' && file.archivePath) {
        console.log(`  - 归档文件路径: ${file.archivePath}`);
      }
      
      // 将文件添加到任务重复列表
      this.skippedTaskDuplicates.push(file);
      console.log(`[去重] 已添加到任务内重复列表，当前列表长度: ${this.skippedTaskDuplicates.length}`);
      
      return {
        isDuplicate: true,
        type: DeduplicationType.TASK_DUPLICATE,
        fileItem: file
      };
    }

    // 文件不重复，添加到任务文件列表和当前任务MD5集合
    console.log(`[去重] 文件不重复，添加到任务文件列表: ${file.path}`);
    this.taskFiles.set(md5, file);
    this.currentTaskMd5Set.add(md5);
    return {
      isDuplicate: false,
      type: DeduplicationType.NOT_DUPLICATE,
      fileItem: file
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
    // 确保返回数组的副本，避免外部修改影响内部状态
    // 清除重复项，确保每个文件只出现一次
    const uniqueFiles = new Map<string, FileItem>();
    
    for (const file of this.skippedHistoricalDuplicates) {
      if (file.path) {
        uniqueFiles.set(file.path, file);
      }
    }
    
    // 返回去重后的文件列表
    return Array.from(uniqueFiles.values());
  }

  /**
   * 获取任务内重复的文件
   */
  public getSkippedTaskDuplicates(): FileItem[] {
    // 确保返回数组的副本，避免外部修改影响内部状态
    // 清除重复项，确保每个文件只出现一次
    const uniqueFiles = new Map<string, FileItem>();
    
    for (const file of this.skippedTaskDuplicates) {
      if (file.path) {
        uniqueFiles.set(file.path, file);
      }
    }
    
    // 返回去重后的文件列表
    return Array.from(uniqueFiles.values());
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