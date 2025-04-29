# 功能需求文档：去重、文件名冲突处理与断点续传

## 1. 统一 MD5 去重 (增量上传与任务内去重)

**目标**: 避免重复处理和上传内容相同的文件，无论是与历史任务相比还是在当前任务内部。

**实现方案**:

1. **历史记录**:
    * 维护一个持久化的 JSON 文件（例如 `historical-uploads.json`），存储一个包含所有**历史任务中已成功上传**文件 MD5 值的列表或 Set (`historicalMd5Set`)。
    * 任务启动时，尝试加载此文件内容到内存中的 `historicalMd5Set`。如果文件不存在或加载失败，则视为空 Set。

2. **当前任务记录**:
    * 在内存中维护一个临时的 Set (`currentTaskMd5Set`)，用于记录**本次任务**中已经遇到并准备处理（未被跳过）的文件 MD5。
    * `currentTaskMd5Set` 在每次任务启动时必须初始化为空 Set。

3. **统一去重检查点**:
    * 安排在文件完成 MD5 计算之后，进入打包队列之前。
    * 对于每个计算出 MD5 (`fileMd5`) 的文件 (`fileItem`)：
        * **检查历史重复**: 判断 `fileMd5` 是否存在于 `historicalMd5Set` 中。
            * 如果 **是**:
                * 将 `fileItem` 标记为"因历史重复而被跳过"。
                * 将其信息（包括原始路径、文件名、MD5）添加到一个专门的结果列表 `skippedHistoricalDuplicates` 中。
                * **停止**对此文件的后续处理（不加入打包队列）。
            * 如果 **否**: 继续下一步检查。
        * **检查任务内重复**: 判断 `fileMd5` 是否存在于 `currentTaskMd5Set` 中。
            * 如果 **是**:
                * 将 `fileItem` 标记为"因本次任务内重复而被跳过"。
                * 将其信息添加到另一个专门的结果列表 `skippedTaskDuplicates` 中。
                * **停止**对此文件的后续处理。
            * 如果 **否**:
                * 将 `fileMd5` 添加到 `currentTaskMd5Set` 中。
                * 允许 `fileItem` 进入后续的处理流程（例如，文件名冲突处理、加入打包队列）。

**结果体现**:

* 最终的 `result.json` 文件需要包含以下数组：
    * `processedFiles`: 只包含那些**既非历史重复也非任务内重复**，并最终进入处理流程的文件信息。
    * `skippedHistoricalDuplicates`: 包含所有因与历史上传记录 MD5 相同而被跳过的文件信息列表。
    * `skippedTaskDuplicates`: 包含所有因在本次任务中 MD5 重复而被跳过的文件信息列表。
* 日志中应记录跳过操作的原因和相关文件信息。
* **(待讨论)** 是否需要在文件成功上传后，更新持久化的 `historical-uploads.json` 文件？如果需要，应在何时、如何安全地更新？

## 2. 处理打包时的文件名冲突

**目标**: 解决因原始文件来自不同子目录，在打包到压缩包内同一层级时可能发生的同名文件覆盖问题。

**实现方案**:

1. **实现位置**: 此逻辑将在 `src/core/packaging.ts` 文件的 `createBatchPackage` 函数内部实现。

2. **数据结构**: 依赖 `src/types/index.ts` 中定义的 `FileItem` 接口，特别是 `path`, `name`, 和 `originalName` 字段。

3. **核心流程 (在 `createBatchPackage` 中)**:
    * 接收待打包的 `FileItem[]` 列表作为输入。
    * **遍历列表**: 对于每个 `fileItem`：
        * **填充 `originalName`**: 使用 `path.basename(fileItem.path)` 无条件填充（或覆盖）`fileItem.originalName` 字段。
        * **初始化 `name`**: 确保 `fileItem.name` 字段有初始值（通常在扫描阶段已设为 `originalName`，若无则在此处设置）。
    * **冲突检测与重命名 (第二次遍历或在第一次遍历中进行)**:
        * 维护一个 `Set<string>` (`usedTargetNames`) 来跟踪在此次打包任务中已分配给 `name` 字段的最终目标文件名。
        * 对于每个 `fileItem`:
            * 获取当前的 `name`。
            * 检查 `currentName` 是否已存在于 `usedTargetNames` 中。
            * **如果冲突**: 
                * 基于 `fileItem.originalName` (使用 `path.parse` 或类似方法提取基础名和扩展名) 生成带数字后缀的新名称，例如 `basename-1.ext`, `basename-2.ext`。
                * 循环生成，直到找到一个在 `usedTargetNames` 中不存在的 `newName`。
                * 将此 `newName` 赋值给 `fileItem.name`。
                * 将 `newName` 添加到 `usedTargetNames`。
                * 将重命名操作记录到 `warnings` 数组中。
            * **如果不冲突**: 将 `currentName` 添加到 `usedTargetNames`。
    * **后续步骤**: 文件复制到临时目录、生成元数据 (`metadata.json`) 以及最终的压缩操作，都将使用**更新后的** `fileItem.name` 作为目标文件名。

**结果体现**:

* 最终生成的压缩包内，所有文件都具有唯一的文件名，冲突的文件已被重命名（如 `file.txt`, `file-1.txt`, `file-2.txt`）。
* `result.json` (或者打包结果对象中的 `warnings` 字段) 会包含文件名重命名的记录。
* 打包生成的 `metadata.json` 文件中，`files` 列表里的 `name` 字段应反映重命名后的最终文件名，同时 `originalName` 字段保留原始文件名。

## 3. 任务中断与恢复 (断点续传)

**目标**: 使整个扫描、处理、上传流程具备在意外中断后，能够从上次的进度点恢复执行的能力，避免完全重头开始。这对处理大量文件时特别有价值，可以显著减少重复工作和总体执行时间。

### 3.1 系统设计

断点续传功能由三个主要部分组成：
1. **状态定义与存储**: 确定需要持久化的状态数据，以及如何在 JSON 文件中表示
2. **状态保存机制**: 在任务执行的不同阶段定期保存状态
3. **状态恢复逻辑**: 在任务启动时检测和恢复之前的状态

#### 3.1.1 状态文件位置与命名

状态文件将存储在配置的 `resultsDir` 目录下，命名格式为：
```
${resultsDir}/scan-state-${taskId}-${scanId}.json
```

这样命名可以保证每个任务有唯一的状态文件，并且在多次运行相同任务ID的情况下，不同的 `scanId` 也能保持状态的隔离。

### 3.2 接口定义

为了支持断点续传，我们需要定义以下接口：

```typescript
// src/types/state.ts (新建文件)

import { FileItem, FailureItem } from './index';
import { TransportResult } from './transport';
import { ScanAndTransportConfig } from './facade-v2';

/**
 * 表示任务的保存状态
 */
export interface TaskState {
  /** 任务标识符 */
  taskId: string;
  
  /** 扫描标识符 */
  scanId: string;
  
  /** 状态版本号，用于未来兼容性 */
  version: string;
  
  /** 任务开始时间 */
  startTime: string;
  
  /** 最后保存时间 */
  lastSavedTime: string;
  
  /** 配置快照（用于校验恢复的任务配置是否匹配） */
  configSnapshot: {
    rootDirs: string[];
    rulesCount: number;
    outputDir: string;
    resultsDir: string;
    deduplicationEnabled: boolean;
    transportEnabled: boolean;
  };
  
  /** 扫描阶段状态 */
  scanState: {
    /** 已处理完成的根目录 */
    completedRootDirs: string[];
    
    /** 已扫描的目录 */
    scannedDirs: string[];
    
    /** 已匹配但尚未进入处理队列的文件 */
    pendingMatchedFiles: FileItem[];
    
    /** 扫描统计信息 */
    stats: {
      scannedFiles: number;
      matchedFiles: number;
      scannedDirs: number;
      skippedDirs: number;
      ignoredLargeFiles: number;
      archivesScanned?: number;
      nestedArchivesScanned?: number;
    };
  };
  
  /** 队列状态 */
  queueState: {
    /** 文件稳定性检查队列 */
    fileStabilityQueue: FileItem[];
    
    /** 压缩包稳定性检查队列 */
    archiveStabilityQueue: FileItem[];
    
    /** MD5计算队列 */
    md5Queue: FileItem[];
    
    /** 打包队列 */
    packagingQueue: FileItem[];
    
    /** 传输队列 */
    transportQueue: FileItem[];
    
    /** 重试队列 */
    retryQueue: Record<string, {
      filePath: string;
      targetQueue: string;
      retryCount: number;
      nextRetryTime?: string;
    }>;
    
    /** 各队列正在处理中的文件 */
    processingFiles: {
      fileStability: string[];
      archiveStability: string[];
      md5: string[];
      packaging: string[];
      transport: string[];
    };
    
    /** 压缩包追踪器状态 */
    archiveTracker: {
      /** 压缩包 -> 包含的文件路径映射 */
      archiveToFiles: Record<string, string[]>;
      
      /** 压缩包 -> 队列状态映射 */
      isQueued: Record<string, boolean>;
      
      /** 压缩包 -> 处理状态映射 */
      status: Record<string, 'waiting' | 'processing' | 'stable' | 'unstable' | 'failed'>;
    };
  };
  
  /** 去重状态 */
  deduplicatorState?: {
    /** 当前任务已处理文件的MD5集合 */
    currentTaskMd5Set: string[];
    
    /** 因历史重复而跳过的文件 */
    skippedHistoricalDuplicates: FileItem[];
    
    /** 因任务内重复而跳过的文件 */
    skippedTaskDuplicates: FileItem[];
  };
  
  /** 处理结果状态 */
  resultState: {
    /** 已处理完成的文件 */
    processedFiles: FileItem[];
    
    /** 已创建的包文件路径 */
    packagePaths: string[];
    
    /** 传输结果摘要 */
    transportSummary: TransportResult[];
    
    /** 失败项列表 */
    failedItems: FailureItem[];
    
    /** 处理阶段的耗时统计 */
    stageTimings?: Record<string, number>;
  };
}

/**
 * 状态管理器接口
 */
export interface StateManager {
  /**
   * 保存当前任务状态
   * @param state 要保存的状态对象
   * @returns 保存是否成功
   */
  saveState(state: TaskState): Promise<boolean>;
  
  /**
   * 加载指定任务的状态
   * @param taskId 任务ID
   * @param scanId 扫描ID
   * @returns 加载的状态对象，如果不存在则返回null
   */
  loadState(taskId: string, scanId?: string): Promise<TaskState | null>;
  
  /**
   * 清除指定任务的状态
   * @param taskId 任务ID
   * @param scanId 扫描ID
   * @returns 清除是否成功
   */
  clearState(taskId: string, scanId?: string): Promise<boolean>;
  
  /**
   * 检查状态是否与当前配置兼容
   * @param state 加载的状态
   * @param config 当前配置
   * @returns 是否兼容
   */
  isStateCompatible(state: TaskState, config: ScanAndTransportConfig): boolean;
}
```

### 3.3 实现方案详细说明

#### 3.3.1 状态管理器实现

```typescript
// src/core/state-manager.ts (新建文件)

import * as fs from 'fs-extra';
import * as path from 'path';
import { TaskState, StateManager } from '../types/state';
import { ScanAndTransportConfig } from '../types/facade-v2';

/**
 * 状态管理器实现
 */
export class StateManagerImpl implements StateManager {
  // 状态文件所在目录
  private stateDir: string;
  
  // 状态文件版本号
  private readonly STATE_VERSION = '1.0.0';
  
  /**
   * 构造函数
   * @param stateDir 状态文件存储目录
   */
  constructor(stateDir: string) {
    this.stateDir = stateDir;
    // 确保状态目录存在
    fs.ensureDirSync(this.stateDir);
  }
  
  /**
   * 获取状态文件路径
   * @param taskId 任务ID
   * @param scanId 扫描ID
   */
  private getStateFilePath(taskId: string, scanId: string): string {
    return path.join(this.stateDir, `scan-state-${taskId}-${scanId}.json`);
  }
  
  /**
   * 保存任务状态
   * @param state 任务状态
   */
  public async saveState(state: TaskState): Promise<boolean> {
    try {
      const stateFilePath = this.getStateFilePath(state.taskId, state.scanId);
      const tempFilePath = `${stateFilePath}.tmp`;
      
      // 更新时间戳
      state.lastSavedTime = new Date().toISOString();
      state.version = this.STATE_VERSION;
      
      // 先写入临时文件，然后重命名，确保原子性
      await fs.writeJson(tempFilePath, state, { spaces: 2 });
      await fs.rename(tempFilePath, stateFilePath);
      
      return true;
    } catch (error) {
      console.error('保存状态失败:', error);
      return false;
    }
  }
  
  /**
   * 加载任务状态
   * @param taskId 任务ID
   * @param scanId 扫描ID，如果不提供则加载最新的状态
   */
  public async loadState(taskId: string, scanId?: string): Promise<TaskState | null> {
    try {
      if (scanId) {
        // 如果提供了scanId，尝试加载指定的状态文件
        const stateFilePath = this.getStateFilePath(taskId, scanId);
        if (await fs.pathExists(stateFilePath)) {
          return await fs.readJson(stateFilePath) as TaskState;
        }
        return null;
      }
      
      // 如果没有提供scanId，查找所有匹配taskId的状态文件，并加载最新的一个
      const files = await fs.readdir(this.stateDir);
      const stateFiles = files.filter(f => 
        f.startsWith(`scan-state-${taskId}-`) && f.endsWith('.json')
      );
      
      if (stateFiles.length === 0) {
        return null;
      }
      
      // 按文件修改时间排序，获取最新的状态文件
      const statPromises = stateFiles.map(async file => {
        const filePath = path.join(this.stateDir, file);
        const stats = await fs.stat(filePath);
        return { file, stats };
      });
      
      const fileStats = await Promise.all(statPromises);
      fileStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
      
      const latestFile = fileStats[0].file;
      return await fs.readJson(path.join(this.stateDir, latestFile)) as TaskState;
    } catch (error) {
      console.error('加载状态失败:', error);
      return null;
    }
  }
  
  /**
   * 清除任务状态
   * @param taskId 任务ID
   * @param scanId 扫描ID，如果不提供则清除所有与taskId相关的状态
   */
  public async clearState(taskId: string, scanId?: string): Promise<boolean> {
    try {
      if (scanId) {
        // 清除特定的状态文件
        const stateFilePath = this.getStateFilePath(taskId, scanId);
        if (await fs.pathExists(stateFilePath)) {
          await fs.remove(stateFilePath);
        }
        return true;
      }
      
      // 清除所有与taskId相关的状态文件
      const files = await fs.readdir(this.stateDir);
      const stateFiles = files.filter(f => 
        f.startsWith(`scan-state-${taskId}-`) && f.endsWith('.json')
      );
      
      for (const file of stateFiles) {
        await fs.remove(path.join(this.stateDir, file));
      }
      
      return true;
    } catch (error) {
      console.error('清除状态失败:', error);
      return false;
    }
  }
  
  /**
   * 检查状态是否与当前配置兼容
   * @param state 加载的状态
   * @param config 当前配置
   */
  public isStateCompatible(state: TaskState, config: ScanAndTransportConfig): boolean {
    // 检查基本配置是否匹配
    const snapshot = state.configSnapshot;
    
    // 任务ID必须匹配
    if (state.taskId !== config.taskId) {
      return false;
    }
    
    // 检查根目录是否匹配（顺序可能不同，但内容应该相同）
    const rootDirsMatch = 
      snapshot.rootDirs.length === config.rootDirs.length &&
      snapshot.rootDirs.every(dir => config.rootDirs.includes(dir));
    
    if (!rootDirsMatch) {
      return false;
    }
    
    // 检查规则数量是否匹配
    if (snapshot.rulesCount !== config.rules.length) {
      return false;
    }
    
    // 检查输出目录和结果目录是否匹配
    if (
      snapshot.outputDir !== config.outputDir ||
      snapshot.resultsDir !== config.resultsDir
    ) {
      return false;
    }
    
    // 检查去重和传输配置是否匹配
    const deduplicationEnabled = !!config.deduplicatorOptions?.enabled;
    const transportEnabled = !!config.transport.enabled;
    
    if (
      snapshot.deduplicationEnabled !== deduplicationEnabled ||
      snapshot.transportEnabled !== transportEnabled
    ) {
      return false;
    }
    
    return true;
  }
}
```

#### 3.3.2 状态生成与应用

在 `scanAndTransport` 函数中，我们需要在关键位置添加状态保存和恢复逻辑：

1. **任务开始时的状态恢复**:
   - 在初始化完成后，检查是否存在状态文件
   - 如果存在并且与当前配置兼容，加载状态，恢复各个队列和进度数据

2. **关键节点的状态保存**:
   - 在完成扫描、MD5计算、打包和传输等关键阶段后保存状态
   - 在长时间运行的队列处理中间定期保存状态
   - 在任务完成或失败时保存最终状态

3. **任务成功完成时的状态清理**:
   - 如果任务成功完成，清除状态文件

#### 3.3.3 队列状态和处理进度的恢复

以下是 `scanAndTransport` 函数中恢复状态的伪代码：

```typescript
// 初始化状态管理器
const stateManager = new StateManagerImpl(config.resultsDir);

// 尝试加载状态
const savedState = await stateManager.loadState(config.taskId, scanId);
let isResuming = false;

if (savedState && stateManager.isStateCompatible(savedState, config)) {
  isResuming = true;
  
  // 恢复扫描状态
  const completedRootDirs = new Set(savedState.scanState.completedRootDirs);
  
  // 跳过已处理的根目录
  const remainingRootDirs = config.rootDirs.filter(dir => !completedRootDirs.has(dir));
  
  // 恢复队列状态
  const queueState = savedState.queueState;
  
  // 恢复各个队列中的文件
  queueState.fileStabilityQueue.forEach(file => queue.addToQueue('fileStability', file));
  queueState.archiveStabilityQueue.forEach(file => queue.addToQueue('archiveStability', file));
  queueState.md5Queue.forEach(file => queue.addToQueue('md5', file));
  queueState.packagingQueue.forEach(file => queue.addToQueue('packaging', file));
  queueState.transportQueue.forEach(file => queue.addToQueue('transport', file));
  
  // 恢复压缩包追踪器状态
  for (const [archivePath, filesPaths] of Object.entries(queueState.archiveTracker.archiveToFiles)) {
    const files = savedState.resultState.processedFiles.filter(f => filesPaths.includes(f.path));
    files.forEach(file => queue.trackArchiveFile(file));
  }
  
  // 恢复去重状态
  if (savedState.deduplicatorState && deduplicator) {
    savedState.deduplicatorState.currentTaskMd5Set.forEach(md5 => 
      deduplicator.addToCurrentTaskSet(md5)
    );
    
    savedState.deduplicatorState.skippedHistoricalDuplicates.forEach(file => 
      skippedHistoricalDuplicates.push(file)
    );
    
    savedState.deduplicatorState.skippedTaskDuplicates.forEach(file => 
      skippedTaskDuplicates.push(file)
    );
  }
  
  // 恢复结果状态
  savedState.resultState.processedFiles.forEach(file => processedFiles.push(file));
  savedState.resultState.packagePaths.forEach(p => packagePaths.push(p));
  savedState.resultState.transportSummary.forEach(s => transportResults.push(s));
  savedState.resultState.failedItems.forEach(i => failedItems.push(i));
  
  // 记录日志
  await logToFile(logFilePath, `从中断点恢复任务，上次保存时间: ${savedState.lastSavedTime}`);
  await logToFile(logFilePath, `恢复了 ${processedFiles.length} 个已处理文件, ${packagePaths.length} 个包, ${transportResults.length} 个传输结果`);
  
  // 如果所有根目录都已处理完，直接从队列处理开始
  if (remainingRootDirs.length === 0) {
    // 跳过扫描阶段
    await logToFile(logFilePath, `所有根目录已扫描完成，跳过扫描阶段`);
  } else {
    // 只扫描剩余的根目录
    await logToFile(logFilePath, `恢复扫描，处理剩余的 ${remainingRootDirs.length} 个根目录`);
    config.rootDirs = remainingRootDirs;
  }
}
```

### 3.4 状态保存时机

为了确保断点续传功能有效工作，我们需要在以下关键节点保存状态：

1. **扫描阶段**:
   - 每当一个根目录扫描完成时保存状态
   - 在所有根目录扫描完成后保存状态

2. **队列处理阶段**:
   - 每隔一定时间（如30秒）或处理一定数量的文件（如50个）后保存一次状态
   - 在各个处理队列（如稳定性检查、MD5计算、打包、传输）完成重要批次处理后保存状态

3. **任务结束时**:
   - 在任务成功完成时保存最终状态，然后清除状态文件
   - 在任务遇到致命错误时保存当前状态
   - 在进程收到终止信号（如Ctrl+C）时尝试保存状态

### 3.5 性能和空间考量

由于状态文件可能包含大量文件信息，需要考虑以下优化措施：

1. **状态文件大小控制**:
   - 只存储必要的文件元数据，避免冗余信息
   - 对于大型任务，考虑分割状态文件或使用压缩存储

2. **性能优化**:
   - 状态保存应在后台进行，不阻塞主处理流程
   - 考虑增量更新状态文件，而不是每次都完全重写

3. **错误处理**:
   - 状态保存失败不应中断主任务
   - 提供日志警告，但允许任务继续执行

### 3.6 测试方案

为了确保断点续传功能的可靠性，需要设计以下测试场景：

1. **正常中断恢复测试**:
   - 在不同处理阶段手动中断任务
   - 确认重启后能正确恢复到中断点，不重复已处理的文件

2. **不兼容配置测试**:
   - 修改配置后重启任务，验证是否能正确拒绝加载不兼容的状态

3. **状态文件损坏测试**:
   - 故意损坏状态文件，确认程序能正确处理并回退到全新开始

4. **长时间运行测试**:
   - 模拟大量文件处理，验证长时间运行时状态保存和恢复的有效性

5. **增量恢复测试**:
   - 验证状态恢复后，只处理剩余的根目录和文件

**结果体现**:

* 用户在程序意外中断后，重新运行相同的命令时，无需重复扫描和处理已完成的文件。
* 程序日志应清晰记录恢复进度，显示哪些部分是从上次中断恢复的。
* 即使在处理大量文件时，也能显著减少由于中断导致的重复工作。

## 4. 历史上传记录的维护 (与需求 1 关联)

**(此部分细化需求 1 中提到的 `historical-uploads.json`)**

**目标**: 持久化记录已成功上传文件的 MD5，用于未来任务的增量判断。

**实现方案**:

1. **更新时机**:
    * **推荐**: 在一个**包 (archive)** 被确认**成功上传**到最终目的地后。
    * 获取该包内所有文件的 MD5 值列表。
    * 将这些 MD5 值追加或合并到持久化的 `historical-uploads.json` 文件中。

2. **数据结构**:
    * `historical-uploads.json` 最简单可以是一个 JSON 数组，存储所有成功上传过的文件 MD5 字符串。
    * `["md5_1", "md5_2", "md5_3", ...]`
    * 为提高加载和查找效率，加载到内存后应转换为 Set (`historicalMd5Set`)。

3. **并发与一致性**:
    * 如果可能同时运行多个实例处理同一目标（虽然不推荐），或者在更新过程中程序中断，需要考虑文件写入的原子性和并发控制。
    * **简单策略**: 使用文件锁，或者"读取-修改-写入临时文件-重命名"模式来保证更新的原子性。在任务开始时读取一次，在任务结束或包成功上传后更新一次。
    * **注意**: 如果上传失败，不应将对应包内文件的 MD5 加入历史记录。

**结果体现**:

* `historical-uploads.json` 文件会随着成功上传的文件不断增长（或保持稳定，如果上传的文件都是重复的）。
* 后续任务能够利用此文件实现增量上传，跳过内容上已经存在于服务器的文件。

