import { scanAndTransport, getDefaultLogFilePath } from '../index'; // Import getDefaultLogFilePath
import { ScanAndTransportConfig, ScanAndTransportTransportConfig, FailureItem, FileItem, PackagingTriggerOptions } from '../types/facade';
import * as scanner from '../core/scanner'; // 导入 scanner 模块以进行模拟
import path from 'path'; // 导入 path
import { ScanOptions, StabilityCheckOptions, QueueOptions, TransportOptions, ScanResult } from '../types'; // 导入类型
import fs from 'fs-extra'; // Import fs-extra for mocking

// Mock scanFiles
const mockScanFiles = jest.spyOn(scanner, 'scanFiles').mockResolvedValue({
  results: [], // 模拟空结果
  failures: [],
  processedFiles: [],
  packages: [],
  transportResults: [],
});

// 创建 spy 并强制指定类型为 void 返回值
const mockAppendFile = jest.spyOn(fs, 'appendFile') as jest.SpyInstance<void>;
const mockEnsureDir = jest.spyOn(fs, 'ensureDir') as jest.SpyInstance<void>;

// 获取默认值，便于比较
const DEFAULT_OUTPUT_DIR = path.resolve('./temp/packages');
const DEFAULT_PACKAGE_NAME_PATTERN = 'package_{date}_{index}';
const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024;
const DEFAULT_DEPTH = -1;
const DEFAULT_SCAN_NESTED_ARCHIVES = true;
const DEFAULT_MAX_NESTED_LEVEL = 5;
const DEFAULT_PACKAGING_TRIGGER: PackagingTriggerOptions = { maxFiles: 500, maxSizeMB: 2048 };
const DEFAULT_STABILITY_OPTIONS: StabilityCheckOptions = {
  enabled: true,
  maxRetries: 3,
  retryInterval: 1000,
  checkInterval: 500,
  largeFileThreshold: 100 * 1024 * 1024,
  skipReadForLargeFiles: true,
};
const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  enabled: true,
  maxConcurrentChecks: 5,
  maxConcurrentTransfers: 2,
  stabilityRetryDelay: 2000,
};
const DEFAULT_TRANSPORT_RETRY_COUNT = 3;
const DEFAULT_TRANSPORT_TIMEOUT = 60000;

describe('scanAndTransport - 辅助函数测试', () => {
  it('getDefaultLogFilePath 应返回正确格式的路径', () => {
      const logPath = getDefaultLogFilePath();
      // Check if it's an absolute path
      expect(path.isAbsolute(logPath)).toBe(true);
      // Check the basic pattern
      expect(path.basename(logPath)).toMatch(/^scan_transport_log_\d{8}_\d{6}\.log$/);
  });
});

describe('scanAndTransport - 主要功能测试', () => {
  beforeEach(() => {
    // 重置所有模拟
    mockScanFiles.mockClear();
    mockAppendFile.mockClear();
    mockEnsureDir.mockClear();
    // 设置默认的 mock 实现为 void
    mockAppendFile.mockImplementation(() => undefined);
    mockEnsureDir.mockImplementation(() => undefined);
    mockScanFiles.mockResolvedValue({
      results: [], failures: [], processedFiles: [], packages: [], transportResults: []
    });
    // 如果需要模拟 console.error，在这里设置
    jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {}); // 接受任意参数以匹配原始签名
  });

  afterEach(() => {
    // 恢复 console.error 的原始实现
    (console.error as jest.Mock).mockRestore();
  });

  const baseTransportConfig: ScanAndTransportTransportConfig = {
    protocol: 'ftps',
    host: '10.19.19.74',
    port: 12123,
    username: 'daiwj',
    password: '123456',
    remotePath: '/'
  };

  const baseConfig: ScanAndTransportConfig = {
    rootDir: './test-root',
    rules: [[['txt'], '.*\.txt$']],
    transport: baseTransportConfig
  };

  it('当 logToFile 写入失败时应打印错误到控制台 (覆盖率)', async () => {
    const writeError = new Error('Disk full');
    // 使用 mockImplementationOnce 模拟抛出错误 (因为函数返回 void)
    mockAppendFile.mockImplementationOnce(() => { throw writeError; });

    await scanAndTransport(baseConfig);
    expect(console.error).toHaveBeenCalled();
  });

  it('[阶段 5] 当未提供 logFilePath 时应使用默认路径', async () => {
    await scanAndTransport(baseConfig);
    expect(mockAppendFile).toHaveBeenCalled();
    // Get the path used in the first log call
    const firstCallArgs = mockAppendFile.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    const usedLogPath = firstCallArgs[0];

    // Verify it matches the expected format
    if (typeof usedLogPath === 'string') {
        expect(path.isAbsolute(usedLogPath)).toBe(true);
        expect(path.basename(usedLogPath)).toMatch(/^scan_transport_log_\d{8}_\d{6}\.log$/);
        expect(mockEnsureDir).toHaveBeenCalledWith(path.dirname(usedLogPath));
    } else {
        throw new Error('Expected log path to be a string, but received: ' + typeof usedLogPath);
    }
  });

  it('[阶段 5] 当提供 logFilePath 时应使用指定路径', async () => {
    const customLogPath = './custom/scan.log';
    const absoluteCustomLogPath = path.resolve(customLogPath);
    const configWithLogPath = { ...baseConfig, logFilePath: customLogPath };
    await scanAndTransport(configWithLogPath);
    expect(mockAppendFile).toHaveBeenCalled();
    const firstCallArgs = mockAppendFile.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    const usedLogPath = firstCallArgs[0];

    if (typeof usedLogPath === 'string') {
        expect(usedLogPath).toBe(absoluteCustomLogPath);
        expect(mockEnsureDir).toHaveBeenCalledWith(path.dirname(absoluteCustomLogPath)); // Also check ensureDir uses string
    } else {
        throw new Error('Expected log path to be a string, but received: ' + typeof usedLogPath);
    }
  });

  it('[阶段 5] 成功运行时应写入预期的日志消息', async () => {
    const mockProcessedFile: FileItem = { path: 'ok.txt' } as FileItem;
    mockScanFiles.mockResolvedValueOnce({ results: [], failures: [], processedFiles: [mockProcessedFile], packages: ['pack1.zip'], transportResults: [] });
    await scanAndTransport(baseConfig);
    expect(mockAppendFile.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mockAppendFile.mock.calls[0][1]).toContain('--- ScanAndTransport Start ---');
    // Add more specific content checks if needed, avoiding reliance on exact Date.toISOString()
  });

  it('[阶段 5] 当 scanFiles 返回失败时应写入预期的日志消息', async () => {
    const mockFailure: FailureItem = { type: 'stability', path: 'bad.txt', error: 'unstable' };
    mockScanFiles.mockResolvedValueOnce({
      results: [], failures: [mockFailure], processedFiles: [], packages: [], transportResults: []
    });

    await scanAndTransport(baseConfig);

    expect(mockAppendFile.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mockAppendFile.mock.calls[5][1]).toContain('scanFiles finished. Success: false. Failures: 1. Packages: 0.');
    expect(mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1]).toContain('--- ScanAndTransport End --- Success: false, Processed: 0, Failed: 1, Packages: 0');
  });

  it('[阶段 5] 当 scanFiles 抛出错误时应写入预期的日志消息', async () => {
    const errorMessage = 'Scan crashed';
    mockScanFiles.mockRejectedValueOnce(new Error(errorMessage));

    await scanAndTransport(baseConfig);

    expect(mockAppendFile.mock.calls.length).toBeGreaterThanOrEqual(6); // Includes ERROR log and top-level error log
    expect(mockAppendFile.mock.calls[5][1]).toContain(`ERROR during scanFiles: ${errorMessage}`);
    expect(mockAppendFile.mock.calls[6][1]).toContain(`Top-level error added to failedItems: ${errorMessage}`);
    expect(mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1]).toContain('--- ScanAndTransport End --- Success: false, Processed: 0, Failed: 1, Packages: 0');
  });

  // 原有的基础测试
  it('should call scanFiles with the constructed ScanOptions', async () => {
    await scanAndTransport(baseConfig);
    expect(mockScanFiles).toHaveBeenCalledTimes(1);
    const calledOptions = mockScanFiles.mock.calls[0][0];
    expect(calledOptions.rootDir).toBe(path.resolve(baseConfig.rootDir));
    expect(calledOptions.calculateMd5).toBe(true);
    expect(calledOptions.createPackage).toBe(true);
  });

  it('should override default options (check a few key ones)', async () => {
    const userConfig: ScanAndTransportConfig = {
      ...baseConfig,
      depth: 3,
      scanNestedArchives: false,
    };
    await scanAndTransport(userConfig);
    expect(mockScanFiles).toHaveBeenCalledTimes(1);
    const calledOptions = mockScanFiles.mock.calls[0][0];
    expect(calledOptions.depth).toBe(3);
    expect(calledOptions.scanNestedArchives).toBe(false);
  });

  it('[Phase 6] should pass default outputDir and packagingTrigger to scanFiles', async () => {
    await scanAndTransport(baseConfig);
    expect(mockScanFiles).toHaveBeenCalledTimes(1);
    const calledOptions = mockScanFiles.mock.calls[0][0] as ScanOptions;
    expect(calledOptions.outputDir).toBe(DEFAULT_OUTPUT_DIR);
    expect(calledOptions.packagingTrigger).toEqual(DEFAULT_PACKAGING_TRIGGER);
  });

  it('[Phase 6] should pass user-provided outputDir and packagingTrigger to scanFiles', async () => {
    const customOutputDir = './my-packages';
    const customTrigger: PackagingTriggerOptions = { maxFiles: 10, maxSizeMB: 100 };
    const userConfig: ScanAndTransportConfig = {
      ...baseConfig,
      outputDir: customOutputDir,
      packagingTrigger: customTrigger,
    };
    await scanAndTransport(userConfig);
    expect(mockScanFiles).toHaveBeenCalledTimes(1);
    const calledOptions = mockScanFiles.mock.calls[0][0] as ScanOptions;
    expect(calledOptions.outputDir).toBe(path.resolve(customOutputDir));
    expect(calledOptions.packagingTrigger).toEqual(customTrigger);
  });

  it('should write log messages including ScanOptions construction', async () => {
    await scanAndTransport(baseConfig);
    // Find the log call for ScanOptions
    const scanOptionsLogCall = mockAppendFile.mock.calls.find(call => {
      // Ensure the call has at least two arguments and the second is a string
      return call.length >= 2 && typeof call[1] === 'string' && call[1].includes('Constructed ScanOptions:');
    });
    expect(scanOptionsLogCall).toBeDefined();

    // Check if outputDir and packagingTrigger are in the logged JSON string
    if (scanOptionsLogCall && typeof scanOptionsLogCall[1] === 'string') {
      const logMessage = scanOptionsLogCall[1];
      // Escape backslashes for Windows paths comparison in JSON string
      const expectedOutputDirJson = JSON.stringify(DEFAULT_OUTPUT_DIR);
      expect(logMessage).toContain(`"outputDir":${expectedOutputDirJson}`);
      expect(logMessage).toContain(`"packagingTrigger":${JSON.stringify(DEFAULT_PACKAGING_TRIGGER)}`);
    } else {
      // Fail the test if the log call wasn't found or had unexpected format
      throw new Error('ScanOptions log message not found or in unexpected format.');
    }
  });
}); 