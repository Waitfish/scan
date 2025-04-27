# `scanAndTransport` 函数 TDD 开发计划

本文档遵循测试驱动开发（TDD）原则，规划新的 `scanAndTransport` 封装函数的开发步骤。

## 阶段 1：接口定义与基础结构

- [ ] **定义接口：**
  - [ ] 在 `src/types/index.ts` 或新文件 `src/types/facade.ts` 中定义 `ScanAndTransportTransportConfig` 接口。
  - [ ] 定义 `PackagingTriggerOptions` 接口。
  - [ ] 定义 `ScanAndTransportConfig` 接口。
  - [ ] 定义 `ScanAndTransportResult` 接口 (包括确认 `transportSummary` 的具体类型，可能复用或扩展现有 `TransportResult`)。
- [ ] **创建文件：**
  - [ ] 在 `src/index.ts` (或新的 `src/facade.ts`) 中创建 `scanAndTransport` 函数的基本框架（空函数或只抛出 `NotImplementedError`）。
- [ ] **基础测试：** (例如，在 `src/__tests__/facade.test.ts`)
  - [ ] **测试用例：** 验证 `scanAndTransport` 函数存在且可被导入。
  - [ ] **测试用例：** 验证调用 `scanAndTransport` 时，如果缺少必需的参数 (`rootDir`, `rules`, `transport`) 会抛出错误。

## 阶段 2：默认选项处理

- [ ] **实现逻辑：** 在 `scanAndTransport` 内部实现合并用户配置和默认值的逻辑。
  - 涉及参数：`outputDir`, `packageNamePattern`, `maxFileSize`, `skipDirs` (默认 `[]`), `depth` (默认 `-1`), `scanNestedArchives`, `maxNestedLevel`, `packagingTrigger` (默认 `{ maxFiles: 500, maxSizeMB: 2048 }`), `logFilePath` (默认带时间戳)。
  - 确定内部默认的 `StabilityCheckOptions` 和 `QueueOptions`。
  - 确定内部默认 `calculateMd5 = true`, `createPackage = true`。
  - 根据 `transport` 配置构建完整的 `TransportOptions`。
- [ ] **单元测试：**
  - [ ] **测试用例：** 验证当用户不提供可选参数时，函数内部使用了正确的默认值来构建最终的 `ScanOptions`（可以通过模拟 `scanFiles` 并检查其接收的参数来测试）。
  - [ ] **测试用例：** 验证用户提供的可选参数能正确覆盖默认值。
  - [ ] **测试用例：** 验证默认的 `logFilePath` 格式正确。
  - [ ] **测试用例：** 验证 `TransportOptions` 被正确构建。

## 阶段 3：调用核心 `scanFiles` 与基础结果映射

- [ ] **实现逻辑：**
  - [ ] 在 `scanAndTransport` 中，使用构建好的 `ScanOptions` 调用 `scanFiles` 函数。
  - [ ] 实现从 `scanFiles` 返回的 `ScanResult` 到 `ScanAndTransportResult` 的基本映射（如 `success` 状态判断逻辑，传递 `packagePaths`，`transportResults` -> `transportSummary`）。
- [ ] **集成/单元测试 (可 Mock `scanFiles`)**
  - [ ] **测试用例：** 验证 `scanFiles` 被正确调用，参数符合预期。
  - [ ] **测试用例：** 模拟 `scanFiles` 返回成功结果，验证 `ScanAndTransportResult` 中的 `success`, `packagePaths`, `transportSummary` 字段被正确填充。
  - [ ] **测试用例：** 模拟 `scanFiles` 抛出错误，验证 `scanAndTransport` 能捕获并妥善处理（例如返回 `success: false`）。

## 阶段 4：详细结果处理 (成功/失败列表)

- [ ] **实现逻辑：**
  - [ ] **确认依赖：** 确保 `scanFiles` 能返回包含 MD5 的已处理文件列表 (`processedFiles`) 和详细的失败列表 (`failures`)，如果不能，需要先增强 `scanFiles`。
  - [ ] 实现将 `scanResult.processedFiles` 映射到 `ScanAndTransportResult.processedFiles`。
  - [ ] 实现将 `scanResult.failures` 和可能的打包/传输错误整合到 `ScanAndTransportResult.failedItems`。
- [ ] **单元/集成测试：**
  - [ ] **测试用例：** 模拟 `scanFiles` 返回包含 `processedFiles` 的结果，验证 `ScanAndTransportResult.processedFiles` 包含预期内容（包括 MD5）。
  - [ ] **测试用例：** 模拟 `scanFiles` 返回包含 `failures` 的结果，验证 `ScanAndTransportResult.failedItems` 包含预期的失败条目。
  - [ ] **测试用例：** 模拟打包或传输阶段失败，验证这些失败也被添加到 `failedItems`。

## 阶段 5：日志记录实现

- [ ] **实现逻辑：**
  - [ ] 实现一个简单的文件日志记录工具或集成现有库。
  - [ ] 在 `scanAndTransport` 的关键节点（开始、结束、配置加载、调用 `scanFiles` 前后、错误捕获等）添加日志记录。
  - [ ] 实现根据 `logFilePath` 参数写入日志文件。
- [ ] **集成测试：**
  - [ ] **测试用例：** 运行 `scanAndTransport`，验证日志文件被创建在指定或默认路径。
  - [ ] **测试用例：** 检查日志文件内容，确认关键信息和错误被正确记录。

## 阶段 6：打包触发逻辑调整 (按需)

- [ ] **评估必要性：** 检查现有打包逻辑是否需要修改以支持基于数量和大小的触发条件以及最后的"清空"打包。
- [ ] **实现逻辑 (如果需要)：**
  - [ ] 修改 `scanFiles` 内部或 `packaging.ts` / `queue.ts` 中的逻辑，监控 `packagingQueue` 状态。
  - [ ] 实现基于阈值触发打包的机制。
  - [ ] 确保流程结束时打包所有剩余文件。
- [ ] **单元/集成测试 (如果修改)：**
  - [ ] **测试用例：** 验证文件数量达到阈值时触发打包。
  - [ ] **测试用例：** 验证文件总大小达到阈值时触发打包。
  - [ ] **测试用例：** 验证流程结束时，剩余文件被打包。
  - [ ] **测试用例：** 在 `scanAndTransport` 的集成测试中验证不同 `packagingTrigger` 配置的效果。

## 阶段 7：端到端集成测试与优化

- [ ] **完善测试：**
  - [ ] 编写或更新针对 `scanAndTransport` 的端到端集成测试 (类似 `integration-test.ts`，但调用新函数)。
  - [ ] 测试各种配置组合，包括不同的可选参数、打包触发条件。
  - [ ] 测试边界情况：空目录、无匹配文件、传输目标不可达、权限问题等。
- [ ] **代码优化：** 根据测试结果和代码审查进行重构和优化。

## 阶段 8：文档更新

- [ ] **更新文档：**
  - [ ] 在 `README.md` 中添加 `scanAndTransport` 的使用说明和示例。
  - [ ] (可选) 更新 API 文档。