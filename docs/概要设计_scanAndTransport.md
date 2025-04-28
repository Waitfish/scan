# `scanAndTransport` 函数概要设计

## 1. 引言与目标

为了简化常用文件处理流程，降低用户使用门槛，我们设计了一个新的高级封装函数 `scanAndTransport`。该函数旨在提供一个简洁的接口，用于执行核心的"扫描 -> 稳定性检测 -> MD5 计算 -> 打包 -> 传输"工作流。用户只需提供必要的配置，函数内部将处理大部分选项的默认值和流程编排，从而隐藏底层 `scanFiles` 函数的复杂性。

## 2. 函数签名

```typescript
import { MatchRule, ScanProgress, FileItem, FailureItem } from './types'; // 假设类型定义位置

// 定义简化版的 Transport 配置接口
interface ScanAndTransportTransportConfig {
  protocol: 'ftp' | 'sftp';
  host: string;
  port: number;
  username: string;
  password: string; // 注意：生产环境建议使用更安全的方式处理密码
  remotePath: string;
}

// 定义打包触发条件接口
interface PackagingTriggerOptions {
  /** 触发打包的文件数量阈值 */
  maxFiles: number;
  /** 触发打包的文件总大小阈值 (单位 MB) */
  maxSizeMB: number;
}

// 定义 scanAndTransport 配置接口
interface ScanAndTransportConfig {
  // --- 必需参数 ---
  /** 要扫描的根目录 */
  rootDir: string;
  /** 文件匹配规则 */
  rules: MatchRule[];
  /** 传输目标服务器基本信息 */
  transport: ScanAndTransportTransportConfig;

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
}

// 定义 scanAndTransport 返回结果接口
interface ScanAndTransportResult {
  /** 整个过程是否基本成功 (即使有部分文件失败) */
  success: boolean;
  /** 成功处理并打包的文件列表 (包含MD5等元数据，用于下次跳过) */
  processedFiles: FileItem[];
  /** 整个流程中所有失败的条目列表 (包含路径和错误，用于重试) */
  failedItems: FailureItem[];
  /** 本地生成的包文件路径列表 */
  packagePaths: string[];
  /** 每个包的传输结果摘要 */
  transportSummary: any[]; // TODO: 定义更具体的 TransportResult 接口
  /** 实际使用的日志文件路径 */
  logFilePath: string;
}

/**
 * 执行扫描、打包和传输的简化流程函数
 * @param config 配置对象
 * @returns 包含处理结果和日志路径的对象
 */
async function scanAndTransport(config: ScanAndTransportConfig): Promise<ScanAndTransportResult>;
```

## 3. 内部逻辑概述

`scanAndTransport` 函数将执行以下操作：

1. **设置默认值：** 为 `ScanAndTransportConfig` 中未提供的可选参数应用预设的默认值（如 `outputDir`, `packageNamePattern`, `maxFileSize`, `skipDirs`, `depth`, `scanNestedArchives`, `maxNestedLevel`, `packagingTrigger`, `logFilePath` 等）。
2. **构建 `ScanOptions`：**
    * 启用内部处理流程：将 `calculateMd5` 和 `createPackage` 设置为 `true`。
    * 设置可靠的默认 `StabilityCheckOptions` 和 `QueueOptions`（例如启用稳定性检查和队列，设置合理的并发数和重试次数）。
    * 根据用户提供的简化 `transport` 配置和默认值（重试次数、超时等）构建完整的 `TransportOptions`。
    * 将用户提供的 `packagingTrigger` 或其默认值整合到配置中，传递给底层逻辑。
    * 将所有必需和可选配置组装成完整的 `ScanOptions` 对象。
3. **初始化日志：** 根据 `logFilePath`（用户指定或默认生成）设置日志记录器，将关键信息写入文件。
4. **调用核心功能：** 使用构建好的 `ScanOptions` 调用 `scanFiles` 函数。
5. **处理与整合结果：**
    * 监听 `scanFiles` 的 `onProgress` 回调（如果用户也提供了 `onProgress`，则进行包装转发）。
    * 处理 `scanFiles` 返回的 `ScanResult` 对象。
    * 将 `scanResult.processedFiles`（需要确认 `scanFiles` 返回此信息）提取为 `processedFiles`。
    * 整合 `scanResult.failures` 以及打包、传输阶段可能产生的错误到 `failedItems` 列表中。
    * 记录生成的 `packagePaths` 和 `transportResults`。
6. **记录日志：** 在整个执行过程中，将配置信息、关键阶段（扫描、打包、传输）的开始/结束、错误详情等写入日志文件。
7. **返回结果：** 构建并返回 `ScanAndTransportResult` 对象。

## 4. 与 `scanFiles` 的关系

`scanAndTransport` 是对底层 `scanFiles` 函数的一个高级封装（Facade）。它简化了常见用例的配置。对于需要更精细控制（例如，自定义队列行为、单独执行扫描而不传输等）的高级用户，仍然可以直接使用 `scanFiles` 函数及其完整的 `ScanOptions` 配置。

## 5. 优点

* **简化配置：** 用户只需关注核心需求。
* **易于使用：** 调用代码更简洁、直观。
* **默认最佳实践：** 内部默认启用稳定性、队列、MD5、打包等，并使用推荐设置。
* **结果清晰：** 返回明确的成功/失败文件列表和日志，方便后续处理。 

```mermaid
%%{init: {'theme': 'default', 'themeVariables': { 'fontSize': '14px'}, 'flowchart': {'useMaxWidth': true, 'htmlLabels': true, 'curve': 'linear'} } }%%
graph TD
    A[开始: 接收 ScanAndTransportConfig] --> B{合并配置与默认值}
    B --> C[日志: 记录开始和用户配置]
    C --> D[构建 TransportOptions]
    D --> E[构建 ScanOptions]
    
    subgraph "构建选项"
        D
        E
    end
    
    E --> F[日志: 记录构建后的选项]
    F --> G[调用核心 scanFiles 使用 ScanOptions]

    subgraph "核心处理"
        G -- scanResult --> H{处理 scanFiles 结果}
        G -- 异常 --> I{捕获 scanFiles 错误}
    end

    H --> J[判断成功状态: scanFiles是否抛错?]
    I --> K[设置 success = false]
    I --> L[记录顶层错误到 failedItems]
    J -- Yes --> M[设置 success = true]
    J -- No --> K

    M --> N[映射结果: processedFiles, failures, packagePaths, transportSummary]
    L --> N
    K --> N

    N --> O[日志: 记录结束状态和摘要]
    O --> P[结束: 返回 ScanAndTransportResult]

    style G fill:#f9f,stroke:#333,stroke-width:2px
```


好的，我将为 `scanFiles` 函数绘制流程图和数据流向图。

请注意，`scanFiles` 函数内部逻辑相当复杂，特别是涉及递归扫描、嵌套压缩包处理和可选的异步队列处理（稳定性、MD5、打包、传输）。这些图表旨在展示其主要流程和数据交互，可能会简化一些细节。

**1. `scanFiles` 流程图 (Flowchart)**

此图展示了 `scanFiles` 的控制流程和主要步骤。

```mermaid
%%{init: {'theme': 'default', 'themeVariables': { 'fontSize': '14px'}, 'flowchart': {'useMaxWidth': true, 'htmlLabels': true, 'curve': 'linear'} } }%%
graph TD
    A[开始: 接收 ScanOptions] --> B{初始化: 处理规则, 设置进度/失败列表}
    B --> C[队列/传输模块初始化]
    C --> D[调用 scanDirectory]

    subgraph "递归扫描逻辑"
        SD1[递归扫描目录] --> SD2{检查文件类型}
        SD2 --> SD3[处理常规文件]
        SD2 --> SD4[处理压缩包]
        SD2 --> SD5[处理子目录]
        SD4 --> SD6[提取并处理压缩包内容]
    end

    D --> E{等待队列处理完成}
    E --> F[整合结果]
    F --> G[返回 ScanResult]

    style D fill:#f9f,stroke:#333,stroke-width:2px
```

**2. `scanFiles` 数据流向图 (Data Flow Diagram)**


# 改造后的scanAndTransport数据流向图 (Mermaid)

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
    
    resultCollect --> finalResult[返回ScanAndTransportResult]
    
    classDef module fill:#f9f,stroke:#333,stroke-width:2px;
    classDef queue fill:#bbf,stroke:#333,stroke-width:1px;
    classDef check fill:#ffb,stroke:#333,stroke-width:1px;
    classDef process fill:#fcf,stroke:#333,stroke-width:1px;
    classDef result fill:#bfb,stroke:#333,stroke-width:1px;
    classDef failure fill:#fbb,stroke:#333,stroke-width:1px;
    
    class scan,md5Module,packageModule,transportModule module;
    class normalFileQ,archiveQ,md5Q,packageQ,transportQ queue;
    class sourceCheck,archiveFileCheck,normalStabilityCheck,retryCheck1,archiveStabilityCheck,retryCheck2 check;
    class extractArchive,addExtractedFiles,skipStability,trackArchiveFiles,normalRetry,archiveRetry process;
    class matchedFiles,transportResults result;
    class scanFailures,stabilityFailures,archiveFailures,extractFailures,md5Failures,packageFailures,transportFailures failure;
```

## 数据流向说明

1. **初始配置** - 函数接收配置，初始化队列和日志系统

2. **扫描模块** - 改造后的`scanFiles`只负责:
   - 文件系统扫描
   - 压缩包扫描
   - 嵌套压缩包扫描
   - 文件匹配并通过回调函数输出

3. **队列系统** - 处理匹配到的文件:
   - 稳定性检测队列 → 稳定性检测模块
   - MD5计算队列 → MD5计算模块
   - 打包队列 → 打包模块
   - 传输队列 → 传输模块
   
4. **错误处理** - 各阶段的失败收集:
   - 扫描失败
   - 稳定性检测失败
   - MD5计算失败
   - 打包失败
   - 传输失败

5. **结果处理** - 收集和合并所有结果，返回最终结果

每个模块专注于自己的职责，通过队列系统实现文件处理的流水线，保持处理顺序的同时支持一定程度的并行执行。
