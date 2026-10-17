/**
 * Tạo test suite kiểm tra:
 *  Header Propagation: Tự động gắn x-trace-id và x-building-id từ RequestContextService
 *  Centralized Retry & Jitter: Tự động thử lại khi API ngoại vi trả về HTTP 503
 *  mTLS Agent Setup: Khởi tạo https.Agent với chứng chỉ hợp lệ
 * 
 * */ 

import { AppHttpClient } from './client/app-http.client';
import { maskUrl } from './interceptors/http-logger.interceptor';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import { SYSTEM_HEADERS } from '../../common/constants/headers.constant';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HttpClientModule (Enterprise HTTP & mTLS Suite)', () => {
  let httpClient: AppHttpClient;
  let contextService: RequestContextService;
  let logger: jest.Mocked<AppLoggerService>;

  beforeEach(() => {
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-FWD-999');
    jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_tokyo');

    logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<AppLoggerService>;

    httpClient = new AppHttpClient(contextService, logger);
  });

  it('should automatically propagate traceId and tenantId into request headers', async () => {
    const requestInterceptorCallbacks: any[] = [];

    const mockAxiosInstance: any = {
      interceptors: {
        request: {
          use: jest.fn().mockImplementation((fn) => requestInterceptorCallbacks.push(fn)),
        },
        response: { use: jest.fn() },
      },
      get: jest.fn(),
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    httpClient.createInstance();

    // Giả lập cấu hình request đi qua Interceptor
    const initialConfig: any = {
      url: 'https://api.landlord.com/v1/rooms',
      method: 'get',
      headers: new Map(),
    };
    initialConfig.headers.set = (k: string, v: string) => {
      initialConfig.headers[k] = v;
    };

    const transformedConfig = requestInterceptorCallbacks[0](initialConfig);

    expect(transformedConfig.headers[SYSTEM_HEADERS.TRACE_ID]).toBe('TRACE-FWD-999');
    expect(transformedConfig.headers[SYSTEM_HEADERS.BUILDING_ID]).toBe('tenant_tokyo');
  });

  it('should retry requests when encountering retryable status code (503 Service Unavailable)', async () => {
    let responseErrorHandler: any;

    const mockAxiosInstance: any = jest.fn();
    mockAxiosInstance.interceptors = {
      request: { use: jest.fn() },
      response: {
        use: jest.fn().mockImplementation((_success, errFn) => {
          responseErrorHandler = errFn;
        }),
      },
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    httpClient.createInstance();

    const mockError: any = {
      config: { url: 'https://partner.payment.com/pay', _retryCount: 0 },
      response: { status: 503 },
      message: 'Service Unavailable',
    };

    // Khi retry, instance Axios sẽ được gọi lại
    mockAxiosInstance.mockResolvedValue({ data: { success: true } });

    const retryPromise = responseErrorHandler(mockError);
    const result = await retryPromise;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[HttpClient Retry] Attempt 1/3'),
      AppHttpClient.name,
    );
    expect(result).toEqual({ data: { success: true } });
  });

  it('should NOT retry a non-idempotent POST without an Idempotency-Key (avoid double charging)', async () => {
    let responseErrorHandler: any;
    const mockAxiosInstance: any = jest.fn();
    mockAxiosInstance.interceptors = {
      request: { use: jest.fn() },
      response: { use: jest.fn().mockImplementation((_ok, errFn) => (responseErrorHandler = errFn)) },
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    httpClient.createInstance();

    const postError: any = {
      config: { url: 'https://partner.payment.com/charge', method: 'post', headers: { get: () => undefined } },
      response: { status: 503 },
      message: 'Service Unavailable',
    };

    await expect(responseErrorHandler(postError)).rejects.toBe(postError);
    expect(mockAxiosInstance).not.toHaveBeenCalled();
  });

  it('should mask sensitive query parameters before logging URLs (PCI-DSS)', () => {
    expect(maskUrl('https://einvoice.example.com/invoiceNo?apiKey=abc123&invoiceNo=AB12CD&signature=xyz')).toBe(
      'https://einvoice.example.com/invoiceNo?apiKey=%5BREDACTED%5D&invoiceNo=AB12CD&signature=%5BREDACTED%5D',
    );
    expect(maskUrl('/v1/payments?otp=123456', 'https://bank.example.com')).toContain('otp=%5BREDACTED%5D');
    expect(maskUrl('https://api.telegram.org/bot123456:AAH-secret_Token/sendMessage')).toBe(
      'https://api.telegram.org/bot[REDACTED]/sendMessage',
    );
  });
});

// npx jest src/infrastructure/http/http.spec.ts