/**
 * @file 文件传输模块
 * 用于将文件传输到FTP/SFTP服务器
 */

import * as path from 'path';
import { TransportOptions } from '../types';
import * as fs from 'fs';

// 导入ftp-srv和ssh2-sftp-client的类型
let SftpClient: any;

// 添加basic-ftp的导入
let BasicFtpClient: any;

/**
 * 传输结果接口
 */
export interface TransportResult {
  /** 是否成功 */
  success: boolean;
  /** 传输的文件路径 */
  filePath: string;
  /** 远程路径 */
  remotePath: string;
  /** 重试次数（如果有） */
  retries?: number;
  /** 错误信息（如果有） */
  error?: string;
  /** 传输开始时间 */
  startTime: Date;
  /** 传输结束时间 */
  endTime: Date;
}

/**
 * 传输错误类
 */
export class TransportError extends Error {
  public code: string;
  
  constructor(message: string, code: string = 'UNKNOWN_ERROR') {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/**
 * 传输适配器接口
 */
export interface TransportAdapter {
  /** 连接到服务器 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 上传文件 */
  upload(localPath: string, remotePath: string): Promise<TransportResult>;
  /** 批量上传文件 */
  uploadBatch(files: { localPath: string; remotePath: string }[]): Promise<TransportResult[]>;
  /** 检查远程文件是否存在 */
  exists(remotePath: string): Promise<boolean>;
}

/**
 * 创建传输适配器工厂方法
 */
export function createTransportAdapter(options: TransportOptions): TransportAdapter | null {
  if (!options.enabled) {
    return null;
  }
  
  switch (options.protocol) {
    case 'ftp':
      return new FtpAdapter(options);
    case 'sftp':
      return new SftpAdapter(options);
    case 'ftps':
      return new FtpsAdapter(options);
    default:
      throw new TransportError(`不支持的传输协议: ${options.protocol}`, 'UNSUPPORTED_PROTOCOL');
  }
}

/**
 * FTP传输适配器实现
 */
export class FtpAdapter implements TransportAdapter {
  private options: TransportOptions;
  private client: any = null;
  private connected: boolean = false;
  
  constructor(options: TransportOptions) {
    this.options = options;
  }
  
  /**
   * 连接到FTP服务器
   */
  async connect(): Promise<void> {
    try {
      // 动态导入以避免在不需要时加载依赖
      if (!BasicFtpClient) {
        const basicFtp = require('basic-ftp');
        BasicFtpClient = basicFtp.Client;
      }
      
      this.client = new BasicFtpClient();
      
      // 可选的调试输出
      if (this.options.debug) {
        this.client.ftp.verbose = true;
      }
      
      // 设置连接超时
      if (this.options.timeout) {
        this.client.ftp.timeout = this.options.timeout;
      } else {
        // 默认设置较长的超时时间，避免测试失败
        this.client.ftp.timeout = 30000;
      }
      
      // 连接到FTP服务器 (不使用TLS)
      await this.client.access({
        host: this.options.host,
        port: this.options.port,
        user: this.options.username,
        password: this.options.password,
        secure: false // FTP不使用TLS
      });
      
      // 如果远程根目录不是默认目录，则切换到指定目录
      if (this.options.remotePath && this.options.remotePath !== '/') {
        try {
          await this.client.ensureDir(this.options.remotePath);
        } catch (error: any) {
          throw new Error(`无法切换到指定的远程目录: ${error.message}`);
        }
      }
      
      this.connected = true;
    } catch (error: any) {
      this.connected = false;
      throw new TransportError(`无法连接到FTP服务器: ${error.message}`, 'FTP_CONNECTION_ERROR');
    }
  }
  
  /**
   * 断开FTP连接
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        this.client.close();
        this.connected = false;
        this.client = null;
      } catch (error: any) {
        throw new TransportError(`断开FTP连接时出错: ${error.message}`, 'FTP_DISCONNECT_ERROR');
      }
    }
  }
  
  /**
   * 上传文件到FTP服务器
   */
  async upload(localPath: string, remotePath: string): Promise<TransportResult> {
    if (!this.client || !this.connected) {
      throw new TransportError('FTP客户端未连接', 'FTP_NOT_CONNECTED');
    }
    
    // 首先检查本地文件是否存在
    try {
      await fs.promises.access(localPath, fs.constants.F_OK);
    } catch (error: any) {
      throw new TransportError(`本地文件不存在: ${error.message}`, 'FTP_LOCAL_FILE_NOT_FOUND');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath).replace(/\\/g, '/');
    let retries = 0;
    let lastError: Error | null = null;
    const startTime = new Date();
    
    while (retries <= this.options.retryCount) {
      try {
        // 确保远程目录存在
        const remoteDir = path.dirname(fullRemotePath).replace(/\\/g, '/');
        await this.ensureRemoteDirectory(remoteDir);
        
        // 执行上传
        await this.client.uploadFrom(localPath, path.basename(fullRemotePath));
        
        // 上传成功
        return {
          success: true,
          filePath: localPath,
          remotePath: fullRemotePath,
          retries,
          startTime,
          endTime: new Date()
        };
      } catch (err) {
        const error = err as Error;
        lastError = error;
        retries++;
        
        // 如果还有重试机会，等待一段时间后重试
        if (retries <= this.options.retryCount) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // 所有重试都失败
    return {
      success: false,
      filePath: localPath,
      remotePath: fullRemotePath,
      retries,
      error: lastError ? lastError.message : '未知错误',
      startTime,
      endTime: new Date()
    };
  }
  
  /**
   * 批量上传文件
   */
  async uploadBatch(files: { localPath: string; remotePath: string }[]): Promise<TransportResult[]> {
    const results: TransportResult[] = [];
    
    for (const file of files) {
      const result = await this.upload(file.localPath, file.remotePath);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * 检查远程文件是否存在
   */
  async exists(remotePath: string): Promise<boolean> {
    if (!this.client || !this.connected) {
      throw new TransportError('FTP客户端未连接', 'FTP_NOT_CONNECTED');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath).replace(/\\/g, '/');
    
    try {
      // 获取文件列表
      const list = await this.client.list(path.dirname(fullRemotePath).replace(/\\/g, '/'));
      // 检查文件是否存在
      return list.some((item: { name: string }) => item.name === path.basename(fullRemotePath));
    } catch (error) {
      // 如果目录不存在或其他错误，返回false
      return false;
    }
  }
  
  /**
   * 确保远程目录存在
   */
  private async ensureRemoteDirectory(remotePath: string): Promise<void> {
    try {
      await this.client.ensureDir(remotePath);
    } catch (error: any) {
      throw new TransportError(`创建远程目录失败: ${error.message}`, 'FTP_MKDIR_ERROR');
    }
  }
}

/**
 * SFTP传输适配器实现
 */
export class SftpAdapter implements TransportAdapter {
  private options: TransportOptions;
  private client: any = null;
  private connected: boolean = false;
  
  constructor(options: TransportOptions) {
    this.options = options;
  }
  
  /**
   * 连接到SFTP服务器
   */
  async connect(): Promise<void> {
    try {
      // 动态导入以避免在不需要时加载依赖
      if (!SftpClient) {
        SftpClient = require('ssh2-sftp-client');
      }
      
      this.client = new SftpClient();
      
      // 连接到SFTP服务器
      await this.client.connect({
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        password: this.options.password,
        timeout: this.options.timeout,
        // 添加更多SSH选项以解决主机密钥验证问题
        algorithms: {
          serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']
        },
        hostVerifier: () => true, // 不验证主机密钥
        readyTimeout: 60000, // 增加准备超时时间到60秒
        keepaliveInterval: 10000, // 添加keepalive选项
        keepaliveCountMax: 3
      });
      
      this.connected = true;
    } catch (error: any) {
      this.connected = false;
      throw new TransportError(`无法连接到SFTP服务器: ${error.message}`, 'SFTP_CONNECTION_ERROR');
    }
  }
  
  /**
   * 断开SFTP连接
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.end();
        this.connected = false;
        this.client = null;
      } catch (error: any) {
        throw new TransportError(`断开SFTP连接时出错: ${error.message}`, 'SFTP_DISCONNECT_ERROR');
      }
    }
  }
  
  /**
   * 上传文件到SFTP服务器
   */
  async upload(localPath: string, remotePath: string): Promise<TransportResult> {
    if (!this.client || !this.connected) {
      throw new TransportError('SFTP客户端未连接', 'SFTP_NOT_CONNECTED');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath);
    let retries = 0;
    let lastError: Error | null = null;
    const startTime = new Date();
    
    while (retries <= this.options.retryCount) {
      try {
        // 确保远程目录存在
        const remoteDir = path.dirname(fullRemotePath);
        await this.ensureRemoteDirectory(remoteDir);
        
        // 执行上传
        await this.client.put(localPath, fullRemotePath);
        
        // 上传成功
        return {
          success: true,
          filePath: localPath,
          remotePath: fullRemotePath,
          retries,
          startTime,
          endTime: new Date()
        };
      } catch (err) {
        const error = err as Error;
        lastError = error;
        retries++;
        
        // 如果还有重试机会，等待一段时间后重试
        if (retries <= this.options.retryCount) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // 所有重试都失败
    return {
      success: false,
      filePath: localPath,
      remotePath: fullRemotePath,
      retries,
      error: lastError ? lastError.message : '未知错误',
      startTime,
      endTime: new Date()
    };
  }
  
  /**
   * 批量上传文件
   */
  async uploadBatch(files: { localPath: string; remotePath: string }[]): Promise<TransportResult[]> {
    const results: TransportResult[] = [];
    
    for (const file of files) {
      const result = await this.upload(file.localPath, file.remotePath);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * 检查远程文件是否存在
   */
  async exists(remotePath: string): Promise<boolean> {
    if (!this.client || !this.connected) {
      throw new TransportError('SFTP客户端未连接', 'SFTP_NOT_CONNECTED');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath);
    return this.client.exists(fullRemotePath);
  }
  
  /**
   * 确保远程目录存在
   */
  private async ensureRemoteDirectory(remotePath: string): Promise<void> {
    try {
      await this.client.mkdir(remotePath, true);
    } catch (error: any) {
      throw new TransportError(`创建远程目录失败: ${error.message}`, 'SFTP_MKDIR_ERROR');
    }
  }
}

/**
 * FTPS传输适配器实现 (FTP over SSL/TLS)
 */
export class FtpsAdapter implements TransportAdapter {
  private options: TransportOptions;
  private client: any = null;
  private connected: boolean = false;
  
  constructor(options: TransportOptions) {
    this.options = options;
  }
  
  /**
   * 连接到FTPS服务器
   */
  async connect(): Promise<void> {
    try {
      // 动态导入以避免在不需要时加载依赖
      if (!BasicFtpClient) {
        const basicFtp = require('basic-ftp');
        BasicFtpClient = basicFtp.Client;
      }
      
      this.client = new BasicFtpClient();
      
      // 可选的调试输出
      if (this.options.debug) {
        this.client.ftp.verbose = true;
      }
      
      // 设置连接超时
      if (this.options.timeout) {
        this.client.ftp.timeout = this.options.timeout;
      }
      
      // 连接到FTPS服务器
      await this.client.access({
        host: this.options.host,
        port: this.options.port,
        user: this.options.username,
        password: this.options.password,
        secure: true, // 启用FTPS
        secureOptions: {
          rejectUnauthorized: false // 不验证服务器证书
        }
      });
      
      // 如果远程根目录不是默认目录，则切换到指定目录
      if (this.options.remotePath && this.options.remotePath !== '/') {
        try {
          await this.client.ensureDir(this.options.remotePath);
        } catch (error: any) {
          throw new Error(`无法切换到指定的远程目录: ${error.message}`);
        }
      }
      
      this.connected = true;
    } catch (error: any) {
      this.connected = false;
      throw new TransportError(`无法连接到FTPS服务器: ${error.message}`, 'FTPS_CONNECTION_ERROR');
    }
  }
  
  /**
   * 断开FTPS连接
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        this.client.close();
        this.connected = false;
        this.client = null;
      } catch (error: any) {
        throw new TransportError(`断开FTPS连接时出错: ${error.message}`, 'FTPS_DISCONNECT_ERROR');
      }
    }
  }
  
  /**
   * 上传文件到FTPS服务器
   */
  async upload(localPath: string, remotePath: string): Promise<TransportResult> {
    if (!this.client || !this.connected) {
      throw new TransportError('FTPS客户端未连接', 'FTPS_NOT_CONNECTED');
    }
    
    // 首先检查本地文件是否存在
    try {
      await fs.promises.access(localPath, fs.constants.F_OK);
    } catch (error: any) {
      throw new TransportError(`本地文件不存在: ${error.message}`, 'FTPS_LOCAL_FILE_NOT_FOUND');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath).replace(/\\/g, '/');
    let retries = 0;
    let lastError: Error | null = null;
    const startTime = new Date();
    
    while (retries <= this.options.retryCount) {
      try {
        // 确保远程目录存在
        const remoteDir = path.dirname(fullRemotePath).replace(/\\/g, '/');
        await this.ensureRemoteDirectory(remoteDir);
        
        // 执行上传
        await this.client.uploadFrom(localPath, path.basename(fullRemotePath));
        
        // 上传成功
        return {
          success: true,
          filePath: localPath,
          remotePath: fullRemotePath,
          retries,
          startTime,
          endTime: new Date()
        };
      } catch (err) {
        const error = err as Error;
        lastError = error;
        retries++;
        
        // 如果还有重试机会，等待一段时间后重试
        if (retries <= this.options.retryCount) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // 所有重试都失败
    return {
      success: false,
      filePath: localPath,
      remotePath: fullRemotePath,
      retries,
      error: lastError ? lastError.message : '未知错误',
      startTime,
      endTime: new Date()
    };
  }
  
  /**
   * 批量上传文件
   */
  async uploadBatch(files: { localPath: string; remotePath: string }[]): Promise<TransportResult[]> {
    const results: TransportResult[] = [];
    
    for (const file of files) {
      const result = await this.upload(file.localPath, file.remotePath);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * 检查远程文件是否存在
   */
  async exists(remotePath: string): Promise<boolean> {
    if (!this.client || !this.connected) {
      throw new TransportError('FTPS客户端未连接', 'FTPS_NOT_CONNECTED');
    }
    
    const fullRemotePath = path.join(this.options.remotePath, remotePath).replace(/\\/g, '/');
    
    try {
      // 获取文件列表
      const list = await this.client.list(path.dirname(fullRemotePath).replace(/\\/g, '/'));
      // 检查文件是否存在
      return list.some((item: { name: string }) => item.name === path.basename(fullRemotePath));
    } catch (error) {
      // 如果目录不存在或其他错误，返回false
      return false;
    }
  }
  
  /**
   * 确保远程目录存在
   */
  private async ensureRemoteDirectory(remotePath: string): Promise<void> {
    try {
      await this.client.ensureDir(remotePath);
    } catch (error: any) {
      throw new TransportError(`创建远程目录失败: ${error.message}`, 'FTPS_MKDIR_ERROR');
    }
  }
}

/**
 * 传输文件到远程服务器
 * @param filePath 本地文件路径
 * @param remotePath 远程路径
 * @param options 传输选项
 * @returns 传输结果
 */
export async function transferFile(
  filePath: string,
  remotePath: string,
  options: TransportOptions
): Promise<TransportResult> {
  const startTime = new Date();
  
  // 检查传输功能是否启用
  if (!options.enabled) {
    return {
      success: false,
      filePath,
      remotePath,
      error: '传输功能未启用',
      startTime,
      endTime: new Date()
    };
  }
  
  let adapter: TransportAdapter | null = null;
  
  try {
    // 创建传输适配器
    adapter = createTransportAdapter(options);
    
    // 检查适配器是否创建成功
    if (!adapter) {
      return {
        success: false,
        filePath,
        remotePath,
        error: '无法创建传输适配器',
        startTime,
        endTime: new Date()
      };
    }
    
    // 连接到服务器
    await adapter.connect();
    
    // 确保远程目录存在
    try {
      // 获取远程目录路径
      const remoteDir = path.dirname(remotePath);
      if (remoteDir && remoteDir !== '.') {
        // 各适配器实现类中已经包含确保目录存在的逻辑，这里直接使用
        // 上传前，适配器会自动调用确保目录存在的方法
        console.log(`确保远程目录存在: ${remoteDir}`);
      }
    } catch (dirError: any) {
      console.warn(`检查远程目录时出现警告，但将继续尝试上传: ${dirError.message}`);
    }
    
    // 上传文件
    const result = await adapter.upload(filePath, remotePath);
    
    // 断开连接（忽略断开连接时可能发生的错误）
    try {
      await adapter.disconnect();
    } catch (error) {
      // 断开连接错误不影响上传结果
    }
    
    return result;
  } catch (error: any) {
    // 如果适配器已创建，尝试断开连接
    if (adapter) {
      try {
        await adapter.disconnect();
      } catch (disconnectError) {
        // 忽略断开连接时可能发生的错误
      }
    }
    
    // 返回错误结果
    return {
      success: false,
      filePath,
      remotePath,
      error: error.message || '传输过程中发生未知错误',
      startTime,
      endTime: new Date()
    };
  }
} 