#!/usr/bin/env node

// 这个脚本用于过滤Jest测试输出，只保留重要信息

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// 跳过这些行
const skipLines = [
  /RUNS/,                    // 跳过所有包含RUNS的行（Jest运行指示器）
  /ts-jest/,                 // 跳过ts-jest警告
  /^$/,                      // 跳过空行
  /console\.log/,            // 跳过控制台输出行
  /at FTPContext\.log/,      // 跳过FTP日志记录器行
  /^>/,                      // 跳过FTP命令行
  /^</,                      // 跳过FTP响应行
  /Control socket is using:/, // 跳过Socket信息行
  /Login security:/,         // 跳过登录安全信息行
];

rl.on('line', (line) => {
  // 检查是否应该跳过这一行
  const shouldSkip = skipLines.some(pattern => pattern.test(line));
  
  if (!shouldSkip) {
    console.log(line);
  }
}); 