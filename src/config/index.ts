/**
 * @file 配置文件
 * @description 应用程序配置管理
 */

interface Config {
  env: string;
  port: number;
  logLevel: string;
}

const config: Config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info'
};

export { config }; 