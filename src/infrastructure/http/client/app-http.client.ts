/**
 * Dịch vụ giao tiếp HTTP chuẩn doanh nghiệp:
 *  - Tái sử dụng axios instance + keep-alive agent (mỗi danh tính mTLS một instance) thay vì tạo mới mỗi lời gọi.
 *  - Lan truyền header truy vết (x-trace-id, W3C traceparent), timeout nghiêm ngặt (HTTP_CLIENT_TIMEOUT_MS).
 *  - Ghi log đã che giấu PII.
 *  - Retry Exponential Backoff + Full Jitter cho lỗi tạm thời, CHỈ với request an toàn để lặp lại
 *    (idempotent method hoặc có Idempotency-Key), tôn trọng header Retry-After.
 */

import { Injectable, Optional } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { createHash } from 'crypto';
import { Agent as HttpsAgent } from 'https';
import { Agent as HttpAgent } from 'http';
import { EnterpriseHttpOptions, RequestRuntimeState, RetryConfig } from '../interfaces/http-client.interface';
import { RequestContextService } from '../../../core/context/request-context.service';
import { AppLoggerService } from '../../../core/logger/app-logger.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { MtlsAgentFactory } from '../security/mtls-agent.factory';
import { createTracePropagationInterceptor } from '../interceptors/trace-propagation.interceptor';
import { createHttpLoggerInterceptors, maskUrl } from '../interceptors/http-logger.interceptor';
import { SYSTEM_HEADERS } from '../../../common/constants/headers.constant';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);
const MAX_RETRY_AFTER_MS = 30_000;
const CONTEXT = 'AppHttpClient';

type RuntimeConfig = InternalAxiosRequestConfig & RequestRuntimeState;

@Injectable()
export class AppHttpClient {
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetryConfig: RetryConfig;
  private readonly sharedInstances = new Map<string, AxiosInstance>();
  private readonly keepAliveHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 100 });
  private readonly keepAliveHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 100 });

  constructor(
    private readonly contextService: RequestContextService,
    private readonly appLogger: AppLoggerService,
    @Optional() config?: AppConfigService,
  ) {
    this.defaultTimeoutMs = config?.httpClient.timeoutMs ?? 15000;
    this.defaultRetryConfig = {
      maxRetries: config?.httpClient.maxRetries ?? 3,
      initialDelayMs: 300,
      maxDelayMs: 2000,
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    };
  }

  /**
   * Tạo một instance Axios được bọc toàn diện các interceptors chuẩn hóa
   * (dành cho adapter đối tác cần baseURL / header cố định riêng).
   */
  createInstance(defaultOptions: EnterpriseHttpOptions = {}): AxiosInstance {
    const { mtls, retry, skipTracePropagation, ...axiosConfig } = defaultOptions;

    const instance = axios.create({
      timeout: this.defaultTimeoutMs,
      httpAgent: this.keepAliveHttpAgent,
      httpsAgent: mtls ? MtlsAgentFactory.createAgent(mtls) : this.keepAliveHttpsAgent,
      ...axiosConfig,
    });

    const logging = createHttpLoggerInterceptors(this.appLogger);
    if (!skipTracePropagation) {
      instance.interceptors.request.use(createTracePropagationInterceptor(this.contextService));
    }
    instance.interceptors.request.use(logging.onRequest);
    instance.interceptors.response.use(logging.onResponse, (error: AxiosError) =>
      this.handleAxiosErrorWithRetry(error, instance, retry),
    );

    return instance;
  }

  // Tiện ích gọi nhanh (Shortcut methods) dùng instance chia sẻ (keep-alive)
  async get<T>(url: string, options?: EnterpriseHttpOptions): Promise<T> {
    return this.request<T>({ ...options, url, method: 'GET' });
  }

  async post<T>(url: string, data?: unknown, options?: EnterpriseHttpOptions): Promise<T> {
    return this.request<T>({ ...options, url, data, method: 'POST' });
  }

  async put<T>(url: string, data?: unknown, options?: EnterpriseHttpOptions): Promise<T> {
    return this.request<T>({ ...options, url, data, method: 'PUT' });
  }

  async patch<T>(url: string, data?: unknown, options?: EnterpriseHttpOptions): Promise<T> {
    return this.request<T>({ ...options, url, data, method: 'PATCH' });
  }

  async delete<T>(url: string, options?: EnterpriseHttpOptions): Promise<T> {
    return this.request<T>({ ...options, url, method: 'DELETE' });
  }

  async request<T>(options: EnterpriseHttpOptions): Promise<T> {
    const { mtls, retry, skipTracePropagation, ...axiosConfig } = options;
    const instance = this.getSharedInstance(mtls, skipTracePropagation);
    // Chính sách retry theo từng request được đọc lại trong interceptor lỗi
    const response = await instance.request<T>({ ...axiosConfig, retry } as AxiosRequestConfig);
    return response.data;
  }

  private getSharedInstance(mtls: EnterpriseHttpOptions['mtls'], skipTracePropagation?: boolean): AxiosInstance {
    const identity = mtls
      ? createHash('sha256').update(JSON.stringify([mtls.cert, mtls.key, mtls.ca, mtls.passphrase])).digest('hex')
      : 'default';
    const cacheKey = `${identity}:${skipTracePropagation ? 'notrace' : 'trace'}`;

    let instance = this.sharedInstances.get(cacheKey);
    if (!instance) {
      instance = this.createInstance({ mtls, skipTracePropagation });
      this.sharedInstances.set(cacheKey, instance);
    }
    return instance;
  }

  /**
   * Xử lý lỗi và tự động thực thi Exponential Backoff Retry với Full Jitter
   */
  private async handleAxiosErrorWithRetry(
    error: AxiosError,
    instance: AxiosInstance,
    instanceRetry?: RetryConfig,
  ): Promise<any> {
    const config = error.config as RuntimeConfig | undefined;
    if (!config) {
      return Promise.reject(error);
    }

    const retryPolicy = config.retry ?? instanceRetry ?? this.defaultRetryConfig;
    config._retryCount = config._retryCount || 0;

    const status = error.response?.status;
    const isNetworkError = !error.response && Boolean(error.code);
    const isRetryableStatus = status ? (retryPolicy.retryableStatuses?.includes(status) ?? false) : false;
    const method = (config.method ?? 'GET').toUpperCase();
    const hasIdempotencyKey = !!(config.headers as any)?.get?.(SYSTEM_HEADERS.IDEMPOTENCY_KEY);
    const safeToRepeat = IDEMPOTENT_METHODS.has(method) || hasIdempotencyKey || !!retryPolicy.retryNonIdempotent;

    if ((isRetryableStatus || isNetworkError) && safeToRepeat && config._retryCount < retryPolicy.maxRetries) {
      config._retryCount += 1;

      // Thuật toán Exponential Backoff kèm Full Jitter, ưu tiên Retry-After của đối tác (429/503)
      const baseDelay = retryPolicy.initialDelayMs * Math.pow(2, config._retryCount - 1);
      const cappedDelay = Math.min(baseDelay, retryPolicy.maxDelayMs);
      const retryAfterMs = this.parseRetryAfter(error.response?.headers?.['retry-after']);
      const delayMs = retryAfterMs ?? Math.floor(Math.random() * cappedDelay);

      this.appLogger.warn(
        `[HttpClient Retry] Attempt ${config._retryCount}/${retryPolicy.maxRetries} for ${maskUrl(config.url, config.baseURL)} after ${delayMs}ms. Reason: ${error.message}`,
        CONTEXT,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return instance(config);
    }

    this.appLogger.error(
      `[HttpClient Error] Failed call to ${method} ${maskUrl(config.url, config.baseURL)} [Status: ${status || error.code || 'NETWORK_FAILURE'}]: ${error.message}`,
      undefined,
      CONTEXT,
    );

    return Promise.reject(error);
  }

  /** Retry-After: số giây hoặc HTTP-date (RFC 9110 §10.2.3) */
  private parseRetryAfter(value: unknown): number | undefined {
    if (typeof value !== 'string' || value === '') return undefined;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(value).getTime() - Date.now();
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
  }
}
