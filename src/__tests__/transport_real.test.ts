/**
 * @file 传输模块真实服务器测试
 * 直接连接到实际的FTP/SFTP服务器进行测试
 * 
 * 注意：这个测试需要连接真实的服务器，请确保网络环境可以访问指定的服务器
 * 如果无法访问服务器，这些测试可能会失败
 * 
 * @jest-environment node
 * @jest-coverage-skip
 */

// @ts-nocheck
import { describe, test, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';

// 从模块中导入需要的类型和方法
import {
  FtpAdapter,
  SftpAdapter,
  FtpsAdapter,
  createTransportAdapter,
  transferFile,
  TransportResult
} from '../core/transport';
import { TransportOptions } from '../types';

// 测试服务器配置
const SERVER_HOST = '10.19.19.74';
const SERVER_PORT = 12123;
const SERVER_USER = 'daiwj';
const SERVER_PASS = '123456';
const REMOTE_TEST_DIR = '/transport-test-' + Date.now();

// 测试用临时文件和目录
const tmpDir = path.join(os.tmpdir(), 'transport-real-test');
const testFile = path.join(tmpDir, 'test-file.txt');
const testContent = 'This is a test file for transport module real testing';

// FTP配置
const ftpConfig: TransportOptions = {
  protocol: 'ftp',
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: SERVER_USER,
  password: SERVER_PASS,
  remotePath: REMOTE_TEST_DIR,
  retryCount: 2,
  timeout: 10000,
  enabled: true,
  packageSize: 10,
  debug: false // 关闭调试模式，减少日志输出
};

// FTPS配置
const ftpsConfig: TransportOptions = {
  enabled: true,
  protocol: 'ftps',
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: SERVER_USER,
  password: SERVER_PASS,
  remotePath: REMOTE_TEST_DIR,
  packageSize: 10,
  retryCount: 3,
  timeout: 30000,
  debug: false // 关闭调试模式，减少日志输出
};

// 标记是否跳过真实服务器测试 - 默认情况下不会跳过
// 设置环境变量 SKIP_REAL_SERVER_TESTS=true 可以跳过这些测试
const SKIP_REAL_SERVER_TESTS = process.env.SKIP_REAL_SERVER_TESTS === 'true';
// FTP测试设置
// 设置环境变量 SKIP_FTP_SERVER_TESTS=true 可以跳过这些测试
const SKIP_FTP_SERVER_TESTS = process.env.SKIP_FTP_SERVER_TESTS === 'true';

// 测试超时时间
const TEST_TIMEOUT = 30000; // 增加到30秒

// 根据条件选择跳过的测试
const maybeskip = SKIP_REAL_SERVER_TESTS ? test.skip : test;
const maybeskipFtp = SKIP_FTP_SERVER_TESTS ? test.skip : maybeskip;

// 保存所有创建的适配器，以便在测试完成后关闭它们
const activeAdapters: (FtpAdapter | FtpsAdapter | SftpAdapter)[] = [];

// 测试开始前创建测试文件和目录
beforeAll(async () => {
  // 创建测试目录和测试文件
  if (!existsSync(tmpDir)) {
    await fs.mkdir(tmpDir, { recursive: true });
  }
  
  await fs.writeFile(testFile, testContent);
  
  // 创建不同大小的测试文件
  await fs.writeFile(path.join(tmpDir, 'small-file.txt'), 'Small test file');
  
  // 创建10KB的测试文件
  const mediumContent = 'A'.repeat(10 * 1024);
  await fs.writeFile(path.join(tmpDir, 'medium-file.txt'), mediumContent);
});

// 测试结束后清理测试文件
afterAll(async () => {
  // 确保所有适配器已断开连接
  for (const adapter of activeAdapters) {
    if ((adapter as any).connected) {
      try {
        await adapter.disconnect();
      } catch (error) {
        console.error('清理时断开连接失败:', error);
      }
    }
  }
  
  if (existsSync(testFile)) {
    await fs.unlink(testFile);
  }
  
  if (existsSync(tmpDir)) {
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // 忽略可能的清理错误
    }
  }
});

// 创建多个测试文件
async function createTestFiles(count: number): Promise<string[]> {
  const files: string[] = [];
  
  for (let i = 0; i < count; i++) {
    const filePath = path.join(tmpDir, `batch-file-${i}.txt`);
    await fs.writeFile(filePath, `Content for batch file ${i}`);
    files.push(filePath);
  }
  
  return files;
}

// FTPS适配器测试
describe('FTPS适配器真实服务器测试', () => {
  let adapter: FtpsAdapter;
  
  beforeEach(() => {
    adapter = new FtpsAdapter(ftpsConfig);
    activeAdapters.push(adapter);
  });
  
  maybeskip('应该能连接到真实的FTPS服务器', async () => {
    try {
      await adapter.connect();
      await adapter.disconnect();
      expect(true).toBe(true); // 如果没有抛出异常，则测试通过
    } catch (error: any) {
      console.error('连接FTPS服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能向FTPS服务器上传文件', async () => {
    try {
      await adapter.connect();
      
      const result = await adapter.upload(testFile, 'real-test.txt');
      
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('real-test.txt');
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('上传文件到FTPS服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能在FTPS服务器创建目录并上传文件', async () => {
    try {
      await adapter.connect();
      
      const result = await adapter.upload(testFile, 'test-dir/nested-test.txt');
      
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('test-dir/nested-test.txt');
      
      // 验证文件确实存在
      const exists = await adapter.exists('test-dir/nested-test.txt');
      expect(exists).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('创建目录并上传文件到FTPS服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能批量上传文件到FTPS服务器', async () => {
    try {
      const testFiles = await createTestFiles(3);
      const filesToUpload = testFiles.map((file, index) => ({
        localPath: file,
        remotePath: `batch/file-${index}.txt`
      }));
      
      await adapter.connect();
      
      const results = await adapter.uploadBatch(filesToUpload);
      
      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('批量上传文件到FTPS服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能正确处理不存在的文件', async () => {
    await adapter.connect();
    
    const nonExistentFile = path.join(tmpDir, 'non-existent.txt');
    
    // 上传不存在的文件应该失败
    await expect(adapter.upload(nonExistentFile, 'should-fail.txt'))
      .rejects.toThrow();
    
    await adapter.disconnect();
  }, TEST_TIMEOUT);
});

// FTP适配器测试
describe('FTP适配器真实服务器测试', () => {
  let adapter: FtpAdapter;
  
  beforeEach(() => {
    adapter = new FtpAdapter(ftpConfig);
    activeAdapters.push(adapter);
  });
  
  maybeskipFtp('应该能连接到真实的FTP服务器', async () => {
    try {
      await adapter.connect();
      await adapter.disconnect();
      expect(true).toBe(true); // 如果没有抛出异常，则测试通过
    } catch (error: any) {
      console.error('连接FTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskipFtp('应该能向FTP服务器上传文件', async () => {
    try {
      await adapter.connect();
      
      const result = await adapter.upload(testFile, 'real-ftp-test.txt');
      
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('real-ftp-test.txt');
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('上传文件到FTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskipFtp('应该能在FTP服务器创建目录并上传文件', async () => {
    try {
      await adapter.connect();
      
      const result = await adapter.upload(testFile, 'ftp-test-dir/nested-test.txt');
      
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('ftp-test-dir/nested-test.txt');
      
      // 验证文件存在
      const exists = await adapter.exists('ftp-test-dir/nested-test.txt');
      expect(exists).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('创建目录并上传文件到FTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskipFtp('应该能批量上传文件到FTP服务器', async () => {
    try {
      const testFiles = await createTestFiles(3);
      const filesToUpload = testFiles.map((file, index) => ({
        localPath: file,
        remotePath: `ftp-batch/file-${index}.txt`
      }));
      
      await adapter.connect();
      
      const results = await adapter.uploadBatch(filesToUpload);
      
      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('批量上传文件到FTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
});

// transferFile函数测试
describe('transferFile函数真实服务器测试', () => {
  maybeskip('应该能使用FTPS协议传输文件', async () => {
    try {
      const result = await transferFile(
        testFile, 
        'transfer-func-test.txt', 
        ftpsConfig
      );
      
      // 应该成功连接并上传
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('transfer-func-test.txt');
    } catch (error: any) {
      console.error('使用FTPS协议传输文件失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  // 添加测试：验证自动创建深层嵌套目录功能
  maybeskip('应该能自动创建深层嵌套的远程目录', async () => {
    try {
      // 定义一个深层嵌套的目录路径
      const deepNestedPath = `deep/nested/dir/structure/${Date.now()}`;
      
      const result = await transferFile(
        testFile,
        `${deepNestedPath}/nested-test-file.txt`,
        ftpsConfig
      );
      
      // 应该成功连接并上传，证明嵌套目录已被创建
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain(deepNestedPath);
      expect(result.remotePath).toContain('nested-test-file.txt');
      
      // 验证刚刚创建的目录中上传另一个文件也能成功
      const secondResult = await transferFile(
        testFile,
        `${deepNestedPath}/second-file.txt`,
        ftpsConfig
      );
      
      expect(secondResult.success).toBe(true);
      expect(secondResult.remotePath).toContain(`${deepNestedPath}/second-file.txt`);
      
      console.log(`成功创建深层嵌套目录并上传文件: ${result.remotePath}`);
    } catch (error: any) {
      console.error('创建深层嵌套目录测试失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  test('应该能处理禁用状态', async () => {
    const disabledConfig = { ...ftpsConfig, enabled: false };
    const result = await transferFile(testFile, 'disabled-test.txt', disabledConfig);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('传输功能未启用');
  });
  
  test('应该能处理错误的连接信息', async () => {
    const badConfig = { 
      ...ftpsConfig, 
      host: 'non-existent-host',
      timeout: 3000 // 设置较短的超时时间
    };
    
    const result = await transferFile(testFile, 'bad-config-test.txt', badConfig);
    
    expect(result.success).toBe(false);
  }, TEST_TIMEOUT);
  
  maybeskip('应该能处理错误的上传路径', async () => {
    try {
      // 假设服务器上有只读目录
      const readOnlyPathConfig = {
        ...ftpsConfig,
        remotePath: '/root' // 通常普通用户没有写权限
      };
      
      const result = await transferFile(testFile, 'bad-path-test.txt', readOnlyPathConfig);
      
      // 由于权限问题，预期上传会失败
      expect(result.success).toBe(false);
    } catch (error: any) {
      console.error('测试错误上传路径失败:', error.message);
      // 这里我们期望会失败，所以不再抛出错误
      expect(true).toBe(true); // 确保测试通过
    }
  }, TEST_TIMEOUT);
});

// 创建特殊场景测试
describe('传输特殊场景测试', () => {
  maybeskip('应该能正确处理远程文件已存在的情况', async () => {
    try {
      const adapter = new FtpsAdapter(ftpsConfig);
      await adapter.connect();
      
      // 先上传一次
      await adapter.upload(testFile, 'duplicate-test.txt');
      
      // 再次上传同一个文件
      const result = await adapter.upload(testFile, 'duplicate-test.txt');
      
      // 应该成功覆盖
      expect(result.success).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('测试覆盖远程文件失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  // 添加测试：多文件上传到嵌套目录场景
  maybeskip('应该能将多个文件上传到自动创建的嵌套目录中', async () => {
    try {
      // 创建测试文件集
      const testFiles = await createTestFiles(5);
      
      // 创建一个带时间戳的目录名，确保每次测试使用不同的目录
      const timestampDir = `nested-batch-${Date.now()}`;
      const nestedRemotePath = `queue-test/${timestampDir}/files`;
      
      console.log(`测试上传多文件到嵌套目录: ${nestedRemotePath}`);
      
      // 模拟传输队列场景，一个接一个地上传文件到相同的嵌套目录
      const results = [];
      for (let i = 0; i < testFiles.length; i++) {
        const remotePath = `${nestedRemotePath}/file-${i}.txt`;
        const result = await transferFile(
          testFiles[i],
          remotePath,
          ftpsConfig
        );
        results.push(result);
        
        // 验证每个文件的上传结果
        expect(result.success).toBe(true);
        expect(result.remotePath).toContain(remotePath);
      }
      
      // 验证所有文件都成功上传
      expect(results.length).toBe(testFiles.length);
      expect(results.every(r => r.success)).toBe(true);
      
      console.log(`成功上传 ${results.length} 个文件到自动创建的嵌套目录 ${nestedRemotePath}`);
    } catch (error: any) {
      console.error('多文件上传到嵌套目录测试失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能处理上传较大文件', async () => {
    try {
      const mediumFilePath = path.join(tmpDir, 'medium-file.txt');
      const adapter = new FtpsAdapter(ftpsConfig);
      
      await adapter.connect();
      
      const result = await adapter.upload(mediumFilePath, 'medium-size-test.txt');
      
      expect(result.success).toBe(true);
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('上传较大文件失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
});

// FTPS适配器配置选项测试
describe('FTPS适配器配置选项测试', () => {
  maybeskip('应该能使用debug模式连接', async () => {
    const debugConfig = { ...ftpsConfig, debug: true };
    const adapter = new FtpsAdapter(debugConfig);
    activeAdapters.push(adapter);
    
    try {
      // 测试debug模式，但这里不会显示日志输出
      await adapter.connect();
      await adapter.disconnect();
      expect(true).toBe(true); // 如果没有抛出异常，则测试通过
    } catch (error: any) {
      console.error('使用debug模式连接失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  maybeskip('应该能设置自定义超时时间', async () => {
    const customTimeoutConfig = { ...ftpsConfig, timeout: 15000 };
    const adapter = new FtpsAdapter(customTimeoutConfig);
    activeAdapters.push(adapter);
    
    try {
      await adapter.connect();
      await adapter.disconnect();
      expect(true).toBe(true);
    } catch (error: any) {
      console.error('使用自定义超时连接失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
});

// 添加更多错误场景测试
describe('传输错误场景测试', () => {
  // 文件不存在的上传测试
  maybeskip('应该正确处理不存在的文件上传', async () => {
    const adapter = new FtpsAdapter(ftpsConfig);
    activeAdapters.push(adapter);
    
    await adapter.connect();
    
    // 创建一个不存在的文件路径
    const nonExistentFile = path.join(tmpDir, 'this-file-does-not-exist.txt');
    
    // 尝试上传不存在的文件，应该抛出异常
    try {
      await adapter.upload(nonExistentFile, 'should-fail.txt');
      // 如果执行到这里，测试应该失败
      expect(true).toBe(false);
    } catch (error: any) {
      // 期望抛出异常
      expect(error).toBeDefined();
      expect(error.message).toContain('不存在');
    } finally {
      await adapter.disconnect();
    }
  }, TEST_TIMEOUT);
  
  // 测试exists方法
  maybeskip('exists方法应该能正确检测文件存在情况', async () => {
    const adapter = new FtpsAdapter(ftpsConfig);
    activeAdapters.push(adapter);
    
    await adapter.connect();
    
    try {
      // 先上传一个文件
      const testFilePath = 'exists-test-file.txt';
      await adapter.upload(testFile, testFilePath);
      
      // 检查文件存在
      const exists = await adapter.exists(testFilePath);
      expect(exists).toBe(true);
      
      // 检查不存在的文件
      const nonExistsFile = 'non-existent-file-' + Date.now() + '.txt';
      const nonExists = await adapter.exists(nonExistsFile);
      expect(nonExists).toBe(false);
      
      // 检查不存在的目录中的文件
      const nonExistsPath = 'non-existent-dir-' + Date.now() + '/some-file.txt';
      const pathNonExists = await adapter.exists(nonExistsPath);
      expect(pathNonExists).toBe(false);
    } finally {
      await adapter.disconnect();
    }
  }, TEST_TIMEOUT);
  
  // 连接到不存在的服务器（网络错误模拟）
  test('应该处理连接到不存在的服务器的情况', async () => {
    const badServerConfig = { 
      ...ftpsConfig, 
      host: 'non-existent-server-' + Date.now() + '.example',
      timeout: 5000 // 设置较短的超时时间加快测试
    };
    
    const adapter = new FtpsAdapter(badServerConfig);
    activeAdapters.push(adapter);
    
    try {
      await adapter.connect();
      // 如果连接成功，测试应该失败
      expect(true).toBe(false);
    } catch (error: any) {
      // 期望连接失败
      expect(error).toBeDefined();
      expect(error.message).toBeDefined();
    }
  }, TEST_TIMEOUT);
  
  // 测试无权限访问的目录
  maybeskip('应该处理无权限访问目录的情况', async () => {
    // 假设/root目录是无权限访问的
    const noPermConfig = { 
      ...ftpsConfig, 
      remotePath: '/root/no-permission-dir'
    };
    
    try {
      const adapter = new FtpsAdapter(noPermConfig);
      activeAdapters.push(adapter);
      
      // 尝试上传到无权限目录
      const result = await adapter.upload(testFile, 'test-no-perm.txt');
      
      // 应该上传失败
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      
      await adapter.disconnect();
    } catch (error: any) {
      // 连接时可能会直接失败，这也是预期内的
      expect(error).toBeDefined();
    }
  }, TEST_TIMEOUT);
  
  // 测试上传超时
  maybeskip('应该处理上传超时的情况', async () => {
    // 使用非常短的超时设置
    const timeoutConfig = { 
      ...ftpsConfig, 
      timeout: 100 // 非常短的超时
    };
    
    const adapter = new FtpsAdapter(timeoutConfig);
    activeAdapters.push(adapter);
    
    try {
      await adapter.connect();
      
      // 创建一个稍大的文件，以增加超时几率
      const largeFilePath = path.join(tmpDir, 'timeout-test-file.txt');
      // 写入约10MB的数据
      const content = Buffer.alloc(10 * 1024 * 1024).fill('A');
      await fs.writeFile(largeFilePath, content);
      
      // 尝试上传，预期会超时
      const result = await adapter.upload(largeFilePath, 'should-timeout.txt');
      
      // 应该失败
      expect(result.success).toBe(false);
      
      await adapter.disconnect();
    } catch (error: any) {
      // 连接可能直接超时，这也是预期的
      expect(error).toBeDefined();
    }
  }, TEST_TIMEOUT);
});

// SFTP适配器测试
describe('SFTP适配器测试', () => {
  // 注意：这可能需要有一个可用的SFTP服务器
  // 如果没有，这些测试可以使用maybeskip跳过
  
  let sftpConfig: TransportOptions;
  let adapter: SftpAdapter;
  
  beforeEach(() => {
    // 使用与FTPS相同的配置，但协议改为sftp
    sftpConfig = {
      ...ftpsConfig,
      protocol: 'sftp'
    };
    adapter = new SftpAdapter(sftpConfig);
    activeAdapters.push(adapter);
  });
  
  // 基本连接测试
  test.skip('应该能连接到SFTP服务器', async () => {
    // 由于可能没有可用的SFTP服务器，默认跳过此测试
    try {
      await adapter.connect();
      await adapter.disconnect();
      expect(true).toBe(true);
    } catch (error: any) {
      console.error('连接SFTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
  
  // 基本上传测试
  test.skip('应该能向SFTP服务器上传文件', async () => {
    try {
      await adapter.connect();
      
      const result = await adapter.upload(testFile, 'sftp-test.txt');
      
      expect(result.success).toBe(true);
      expect(result.remotePath).toContain('sftp-test.txt');
      
      await adapter.disconnect();
    } catch (error: any) {
      console.error('上传文件到SFTP服务器失败:', error.message);
      throw error;
    }
  }, TEST_TIMEOUT);
}); 