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

**目标**: 使整个扫描、处理、上传流程具备在意外中断后，能够从上次的进度点恢复执行的能力，避免完全重头开始。

**实现方案 (高层次概念)**:

1. **状态定义**: 明确需要持久化以支持恢复的关键状态信息。这可能包括：
    * **扫描阶段**: 最后成功扫描的目录或文件的标记。
    * **MD5 计算阶段**:
        * 等待计算 MD5 的文件队列 (`md5Queue`) 的剩余内容。
        * 已经完成 MD5 计算但尚未进入下一阶段的文件信息（包括 MD5 值）。
        * `currentTaskMd5Set` 的内容（用于恢复任务内去重状态）。
    * **打包阶段**:
        * 等待打包的文件队列 (`packagingQueue`) 的剩余内容。
        * 当前正在构建的包的状态（如果适用，例如已添加到包中的文件列表）。
    * **上传阶段**:
        * 等待上传的包队列 (`uploadQueue`) 的剩余内容。
        * 已成功上传的包（或文件）的列表。
    * **全局**: 任务的唯一标识符（用于关联状态文件），配置参数。

2. **状态持久化**:
    * 选择一种或多种方式存储状态，例如一个集中的 JSON 文件 (`task-state.json`) 或分布在不同阶段的状态文件。
    * 状态更新时机：
        * **定期保存**: 按一定时间间隔或处理完一定数量的项目后保存。
        * **关键节点保存**: 在完成一个主要步骤（如一个目录扫描完、一个文件 MD5 计算完、一个包构建完/上传完）后保存。
        * **原子性**: 状态保存操作应尽可能具有原子性，以防状态文件本身损坏。可以采用先写入临时文件再重命名的策略。

3. **恢复逻辑**:
    * **任务启动时**: 检查是否存在与当前任务（可能由配置参数或任务 ID 识别）相关的有效状态文件。
    * **状态文件存在**:
        * 加载并验证状态文件。
        * 根据状态信息恢复各个内部队列、进度标记和 Set (如 `currentTaskMd5Set`)。
        * 调整程序逻辑，使其从恢复的状态点开始执行，例如：跳过已扫描的目录，重新填充待处理队列，跳过已完成的 MD5 计算/打包/上传等。
    * **状态文件不存在或无效**:
        * 作为全新任务开始执行。

4. **状态清理**:
    * 当任务**正常成功完成**所有步骤后，应删除或标记关联的状态文件，以确保下次使用相同配置启动时是一个新任务。

**结果体现**:

* 用户在程序异常退出（如崩溃、断电、手动 `Ctrl+C`）后，重新运行相同的命令/任务，程序能自动从接近中断的地方继续执行，显著减少重复工作量。
* 需要良好的日志记录来表明任务是从恢复状态启动还是全新启动，以及恢复的具体进度点。

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


好的，我们现在开始设计断点续传功能。

断点续传的核心思想是在任务执行过程中，定期或在关键节点将当前的处理状态持久化（保存到文件）。当任务意外中断（如程序崩溃、手动停止）后重新启动时，程序能够读取上次保存的状态，并从中断的地方继续执行，而不是从头开始。

以下是断点续传功能的接口定义、作用说明以及单元测试方案。

## 1. 新增接口定义与作用

为了实现断点续传，我们需要定义一些接口来描述需要保存的任务状态。这些状态信息将帮助程序在恢复时重建各个处理队列和进度。

```typescript
// src/types/state.d.ts (建议新建此文件)

import { FileItem, FailureItem, TransportResult } from './index';
import { PackagingResult } from './packaging';

/**
 * 定义需要持久化的任务状态
 */
export interface TaskState {
  /** 任务的唯一标识符 */
  taskId: string;
  /** 扫描的唯一标识符 */
  scanId: string;
  /** 任务启动时的时间戳 (ISO 8601 格式) */
  startTime: string;
  /** 任务配置 (部分关键配置，用于校验或恢复) */
  configSnapshot: {
    rootDir: string;
    rulesCount: number; // 规则数量用于基本校验
    deduplicationEnabled: boolean;
    transportEnabled: boolean;
  };

  /** 扫描阶段状态 */
  scanState: {
    /** 已完成扫描的目录列表 (可选，如果恢复粒度需要到目录级别) */
    completedDirs?: string[];
    /** 已匹配但尚未进入任何处理队列的文件列表 */
    pendingMatchedFiles: FileItem[];
  };

  /** 队列状态 */
  queueState: {
    /** 文件稳定性检查等待队列 */
    fileStabilityQueue: FileItem[];
    /** 压缩文件稳定性检查等待队列 */
    archiveStabilityQueue: FileItem[];
    /** MD5 计算等待队列 */
    md5Queue: FileItem[];
    /** 打包等待队列 */
    packagingQueue: FileItem[];
    /** 传输等待队列 */
    transportQueue: FileItem[];
    /** 重试队列内容 (key: 文件路径, value: 需要返回的队列名) */
    retryQueue: Record<string, string>;
    /** 正在处理中的文件 (key: 队列名, value: 文件路径 Set) */
    processingFiles: Record<string, string[]>;
    /** 归档文件追踪器状态 */
    archiveTrackerState: {
      /** 归档文件 -> 内部文件列表映射 */
      archiveToFiles: Record<string, string[]>;
      /** 归档文件 -> 状态映射 */
      archiveStatus: Record<string, 'waiting' | 'stable' | 'unstable' | 'processing'>;
    }
  };

  /** 去重状态 (仅当启用去重时需要) */
  deduplicationState?: {
    /** 当前任务中已遇到的非重复文件 MD5 集合 */
    currentTaskMd5Set: string[];
    /** 当前任务中因历史重复而被跳过的文件列表 */
    skippedHistoricalDuplicates: FileItem[];
    /** 当前任务中因任务内重复而被跳过的文件列表 */
    skippedTaskDuplicates: FileItem[];
  };

  /** 处理结果状态 */
  progressState: {
    /** 已成功处理并完成的文件列表 (包含MD5等信息) */
    processedFiles: FileItem[];
    /** 已完成打包的包文件路径列表 */
    packagePaths: string[];
    /** 已完成的传输结果摘要列表 */
    transportSummary: TransportResult[];
    /** 记录的失败项列表 */
    failedItems: FailureItem[];
  };

  /** 最后保存时间戳 (ISO 8601 格式) */
  lastSavedTime: string;
  /** 状态文件的版本号 (用于未来可能的格式升级) */
  version: string;
}

```

**接口作用说明**:

*   **`TaskState`**: 顶层接口，聚合了所有需要保存的状态信息。
    *   `taskId`, `scanId`, `startTime`, `configSnapshot`: 用于标识任务和验证恢复的配置是否匹配。
    *   `scanState`: 保存扫描阶段的进度，特别是那些已匹配但还未进入后续处理队列的文件。
    *   `queueState`: 保存各个处理队列（稳定性、MD5、打包、传输、重试）中等待处理的文件，以及正在处理中的文件和压缩包的跟踪状态。这是恢复的核心，允许从队列中断的地方继续。
    *   `deduplicationState`: 保存当前任务的去重状态，包括已遇到的MD5集合和已跳过的文件列表，确保恢复后去重逻辑的连续性。
    *   `progressState`: 保存已经成功完成的各阶段结果（已处理文件、已打包路径、已传输结果、失败项），避免重新处理已完成的部分。
    *   `lastSavedTime`, `version`: 用于跟踪状态文件的新旧和格式兼容性。

## 2. 状态持久化与恢复机制 (概要)

1.  **状态文件**:
    *   为每个任务（由 `taskId` 标识）创建一个状态文件，例如 `task-state-${taskId}-${scanId}.json`。
    *   状态文件存储在 `resultsDir` 或一个专门的 `state` 目录下。
2.  **保存时机**:
    *   **关键节点**: 在 `scanAndTransport` 函数的主要步骤之间（例如，扫描后、MD5计算后、打包后、传输后）。
    *   **定期保存**: 在长时间运行的队列处理循环中（例如，每处理N个文件或每隔M分钟）。
    *   **任务结束/中断时**: 在 `finally` 块中尝试进行最后一次保存。
3.  **原子性写入**: 采用"写入临时文件 -> 重命名"的方式确保状态文件写入的原子性，防止文件损坏。
4.  **恢复逻辑**:
    *   `scanAndTransport` 函数启动时，检查是否存在与 `taskId` 对应的有效状态文件。
    *   如果存在且有效（例如，`taskId` 匹配，`configSnapshot` 基本一致），则加载状态。
    *   根据加载的状态信息：
        *   恢复 `FileProcessingQueue` 的内部队列和追踪器状态。
        *   恢复 `Deduplicator` 的 `currentTaskMd5Set` 和跳过列表。
        *   恢复 `processedFiles`, `packagePaths`, `transportSummary`, `failedItems` 列表。
        *   调整后续逻辑，跳过已完成的步骤，从中断的队列开始处理。
    *   如果状态文件不存在或无效，则作为新任务启动。
5.  **状态清理**: 当任务**正常成功完成**后，删除对应的状态文件。

## 3. 单元测试方案

为了确保断点续传功能的健壮性，需要设计以下单元测试场景：

1.  **状态保存测试 (`State Persistence Tests`)**:
    *   测试在不同阶段（扫描后、MD5处理中、打包后、传输完成、任务结束时）能否正确生成包含预期信息的 `TaskState` 对象。
    *   测试 `saveStateToFile` 函数能否成功将 `TaskState` 对象写入临时文件并重命名。
    *   测试状态文件写入失败时的错误处理。
2.  **状态加载测试 (`State Loading Tests`)**:
    *   测试 `loadStateFromFile` 函数能否成功读取有效的状态文件并解析为 `TaskState` 对象。
    *   测试状态文件不存在时的处理（应返回 null 或类似指示）。
    *   测试状态文件损坏或格式无效时的处理（应视为无效状态）。
    *   测试加载的状态与当前任务配置不匹配时的处理（例如 `rootDir` 不同，应视为无效状态）。
3.  **恢复逻辑测试 (`Resumption Logic Tests`)**:
    *   **场景1：扫描中断恢复**:
        *   模拟：运行扫描，保存扫描到一半的状态（`scanState.pendingMatchedFiles` 有内容）。
        *   验证：重新启动任务加载状态后，`FileProcessingQueue` 的 `matchedQueue` 被正确填充，并且后续处理从这些文件开始，而不是重新扫描。
    *   **场景2：MD5计算中断恢复**:
        *   模拟：运行到MD5计算阶段，处理一部分文件后保存状态（`queueState.md5Queue` 有剩余，`queueState.packagingQueue` 有部分文件，`deduplicationState` 有内容）。
        *   验证：重新启动任务加载状态后，MD5队列和打包队列被正确恢复，`Deduplicator` 状态被恢复，处理从剩余的MD5计算开始，已完成MD5的文件进入打包，去重逻辑正确衔接。
    *   **场景3：打包中断恢复**:
        *   模拟：运行到打包阶段，成功打了一个包后保存状态（`queueState.packagingQueue` 有剩余，`progressState.packagePaths` 有内容，`queueState.transportQueue` 有一个包）。
        *   验证：重新启动任务加载状态后，打包队列和传输队列被正确恢复，`packagePaths` 列表被恢复，处理从剩余的打包任务开始。
    *   **场景4：传输中断恢复**:
        *   模拟：运行到传输阶段，成功传输部分包后保存状态（`queueState.transportQueue` 有剩余，`progressState.transportSummary` 有部分结果，`deduplicationState.historicalMd5Set` 可能已更新）。
        *   验证：重新启动任务加载状态后，传输队列和 `transportSummary` 被恢复，处理从剩余的传输任务开始，历史去重记录也应正确恢复。
    *   **场景5：重试队列恢复**:
        *   模拟：有文件进入重试队列后保存状态。
        *   验证：重新启动后，重试队列被恢复，并在合适的时机重新尝试处理。
4.  **状态清理测试 (`State Cleanup Tests`)**:
    *   测试任务成功完成后，对应的状态文件是否被正确删除。
    *   测试任务失败结束时，状态文件是否被保留（以便下次恢复）。

这些测试需要结合 Mocking 技术（例如 Mock 文件系统操作 `fs-extra`，Mock 队列处理逻辑）来隔离测试单元并模拟中断场景。

