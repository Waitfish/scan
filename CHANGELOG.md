# 更新日志

所有项目的重要更改都将记录在此文件中。

该格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且该项目遵循 [语义化版本](https://semver.org/lang/zh-CN/2.0.0/)。

## [1.1.0] - 2025-04-22

### 新增 (Added)

- **失败报告**: `scanFiles` 函数现在返回一个包含 `results` (成功匹配列表) 和 `failures` (失败信息列表) 的对象，以明确报告扫描过程中遇到的错误（例如目录无法访问、文件状态获取失败、压缩包无法打开或处理失败）。
- 添加了 `FailureItem` 类型定义，描述失败详情。
- 添加了 `ScanResult` 类型定义，描述 `scanFiles` 的新返回结构。
- 测试用例现在验证失败情况并检查 `failures` 列表。
- 示例代码现在会打印扫描过程中遇到的失败信息。

### 变更 (Changed)

- **破坏性变更**: `scanFiles` 函数的返回类型从 `Promise<FileItem[]>` 更改为 `Promise<ScanResult>`。
- 更新了 README 文档以反映新的返回类型和失败报告机制。

## [1.0.1] - 2025-04-22

### 1.0.1 新增 (Added)

- **RAR 压缩包支持**: 新增扫描 `.rar` 压缩包内部文件的功能 (依赖 `node-unrar-js`)。
- 在 `ARCHIVE_EXTENSIONS` 中添加了 `.rar`。
- 添加了 `scanRarArchive` 函数处理 RAR 文件。
- 更新了测试用例以包含对 RAR 文件的验证（需要用户手动提供 `test-archive.rar` 文件）。
- 更新了 README 文档，添加了 RAR 支持说明以及手动提供测试文件的指南。
- 添加了 `node-unrar-js` 作为生产依赖。

### 1.0.1 变更 (Changed)

- `scanArchive` 函数重命名为 `scanCompressingArchive`，专门处理 ZIP/TAR/TGZ。
- `scanDirectory` 函数现在根据文件扩展名调用 `scanRarArchive` 或 `scanCompressingArchive`。
- 更新了 `ScanProgress` 类型和 README，添加了 `archivesScanned` 字段。
- 更新了示例代码 (`onProgress` 和最终输出) 以更清晰地显示文件来源 (`origin`, `archivePath`, `internalPath`)。

### 修复 (Fixed)

- 修正了 README 中 `ScanOptions` 和 `ScanProgress` 表格的 Markdown 格式错误。

## [1.0.0] - 2025-04-22

### 1.0.0 新增

- 初始版本发布。
- 基于规则（后缀、文件名正则）的文件扫描。
- 支持扫描 ZIP, TAR, TGZ 压缩包内部文件（默认启用）。
- 支持限制扫描深度 (`depth`)。
- 支持排除指定目录 (`skipDirs`)。
- 支持限制最大文件大小 (`maxFileSize`)。
- 提供进度报告回调 (`onProgress`)，包含扫描统计和实时匹配文件信息。
- 提供 `FileItem`, `MatchRule`, `ScanOptions`, `ScanProgress` 类型定义。
- 包含基础测试用例和使用示例 (`src/example.ts`)。
- 添加了 README 文档。
- 配置了 TypeScript 编译和 npm 发布脚本。
- 添加了 `fs-extra` 和 `compressing` 作为依赖。
- 添加了 ESLint 和 Prettier 配置以及相关脚本。 