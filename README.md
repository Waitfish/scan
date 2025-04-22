# @smallfish2025/scan

[![npm version](https://badge.fury.io/js/%40smallfish2025%2Fscan.svg)](https://badge.fury.io/js/%40smallfish2025%2Fscan)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

一个灵活且功能丰富的 Node.js 文件扫描器，允许通过自定义规则精确地查找文件。

## 特性

*   **基于规则的匹配**: 定义包含文件后缀列表和文件名正则表达式的规则，精确匹配所需文件。
*   **深度控制**: 限制扫描的目录深度，或扫描所有子目录。
*   **目录排除**: 通过 `skipDirs` 选项轻松跳过指定目录（如 `node_modules`, `.git`）。
*   **文件大小限制**: 通过 `maxFileSize` 选项忽略过大的文件。
*   **实时进度报告**: 通过 `onProgress` 回调函数获取详细的扫描进度，包括当前目录、扫描统计以及**实时匹配到的文件信息**。
*   **压缩包扫描**: **自动扫描并匹配 ZIP, TAR, TGZ, RAR 压缩包内的文件**，行为与扫描普通文件系统一致。
*   **TypeScript 支持**: 使用 TypeScript 编写，提供完整的类型定义。

## 安装

```bash
npm install @smallfish2025/scan
# 或者
yarn add @smallfish2025/scan
```

## 使用方法

```typescript
import { scanFiles, FileItem, MatchRule, ScanProgress } from '@smallfish2025/scan';
import * as path from 'path';

async function findReports() {
  // 定义匹配规则:
  // 1. 查找根目录下所有以 'MeiTuan' 开头的 .docx 或 .doc 文件 (包括压缩包内)
  // 2. 查找根目录下所有以 'BuYunSou' 开头的 .pdf 或 .xls 文件 (包括压缩包内)
  const rules: MatchRule[] = [
    [['docx', 'doc'], '^MeiTuan.*'],
    [['pdf', 'xls'], '^BuYunSou.*']
  ];

  const scanOptions = {
    rootDir: '/path/to/your/scan/directory', // 替换为你要扫描的实际目录
    matchRules: rules,
    depth: -1, // 扫描所有子目录
    maxFileSize: 500 * 1024 * 1024, // 忽略大于 500MB 的文件
    skipDirs: ['node_modules', '.git', 'temp'], // 跳过这些目录
    onProgress: (progress: ScanProgress, matchedFile?: FileItem) => {
      // 可以在这里更新 UI 或记录详细日志
      let originInfo = '';
      if (matchedFile) {
        if (matchedFile.origin === 'archive') {
          originInfo = ` (来源: 压缩包 ${matchedFile.archivePath}, 内部路径: ${matchedFile.internalPath})`;
        } else {
          originInfo = ` (来源: 文件系统)`;
        }
        console.log(`  -> 找到匹配: ${matchedFile.name}${originInfo}`);
      }
      const progressSummary = [
        `扫描中: ${progress.currentDir}`,
        `目录: ${progress.scannedDirs}`,
        `文件: ${progress.scannedFiles}`,
        `压缩包: ${progress.archivesScanned}`,
        `匹配: ${progress.matchedFiles}`,
        `跳过(大): ${progress.ignoredLargeFiles}`,
        `跳过(目录): ${progress.skippedDirs}`
      ].join(' | ');
      console.log(progressSummary);
    }
  };

  try {
    console.log(`开始扫描目录: ${scanOptions.rootDir}`);
    const matchedFiles: FileItem[] = await scanFiles(scanOptions);

    console.log('\n扫描完成!');
    console.log(`总共找到 ${matchedFiles.length} 个匹配文件:`);
    matchedFiles.forEach(file => {
      const originDesc = file.origin === 'archive' 
        ? `来自压缩包 ${file.archivePath} (内部: ${file.internalPath})`
        : `来自文件系统 (${file.path})`;
      console.log(`- ${file.name} (大小: ${(file.size / 1024).toFixed(2)} KB, ${originDesc})`);
    });

  } catch (error) {
    console.error('扫描过程中发生错误:', error);
  }
}

findReports();
```

## API

### `scanFiles(options: ScanOptions): Promise<FileItem[]>`

异步扫描指定目录并返回匹配的文件信息数组。

#### `ScanOptions`

| 选项          | 类型                                                   | 描述                                                              | 默认值             |
|---------------|------------------------------------------------------|-----------------------------------------------------------------|-----------------|\n| `rootDir`     | `string`                                             | **必需**，要扫描的根目录绝对路径。                                     |                 |\n| `matchRules`  | `MatchRule[]` (即 `[string[], string][]`)              | **必需**，文件匹配规则列表。每个规则是一个元组 `[后缀列表, 文件名正则]`。 |                 |\n| `depth`       | `number`                                             | 扫描深度。`0` 表示只扫描根目录，`-1` 表示扫描所有子目录。               | `-1`            |\n| `maxFileSize` | `number`                                             | 文件大小上限（字节）。超过此大小的文件将被忽略（对压缩包内文件同样有效）。       | `524288000` (500MB) |\n| `skipDirs`    | `string[]`                                           | 要跳过的目录名列表（相对于 `rootDir` 的路径，如 `[\'node_modules\']`）。扫描器不会进入这些目录，也不会扫描这些目录下的压缩包。 | `[]`            |\n| `onProgress`  | `(progress: ScanProgress, matchedFile?: FileItem) => void` | 可选的回调函数，用于报告扫描进度和实时匹配到的文件。                      |                 |

#### `FileItem`

| 属性         | 类型     | 描述                                                              |
|--------------|----------|-----------------------------------------------------------------|
| `path`       | `string` | 文件或其所在压缩包的绝对路径。                                         |
| `name`       | `string` | 文件名 (对于压缩包内文件，是其在压缩包中的文件名)。                            |
| `createTime` | `Date`   | 文件或其所在压缩包的创建时间。                                      |
| `modifyTime` | `Date`   | 文件或其所在压缩包的修改时间。                                      |
| `size`       | `number` | 文件大小（字节） (对于压缩包内文件，是其解压后的大小)。                       |
| `origin`     | `'filesystem' \| 'archive'` | 文件来源：`'filesystem'` 表示来自文件系统，`'archive'` 表示来自压缩包。          |
| `archivePath`| `string?` | 如果 `origin` 是 `'archive'`，表示该文件所在的压缩包的绝对路径。              |
| `internalPath`| `string?` | 如果 `origin` 是 `'archive'`，表示该文件在压缩包内的相对路径。                 |


#### `ScanProgress`

| 属性                | 类型     | 描述               |\n|---------------------|----------|------------------|\n| `currentDir`        | `string` | 当前正在扫描的目录     |\n| `scannedFiles`      | `number` | 已扫描的文件系统文件总数 |\n| `scannedDirs`       | `number` | 已扫描的目录总数     |\n| `archivesScanned`   | `number` | 已尝试扫描的压缩包总数 |\n| `matchedFiles`      | `number` | 找到的匹配文件总数   |\n| `ignoredLargeFiles` | `number` | 因过大而被忽略的文件数 |\n| `skippedDirs`       | `number` | 因规则而被跳过的目录数 |\n

## 测试与示例中的 RAR 文件

本库支持扫描 RAR 压缩包。然而，由于 Node.js 生态中缺乏直接创建 RAR 文件的标准库（RAR 格式是专有的），本库的自动化测试 (`npm test`) 和示例代码 (`npm run example`) **无法自动生成用于测试的 `.rar` 文件**。

如果您需要：
1.  **运行包含 RAR 扫描的完整测试**: 请手动创建一个名为 `test-archive.rar` 的压缩文件，其中包含符合 `src/__tests__/scanner.test.ts` 中规则的文件（例如，`rar-match.txt`, `docs/MeiTuan-rar.docx` 等），并将其放置在项目根目录下的 `test-files/archives/` 目录中。
2.  **在示例中查看 RAR 文件扫描**: 请手动创建一个包含文件的 `.rar` 文件（例如，`my-test.rar`），将其放入 `example-test-run/archives/` 目录（运行 `npm run example` 前，如果该目录不存在，脚本会创建它），并确保 `src/example.ts` 中的 `matchRules` 能够匹配您放入的 RAR 文件内部的文件。

如果测试或示例运行时未找到对应的 `.rar` 文件，相关测试断言会被跳过，或者示例中不会显示来自 RAR 的文件，但不会导致脚本失败。

## 许可证

[ISC](https://opensource.org/licenses/ISC)

## 仓库

[https://github.com/waitfish/scan.git](https://github.com/waitfish/scan.git) 