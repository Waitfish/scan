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
  // 1. 查找根目录下所有以 'MeiTuan' 开头的 .docx 或 .doc 文件
  // 2. 查找根目录下所有以 'BuYunSou' 开头的 .pdf 或 .xls 文件
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
      console.log(`扫描中: ${progress.currentDir} | 文件: ${progress.scannedFiles} | 匹配: ${progress.matchedFiles}`);
      if (matchedFile) {
        console.log(`  -> 找到匹配: ${matchedFile.name} (创建于: ${matchedFile.createTime.toLocaleDateString()})`);
      }
    }
  };

  try {
    console.log(`开始扫描目录: ${scanOptions.rootDir}`);
    const matchedFiles: FileItem[] = await scanFiles(scanOptions);

    console.log('\n扫描完成!');
    console.log(`总共找到 ${matchedFiles.length} 个匹配文件:`);
    matchedFiles.forEach(file => {
      console.log(`- ${file.name} (路径: ${file.path}, 大小: ${(file.size / 1024).toFixed(2)} KB)`);
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
|---------------|------------------------------------------------------|-----------------------------------------------------------------|-----------------|
| `rootDir`     | `string`                                             | **必需**，要扫描的根目录绝对路径。                                     |                 |
| `matchRules`  | `MatchRule[]` (即 `[string[], string][]`)              | **必需**，文件匹配规则列表。每个规则是一个元组 `[后缀列表, 文件名正则]`。 |                 |
| `depth`       | `number`                                             | 扫描深度。`0` 表示只扫描根目录，`-1` 表示扫描所有子目录。               | `-1`            |
| `maxFileSize` | `number`                                             | 文件大小上限（字节）。超过此大小的文件将被忽略。                           | `524288000` (500MB) |
| `skipDirs`    | `string[]`                                           | 要跳过的目录名列表（相对于 `rootDir` 的路径，如 `['node_modules']`）。 | `[]`            |
| `onProgress`  | `(progress: ScanProgress, matchedFile?: FileItem) => void` | 可选的回调函数，用于报告扫描进度和实时匹配到的文件。                      |                 |

#### `FileItem`

| 属性         | 类型     | 描述         |
|--------------|----------|--------------|
| `path`       | `string` | 文件绝对路径   |
| `name`       | `string` | 文件名       |
| `createTime` | `Date`   | 文件创建时间 |
| `modifyTime` | `Date`   | 文件修改时间 |
| `size`       | `number` | 文件大小（字节） |

#### `ScanProgress`

| 属性                | 类型     | 描述               |
|---------------------|----------|------------------|
| `currentDir`        | `string` | 当前正在扫描的目录     |
| `scannedFiles`      | `number` | 已扫描的文件总数     |
| `scannedDirs`       | `number` | 已扫描的目录总数     |
| `matchedFiles`      | `number` | 找到的匹配文件总数   |
| `ignoredLargeFiles` | `number` | 因过大而被忽略的文件数 |
| `skippedDirs`       | `number` | 因规则而被跳过的目录数 |

## 许可证

[ISC](https://opensource.org/licenses/ISC)

## 仓库

[https://github.com/waitfish/scan.git](https://github.com/waitfish/scan.git) 