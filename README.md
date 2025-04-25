# @smallfish2025/scan

[![npm version](https://badge.fury.io/js/%40smallfish2025%2Fscan.svg)](https://badge.fury.io/js/%40smallfish2025%2Fscan)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

一个灵活且功能丰富的 Node.js 文件扫描器，允许通过自定义规则精确地查找文件。

## 特性

- **基于规则的匹配**: 定义包含文件后缀列表和文件名正则表达式的规则，精确匹配所需文件。
- **深度控制**: 限制扫描的目录深度，或扫描所有子目录。
- **目录排除**: 通过 `skipDirs` 选项轻松跳过指定目录（如 `node_modules`, `.git`）。
- **文件大小限制**: 通过 `maxFileSize` 选项忽略过大的文件。
- **实时进度报告**: 通过 `onProgress` 回调函数获取详细的扫描进度，包括当前目录、扫描统计以及**实时匹配到的文件信息**。
- **压缩包扫描**: **自动扫描并匹配 ZIP, TAR, TGZ, RAR 压缩包内的文件**，行为与扫描普通文件系统一致。
- **嵌套压缩包支持**: **支持扫描嵌套的压缩包（压缩包内的压缩包），最多支持5层嵌套**，并提供嵌套级别和完整嵌套路径信息。
- **TypeScript 支持**: 使用 TypeScript 编写，提供完整的类型定义。

## 安装

```bash
npm install @smallfish2025/scan
# 或者
yarn add @smallfish2025/scan
```

## 使用方法

```typescript
// 导入必要的模块和类型
import { scanFiles, FileItem, MatchRule, ScanProgress, ScanResult, FailureItem } from '@smallfish2025/scan';
import * as path from 'path';

// 定义一个异步函数来执行扫描操作
async function scanMyFiles() {
  // 定义文件匹配规则列表
  // 每个规则是一个数组，包含两个元素：
  // 1. 一个字符串数组，表示要匹配的文件后缀名（不需要带点，大小写不敏感）
  // 2. 一个字符串，表示匹配文件名的正则表达式
  const rules: MatchRule[] = [
    // 规则1: 匹配所有以 'MeiTuan' 开头的 .docx 或 .doc 文件
    [['docx', 'doc'], '^MeiTuan.*'],
    // 规则2: 匹配所有以 'BuYunSou' 开头的 .pdf 或 .xls 文件
    [['pdf', 'xls'], '^BuYunSou.*'],
    // 规则3: 匹配所有 .jpg 文件
    [['jpg'], '.*']
  ];

  // 定义要扫描的根目录 (请替换为你的实际路径)
  // 注意：为了运行此示例，你需要确保这个目录下有符合规则的文件或压缩包
  const targetRootDir = '/path/to/your/scan/directory';

  // 定义要跳过的目录列表（相对于根目录）
  // 扫描器会忽略这些目录及其所有子目录，也不会扫描这些目录下的压缩包
  const skipDirs = ['node_modules', '.git', 'temp', 'dist'];

  // 定义单个文件的最大大小限制（字节）
  // 超过此大小的文件（无论是文件系统文件还是压缩包内文件解压后的大小）将被忽略
  const maxSize = 500 * 1024 * 1024; // 500 MB

  // 定义扫描选项对象
  const scanOptions = {
    // 必需：扫描的根目录
    rootDir: targetRootDir,
    // 必需：文件匹配规则
    matchRules: rules,
    // 扫描深度：-1 表示扫描所有子目录（默认值）
    // 0 表示只扫描根目录，1 表示扫描到第一层子目录，以此类推
    depth: -1,
    // 可选：最大文件大小限制
    maxFileSize: maxSize,
    // 可选：要跳过的目录列表
    skipDirs: skipDirs,
    // 可选：进度回调函数
    // 每扫描一个目录、找到一个匹配文件或遇到跳过情况时，可能会调用此函数
    onProgress: (progress: ScanProgress, matchedFile?: FileItem) => {
      // 进度信息 (progress 对象)
      // console.log(`当前扫描目录: ${progress.currentDir}`);
      // console.log(`已扫描目录数: ${progress.scannedDirs}`);
      // console.log(`已扫描文件数: ${progress.scannedFiles}`);
      // console.log(`已扫描压缩包数: ${progress.archivesScanned}`);
      // console.log(`已找到匹配文件数: ${progress.matchedFiles}`);
      // console.log(`因过大忽略的文件数: ${progress.ignoredLargeFiles}`);
      // console.log(`跳过的目录数: ${progress.skippedDirs}`);

      // 如果当前回调是由于找到了匹配文件而触发的，matchedFile 会有值
      if (matchedFile) {
        // 打印找到的匹配文件的信息
        console.log(`[实时找到]: ${matchedFile.name}`);
        // 可以根据 matchedFile.origin 判断来源
        if (matchedFile.origin === 'archive') {
          // 如果来自压缩包，可以访问 archivePath 和 internalPath
          console.log(`  -> 来源: 压缩包 (${matchedFile.archivePath})`);
          console.log(`  -> 内部路径: ${matchedFile.internalPath}`);
        } else {
          // 如果来自文件系统，origin 可能是 'filesystem' 或 undefined
          console.log(`  -> 来源: 文件系统 (${matchedFile.path})`);
        }
      }
    }
  };

  // 使用 try...catch 包裹以处理可能的顶层错误（尽管大部分错误会被收集到 failures 中）
  try {
    // 记录开始扫描的信息
    console.log(`\n🚀 开始扫描目录: ${scanOptions.rootDir}`);
    console.log(`   规则数: ${scanOptions.matchRules.length}`);
    console.log(`   跳过目录: ${scanOptions.skipDirs.join(', ') || '无'}`);

    // 调用 scanFiles 函数执行扫描，它返回一个包含 results 和 failures 的 Promise
    // 使用 await 等待扫描完成
    const { results, failures }: ScanResult = await scanFiles(scanOptions);

    // ---- 处理扫描结果 ----

    // 打印扫描完成的提示信息
    console.log('\n✅ 扫描完成!');
    console.log('=================');

    // 打印成功匹配的文件列表
    console.log(`📊 找到 ${results.length} 个匹配文件:`);
    console.log('-----------------');
    // 遍历 results 数组
    results.forEach((file: FileItem, index: number) => {
      // 打印每个文件的详细信息
      console.log(`[${index + 1}] ${file.name}`);
      // 根据来源显示不同的路径信息
      if (file.origin === 'archive') {
        console.log(`    来源: 压缩包`);
        console.log(`    压缩包路径: ${file.archivePath}`);
        console.log(`    内部文件路径: ${file.internalPath}`);
        // 如果是嵌套压缩包内的文件，显示嵌套信息
        if (file.nestedLevel && file.nestedLevel > 0) {
          console.log(`    嵌套级别: ${file.nestedLevel}`);
          console.log(`    嵌套路径: ${file.nestedPath}`);
        }
      } else {
        console.log(`    来源: 文件系统`);
        console.log(`    文件路径: ${file.path}`);
      }
      // 打印文件大小（转换为 KB）
      console.log(`    大小: ${(file.size / 1024).toFixed(2)} KB`);
      // 打印创建和修改时间（本地化格式）
      console.log(`    创建时间: ${file.createTime.toLocaleString()}`);
      console.log(`    修改时间: ${file.modifyTime.toLocaleString()}`);
      console.log('-----------------');
    });

    // 检查是否有扫描失败的情况
    if (failures.length > 0) {
      // 如果 failures 数组不为空，则打印错误提示
      console.warn('\n⚠️ 扫描过程中遇到以下错误:');
      console.warn('=================');
      // 遍历 failures 数组
      failures.forEach((fail: FailureItem, index: number) => {
        // 打印每个失败项的详细信息
        console.warn(`[错误 ${index + 1}] 类型: ${fail.type}`);
        console.warn(`  路径: ${fail.path}`);
        // 如果是压缩包内部条目错误，打印内部路径
        if (fail.entryPath) {
          console.warn(`  内部条目: ${fail.entryPath}`);
        }
        // 打印具体的错误消息
        console.warn(`  错误详情: ${fail.error}`);
        console.warn('-----------------');
      });
    } else {
      // 如果 failures 数组为空，则打印无错误提示
      console.log('\n👍 扫描过程中未报告任何错误。');
    }

  } catch (error: any) {
    // 捕获并打印在调用 scanFiles 过程中可能发生的、未被内部捕获的意外错误
    console.error('\n❌ 扫描过程中发生严重错误:', error.message || error);
  }
}

// 调用执行扫描的函数
scanMyFiles();
```

## API

### `scanFiles(options: ScanOptions): Promise<ScanResult>`

异步扫描指定目录并返回一个包含成功匹配文件列表和失败信息列表的对象。

#### `ScanOptions`

| 选项          | 类型                                                   | 描述                                                              | 默认值             |
|---------------|------------------------------------------------------|-----------------------------------------------------------------|-----------------|
| `rootDir`     | `string`                                             | **必需**，要扫描的根目录绝对路径。                                     |                 |
| `matchRules`  | `MatchRule[]` (即 `[string[], string][]`)              | **必需**，文件匹配规则列表。每个规则是一个元组 `[后缀列表, 文件名正则]`。 |                 |
| `depth`       | `number`                                             | 扫描深度。`0` 表示只扫描根目录，`-1` 表示扫描所有子目录。               | `-1`            |
| `maxFileSize` | `number`                                             | 文件大小上限（字节）。超过此大小的文件将被忽略（对压缩包内文件同样有效）。       | `524288000` (500MB) |
| `skipDirs`    | `string[]`                                           | 要跳过的目录名列表（相对于 `rootDir` 的路径，如 `['node_modules']`）。扫描器不会进入这些目录，也不会扫描这些目录下的压缩包。 | `[]`            |
| `onProgress`  | `(progress: ScanProgress, matchedFile?: FileItem) => void` | 可选的回调函数，用于报告扫描进度和实时匹配到的文件。                      |                 |

#### `FileItem`

| 属性           | 类型       | 描述                            |
| ------------ | -------- | ----------------------------- |
| `path`       | `string` | 文件或其所在压缩包的绝对路径。               |
| `name`       | `string` | 文件名 (对于压缩包内文件，是其在压缩包中的文件名)。   |
| `createTime` | `Date`   | 文件或其所在压缩包的创建时间。               |
| `modifyTime` | `Date`   | 文件或其所在压缩包的修改时间。               |
| `size`       | `number` | 文件大小（字节） (对于压缩包内文件，是其解压后的大小)。 |
|              |          |                               |
