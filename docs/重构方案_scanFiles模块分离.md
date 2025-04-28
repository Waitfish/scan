# scanFiles与scanAndTransport功能分离重构方案

## 背景

目前`scanFiles`函数职责过重，既包含文件扫描又包含稳定性检测、MD5计算、打包和传输等功能，造成以下问题：

1. 函数过于庞大（1100多行代码），难以维护和测试
2. 职责不单一，违反单一职责原则
3. 功能耦合度高，难以独立测试和复用
4. 代码结构复杂，难以理解和扩展

## 重构目标

1. `scanFiles`函数专注于文件扫描和匹配，返回匹配文件列表
2. `scanAndTransport`函数负责调度文件处理流程（稳定性检测、MD5计算、打包、传输）
3. 使用队列系统管理文件处理流程，支持并行处理
4. 改进压缩包处理逻辑，提高效率
5. 添加任务ID和扫描ID，支持结果持久化
6. 支持开始时间和结束时间统计

## 数据结构变化

### ScanOptions 接口

```typescript
// 更新前
export interface ScanOptions {
  rootDir: string;
  matchRules: MatchRule[];
  depth: number;
  onProgress?: (progress: ScanProgress, matchedFile?: FileItem) => void;
  maxFileSize?: number;
  skipDirs?: string[];
  scanNestedArchives?: boolean;
  maxNestedLevel?: number;
  stabilityCheck?: StabilityCheckOptions;
  queue?: QueueOptions;
  transport?: TransportOptions;
  calculateMd5?: boolean;
  createPackage?: boolean;
  packageNamePattern?: string;
  outputDir?: string;
  packagingTrigger?: PackagingTriggerOptions;
}

// 更新后
export interface ScanOptions {
  /** 扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则列表 */
  matchRules: MatchRule[];
  /** 扫描深度，-1表示扫描到没有下级目录为止 */
  depth?: number;
  /** 最大文件大小（字节），超过此大小的文件将被忽略，默认 500MB */
  maxFileSize?: number;
  /** 要跳过的目录名列表（相对于扫描目录的路径） */
  skipDirs?: string[];
  /** 是否扫描嵌套压缩文件，默认为true */
  scanNestedArchives?: boolean;
  /** 最大嵌套层级，默认为5 */
  maxNestedLevel?: number;
  /** 任务唯一标识符 */
  taskId?: string;
  /** 基本进度回调函数 */
  onProgress?: (progress: ScanProgress) => void;
  /** 文件匹配回调函数 - 用于队列处理 */
  onFileMatched?: (file: FileItem, progress: ScanProgress) => void;
  /** 失败信息回调函数 - 用于队列处理 */
  onFailure?: (failure: FailureItem, progress: ScanProgress) => void;
}
```

### ScanResult 接口

```typescript
// 更新前
export interface ScanResult {
  /** 成功匹配的文件列表 */
  results: FileItem[];
  /** 扫描过程中发生的失败列表 */
  failures: FailureItem[];
  /** 处理的文件数据（添加MD5后） */
  processedFiles?: FileItem[];
  /** 创建的包文件列表 */
  packages?: string[];
  /** 传输结果 */
  transportResults?: {
    success: boolean;
    filePath: string;
    remotePath: string;
    error?: string;
  }[];
}

// 更新后
export interface ScanResult {
  /** 成功匹配的文件列表 */
  matchedFiles: FileItem[];
  /** 扫描过程中发生的失败列表 */
  failures: FailureItem[];
  /** 扫描统计信息 */
  stats: {
    totalScanned: number;
    totalMatched: number;
    totalFailures: number;
    archivesScanned: number;
    nestedArchivesScanned: number;
  };
  /** 任务唯一标识符 */
  taskId?: string;
  /** 扫描唯一标识符 */
  scanId: string;
  /** 扫描开始时间 */
  startTime: Date;
  /** 扫描结束时间 */
  endTime: Date;
  /** 扫描耗时（毫秒） */
  elapsedTimeMs: number;
}
```

### 新增接口 - QueueConfig

```typescript
/** 定义文件处理队列配置 */
export interface QueueConfig {
  /** 是否启用队列处理 (默认: true) */
  enabled?: boolean;
  /** 最大并发稳定性检测数量 (默认: 5) */
  maxConcurrentChecks?: number;
  /** 最大并发MD5计算数量 (默认: 5) */
  maxConcurrentMd5?: number;
  /** 最大并发传输数量 (默认: 2) */
  maxConcurrentTransfers?: number;
  /** 稳定性检测重试延迟（毫秒）(默认: 2000) */
  stabilityRetryDelay?: number;
  /** 最大稳定性检测重试次数 (默认: 3) */
  maxStabilityRetries?: number;
}
```

### 新增接口 - StabilityConfig

```typescript
/** 定义稳定性检测配置 */
export interface StabilityConfig {
  /** 是否启用稳定性检测 (默认: true) */
  enabled?: boolean;
  /** 检测间隔（毫秒）(默认: 500) */
  checkInterval?: number;
  /** 大文件阈值（字节）(默认: 100MB) */
  largeFileThreshold?: number;
  /** 是否对大文件跳过读取检测 (默认: true) */
  skipReadForLargeFiles?: boolean;
}
```

### 更新 ScanAndTransportConfig 接口

```typescript
export interface ScanAndTransportConfig {
  // --- 必需参数 ---
  /** 要扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则 */
  rules: MatchRule[];
  /** 传输目标服务器基本信息 */
  transport: ScanAndTransportTransportConfig;
  /** 任务唯一标识符 */
  taskId: string;

  // --- 可选参数 ---
  /** 本地临时存储打包文件的目录 (默认: './temp/packages') */
  outputDir?: string;
  /** 打包文件的命名模式 (默认: 'package_{date}_{index}') */
  packageNamePattern?: string;
  /** 进度回调函数，提供详细进度 */
  onProgress?: (progress: ScanProgress, matchedFile?: FileItem) => void;
  /** 最大扫描文件大小，单位字节 (默认: 500 * 1024 * 1024) */
  maxFileSize?: number;
  /** 需要跳过的目录列表 (默认: []) */
  skipDirs?: string[];
  /** 扫描深度, -1表示无限深度 (默认: -1) */
  depth?: number;
  /** 是否扫描嵌套压缩包 (默认: true) */
  scanNestedArchives?: boolean;
  /** 最大嵌套扫描层数 (默认: 5) */
  maxNestedLevel?: number;
  /** 打包触发条件 (默认: { maxFiles: 500, maxSizeMB: 2048 }) */
  packagingTrigger?: PackagingTriggerOptions;
  /** 日志文件路径 (默认: './scan_transport_log_{时间戳}.log') */
  logFilePath?: string;
  /** 队列处理配置 */
  queue?: QueueConfig;
  /** 稳定性检测配置 */
  stability?: StabilityConfig;
  /** 是否计算MD5 (默认: true) */
  calculateMd5?: boolean;
  /** 结果文件存储目录 (默认: './results') */
  resultsDir?: string;
}
```

### 更新 ScanAndTransportResult 接口

```typescript
/** 定义 scanAndTransport 返回结果接口 */
export interface ScanAndTransportResult {
  /** 整个过程是否基本成功 (即使有部分文件失败) */
  success: boolean;
  /** 成功处理并打包的文件列表 (包含MD5等元数据，用于下次跳过) */
  processedFiles: FileItem[];
  /** 整个流程中所有失败的条目列表 (包含路径和错误，用于重试) */
  failedItems: FailureItem[];
  /** 本地生成的包文件路径列表 */
  packagePaths: string[];
  /** 每个包的传输结果摘要 */
  transportSummary: {
    success: boolean;
    filePath: string;
    remotePath: string;
    error?: string;
  }[];
  /** 实际使用的日志文件路径 */
  logFilePath: string;
  /** 任务唯一标识符 */
  taskId: string;
  /** 扫描唯一标识符 */
  scanId: string;
  /** 结果文件路径 */
  resultFilePath: string;
  /** 开始时间 */
  startTime: Date;
  /** 结束时间 */
  endTime: Date;
  /** 总耗时（毫秒） */
  elapsedTimeMs: number;
}
```

## 流程图

### 改造后的scanAndTransport数据流向图

```mermaid
%%{init: {'theme': 'default', 'themeVariables': { 'fontSize': '14px'}, 'flowchart': {'useMaxWidth': true, 'htmlLabels': true, 'curve': 'linear'} } }%%
flowchart TD
    start[scanAndTransport函数] --> config[配置合并与初始化]
    config --> queue[创建FileProcessingQueue]
    config --> log[日志记录初始化]
    
    queue --> scan[scanFiles函数]
    
    subgraph 扫描模块
        scan --> fsScan[文件系统扫描]
        scan --> archiveScan[压缩包扫描]
        scan --> nestedScan[嵌套压缩包扫描]
        
        fsScan --> fileMatch[文件匹配]
        archiveScan --> fileMatch
        nestedScan --> fileMatch
        
        fileMatch -- 通过回调onFileMatched --> matchedFiles[(匹配文件)]
        fileMatch -- 通过回调onFailure --> scanFailures[(扫描失败)]
    end
    
    matchedFiles --> sourceCheck{检查文件来源}
    
    sourceCheck -- 普通文件 --> normalFileQ[普通文件队列]
    sourceCheck -- 压缩包内文件 --> archiveFileCheck{检查压缩包是否已入队}
    
    archiveFileCheck -- 是 --> skipStability[跳过重复检测]
    archiveFileCheck -- 否 --> archiveQ[压缩包稳定性队列]
    
    subgraph queueSystem[文件处理队列系统]
        direction TB
        normalFileQ --> normalStabilityCheck{普通文件稳定性检测}
        
        normalStabilityCheck -- 稳定文件 --> md5Q[MD5计算队列]
        normalStabilityCheck -- 不稳定文件 --> retryCheck1{已达最大重试次数?}
        
        retryCheck1 -- 是 --> stabilityFailures[(稳定性检测失败)]
        retryCheck1 -- 否 --> normalRetry[延时后重新检测]
        
        normalRetry --> normalStabilityCheck
        
        archiveQ --> archiveStabilityCheck{压缩包稳定性检测}
        
        archiveStabilityCheck -- 稳定压缩包 --> extractArchive[解压缩包]
        archiveStabilityCheck -- 不稳定压缩包 --> retryCheck2{已达最大重试次数?}
        
        retryCheck2 -- 是 --> archiveFailures[(压缩包稳定性失败)]
        retryCheck2 -- 否 --> archiveRetry[延时后重新检测]
        
        archiveRetry --> archiveStabilityCheck
        
        extractArchive -- 解压成功 --> addExtractedFiles[将解压文件加入MD5队列]
        extractArchive -- 解压失败 --> extractFailures[(解压失败)]
        
        addExtractedFiles --> md5Q
        
        md5Q --> md5Module[MD5计算模块]
        md5Module -- 文件+MD5 --> packageQ[打包队列]
        md5Module -- 计算失败 --> md5Failures[(MD5计算失败)]
        
        packageQ --> packageModule[打包模块]
        packageModule -- 创建的包 --> transportQ[传输队列]
        packageModule -- 打包失败 --> packageFailures[(打包失败)]
        
        transportQ --> transportModule[传输模块]
        transportModule -- 传输结果 --> transportResults[(传输结果)]
        transportModule -- 传输失败 --> transportFailures[(传输失败)]
    end
    
    skipStability --> trackArchiveFiles[记录关联压缩包]
    
    scanFailures --> resultCollect[结果收集与合并]
    stabilityFailures --> resultCollect
    archiveFailures --> resultCollect
    extractFailures --> resultCollect
    md5Failures --> resultCollect
    packageFailures --> resultCollect
    transportFailures --> resultCollect
    transportResults --> resultCollect
    
    resultCollect --> saveResults[保存结果文件]
    saveResults --> finalResult[返回ScanAndTransportResult]
```

## 模块划分

### 1. 核心模块

- **scanner.ts** - 文件扫描功能
- **stability.ts** - 文件稳定性检测
- **md5.ts** - MD5计算
- **packaging.ts** - 文件打包
- **transport.ts** - 文件传输
- **queue.ts** - 文件处理队列

### 2. 外观模块

- **facade.ts** - 集成上述功能的高级API

## 改造实施计划

### 阶段1: 准备工作 (2天)

1. 备份当前代码
2. 更新类型定义
   - 修改 `ScanOptions` 和 `ScanResult` 接口
   - 添加 `QueueConfig` 和 `StabilityConfig` 接口
   - 更新 `ScanAndTransportConfig` 和 `ScanAndTransportResult` 接口
3. 确保每个独立模块都有足够的单元测试覆盖

### 阶段2: scanFiles函数简化 (3天)

1. 移除 `scanFiles` 中的稳定性检测代码
2. 移除 MD5计算代码
3. 移除打包功能代码
4. 移除传输功能代码
5. 移除队列处理代码
6. 添加新的回调接口支持
7. 添加时间记录功能
8. 修改返回值结构

### 阶段3: 队列系统实现 (2天)

1. 强化 `FileProcessingQueue` 类
2. 添加文件来源检测逻辑
3. 实现压缩包特殊处理逻辑
4. 添加重试次数限制机制
5. 完成队列之间的流转逻辑

### 阶段4: scanAndTransport重构 (3天)

1. 实现基于队列的文件处理流程
2. 添加任务ID和扫描ID支持
3. 实现结果文件保存功能
4. 添加开始时间和结束时间记录
5. 实现完整的错误处理和恢复机制

### 阶段5: 测试与优化 (2天)

1. 编写集成测试确保功能完整性
2. 性能测试和优化
3. 边界情况测试
4. 文档更新

### 阶段6: 部署与监控 (1天)

1. 灰度发布
2. 监控关键指标
3. 收集用户反馈

## 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|------|-------|------|------|
| 重构引入新bug | 中 | 高 | 完善测试用例，保持现有功能完整性 |
| 性能下降 | 低 | 中 | 性能测试和针对性优化 |
| 修改导致API不兼容 | 中 | 高 | 保持公共API一致，提供兼容层 |
| 队列处理复杂度高 | 高 | 中 | 清晰的错误处理，完善的日志 |

## 预期收益

1. 代码组织更清晰，职责单一，更易维护
2. 支持并行处理提高效率
3. 减少内存占用峰值
4. 更好的错误处理和恢复能力
5. 完整的进度追踪和任务管理
6. 更灵活的配置选项

## 结论

通过将`scanFiles`功能分离，我们可以显著提高代码质量和系统性能。重构后的代码结构将更符合单一职责原则，更易于维护和扩展。使用队列系统管理文件处理流程，可以更高效地利用系统资源，提供更好的用户体验。 



好的，我们来分析一下这两种设计模式在哪些情况下性能差异会比较明显：

**当前模式（阶段性串行，内部并发）的特点与瓶颈：**

*   **特点:** 整个流程被划分为几个大的阶段（稳定性、MD5、打包、传输）。必须等待一个阶段的所有（或一批）文件处理完成后，才能开始下一个阶段。但在每个阶段内部，可以并发处理多个文件。
*   **瓶颈:** 整个流程的“木桶效应”非常明显。**吞吐量受限于最慢的那个阶段**。如果某个阶段特别耗时（比如网络传输慢，或者有大量大文件需要计算 MD5），那么即使其他阶段的处理能力很强且处于空闲状态，也必须等待这个慢阶段完成，导致资源浪费和整体处理时间的延长。

**流水线模式的特点与优势：**

*   **特点:** 文件一旦完成一个阶段的处理，就立刻进入下一个阶段的队列，**无需等待同阶段的其他文件**。不同阶段的处理可以真正地并行发生。就像工厂流水线一样，各个工位（阶段）可以同时工作。
*   **优势:**
    *   **减少等待时间:** 文件不需要等待同批次或同阶段的其他文件，处理完就流转，减少了阶段间的等待。
    *   **提高资源利用率:** 当一个阶段（如 CPU 密集型的 MD5）在忙碌时，另一个阶段（如 I/O 密集型的传输）也可以同时进行，充分利用系统资源。
    *   **平滑处理速度波动:** 对于处理时间差异很大的文件（有些快有些慢），快的文件不会被慢的文件阻塞在某个阶段的末尾，可以更快地完成整个流程。

**性能差异显著的场景：**

1.  **各阶段处理速度极不均衡:**
    *   **场景:** 比如，文件稳定性检查非常快（几毫秒），MD5 计算对于大文件可能很慢（几秒甚至几十秒），而打包和传输速度居中。
    *   **当前模式:** 所有文件迅速完成稳定性检查，然后堆积在 MD5 阶段。即使打包和传输的 worker 空闲，也必须等待所有文件的 MD5 计算完成。MD5 成为绝对瓶颈，后续阶段的能力被闲置。
    *   **流水线模式:** 文件完成稳定性检查后立刻进入 MD5 队列。MD5 worker 开始计算。一旦某个文件计算完 MD5，它立刻进入打包队列，打包 worker 可以立即开始工作。这样，MD5、打包、传输可以同时进行（尽管整体速度仍受限于最慢的 MD5），但打包和传输的能力得到了利用。**性能差异会非常大。**

2.  **处理大量文件（尤其是小文件）:**
    *   **场景:** 需要处理成千上万个小文件。单个文件的处理时间可能很短，但总体数量庞大。
    *   **当前模式:** 每个阶段都需要等待所有文件完成。虽然阶段内并发，但阶段切换点形成了阻塞。
    *   **流水线模式:** 文件可以像水流一样快速通过各个阶段，减少了阶段切换的等待开销，整体效率更高。**性能差异会比较明显。**

3.  **I/O 密集型与 CPU 密集型阶段混合:**
    *   **场景:** 稳定性检查（读磁盘）、传输（网络 I/O）是 I/O 密集型；MD5 计算、打包（压缩）是 CPU 密集型。
    *   **当前模式:** 在执行 CPU 密集阶段时，磁盘和网络可能空闲；反之亦然。
    *   **流水线模式:** CPU 密集任务和 I/O 密集任务可以在不同阶段并行执行，更好地利用系统资源（CPU、磁盘、网络）。**性能差异会比较明显。**

4.  **长尾效应明显:**
    *   **场景:** 文件列表中，大部分文件处理很快，但有少数几个特别大或特别难处理的文件，导致某个阶段的处理时间被这几个文件显著拉长。
    *   **当前模式:** 整个阶段必须等待那几个“慢”文件完成，才能进入下一阶段，拖慢了整体进度。
    *   **流水线模式:** 大部分处理快的文件可以迅速流转到后续阶段并完成，只有少数慢文件会卡在某个阶段，整体平均处理时间和资源利用率更优。**性能差异会比较明显。**

**总结:**

当**各阶段处理耗时不均衡、需要处理大量文件、混合了不同资源类型的任务、或者存在处理时间差异大的文件**时，流水线模式通常会比当前阶段性串行的模式表现出显著的性能优势。因为它能更好地利用并发能力，减少等待时间，提高系统资源的整体利用率。

如果你的应用场景符合以上特征，特别是阶段耗时不均衡问题突出，那么重构为流水线模式是值得考虑的性能优化方向。
