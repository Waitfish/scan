/**
 * @file 项目入口文件
 * @description 启动应用程序的主入口点
 */

import { config } from './config';
import { logger } from './utils/logger';

/**
 * 应用程序主函数
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  try {
    logger.info('应用程序启动中...');
    // 在这里添加应用程序初始化逻辑
    logger.info(`应用程序已启动，环境: ${config.env}`);
  } catch (error) {
    logger.error('应用程序启动失败:', error);
    process.exit(1);
  }
}

main(); 