/**
 * Hợp nhất các chính sách chống sụp đổ dây chuyền theo thứ tự (ngoài → trong):
 *   Bulkhead → Retry (Exponential Backoff + Full Jitter) → Circuit Breaker (+Timeout) → Operation
 * và Fallback khi toàn bộ chuỗi thất bại.
 */
import {
  Injectable,
  BadGatewayException,
  ServiceUnavailableException,
  HttpException,
  OnModuleDestroy,
} from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { Bulkhead, BulkheadRejectedError } from './bulkhead';
import {
  ResiliencePolicyOptions,
  BreakerMetrics,
  RetryOptions,
  BulkheadOptions,
  CircuitBreakerOptions,
} from './resilience.interface';
import { AppLoggerService } from '../logger/app-logger.service';
import { AppConfigService } from '../config/app-config.service';

type Operation = () => Promise<unknown>;

const DEFAULT_BULKHEAD: BulkheadOptions = { maxConcurrent: 20, maxQueue: 10 };
const CONTEXT = 'ResilienceService';

/** Mặc định chỉ retry lỗi tạm thời: lỗi mạng, timeout, 5xx; không retry 4xx */
export function isTransientError(error: unknown): boolean {
  const err = error as any;
  if (err instanceof HttpException) return err.getStatus() >= 500;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  return true;
}

@Injectable()
export class ResilienceService implements OnModuleDestroy {
  // Breaker nhận operation làm THAM SỐ của fire(): mỗi lời gọi chạy đúng closure của nó
  private readonly breakers = new Map<string, CircuitBreaker<[Operation], unknown>>();
  private readonly bulkheads = new Map<string, Bulkhead>();
  private readonly defaultBreakerOptions: Required<CircuitBreakerOptions>;
  private readonly defaultBulkheadOptions: BulkheadOptions;

  constructor(
    private readonly appLogger: AppLoggerService,
    config?: AppConfigService,
  ) {
    const resilience = config?.resilience;
    this.defaultBreakerOptions = {
      timeout: resilience?.timeoutMs ?? 8000,
      resetTimeout: resilience?.resetTimeoutMs ?? 30000,
      errorThresholdPercentage: resilience?.errorThresholdPercentage ?? 50,
      volumeThreshold: resilience?.volumeThreshold ?? 5,
    };
    this.defaultBulkheadOptions = resilience
      ? { maxConcurrent: resilience.bulkheadMaxConcurrent, maxQueue: resilience.bulkheadMaxQueue }
      : DEFAULT_BULKHEAD;
  }

  onModuleDestroy(): void {
    // Giải phóng timer thống kê của opossum
    this.breakers.forEach((breaker) => breaker.shutdown());
    this.breakers.clear();
  }

  /**
   * Khởi tạo hoặc lấy Bulkhead cho đối tác
   */
  getOrCreateBulkhead(name: string, options?: BulkheadOptions): Bulkhead {
    let bulkhead = this.bulkheads.get(name);
    if (!bulkhead) {
      bulkhead = new Bulkhead(name, options ?? this.defaultBulkheadOptions);
      this.bulkheads.set(name, bulkhead);
    }
    return bulkhead;
  }

  /**
   * Khởi tạo hoặc lấy Circuit Breaker cho đối tác
   */
  getOrCreateBreaker(
    name: string,
    options?: CircuitBreakerOptions,
  ): CircuitBreaker<[Operation], unknown> {
    const existing = this.breakers.get(name);
    if (existing) return existing;

    const breaker = new CircuitBreaker<[Operation], unknown>((op: Operation) => op(), {
      timeout: options?.timeout ?? this.defaultBreakerOptions.timeout,
      errorThresholdPercentage:
        options?.errorThresholdPercentage ?? this.defaultBreakerOptions.errorThresholdPercentage,
      resetTimeout: options?.resetTimeout ?? this.defaultBreakerOptions.resetTimeout,
      volumeThreshold: options?.volumeThreshold ?? this.defaultBreakerOptions.volumeThreshold,
      // Lỗi nghiệp vụ 4xx không phản ánh sức khỏe đối tác → không tính vào tỷ lệ lỗi
      errorFilter: (err: unknown) => !isTransientError(err),
      name,
    });

    breaker.on('open', () =>
      this.appLogger.error(
        `[Resilience] Circuit Breaker '${name}' is now OPEN! Downstream partner failing. Failing fast.`,
        undefined,
        CONTEXT,
      ),
    );
    breaker.on('halfOpen', () =>
      this.appLogger.warn(
        `[Resilience] Circuit Breaker '${name}' is HALF-OPEN. Sending canary probe request...`,
        CONTEXT,
      ),
    );
    breaker.on('close', () =>
      this.appLogger.log(
        `[Resilience] Circuit Breaker '${name}' is CLOSED. Downstream partner recovered.`,
        CONTEXT,
      ),
    );

    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Thực thi tác vụ gọi ngoại vi với Bulkhead, Retry, Circuit Breaker và Fallback an toàn
   */
  async execute<T>(
    serviceName: string,
    operation: () => Promise<T>,
    fallback?: () => Promise<T>,
    options?: ResiliencePolicyOptions,
  ): Promise<T> {
    const bulkhead = this.getOrCreateBulkhead(serviceName, options?.bulkhead);
    const breaker = this.getOrCreateBreaker(serviceName, options?.circuitBreaker);

    try {
      return await bulkhead.execute(() =>
        this.withRetry(
          () => breaker.fire(operation) as Promise<T>,
          breaker,
          options?.retry,
        ),
      );
    } catch (error: any) {
      const unavailable = error instanceof BulkheadRejectedError || breaker.opened;

      if (fallback) {
        this.appLogger.warn(
          `[Resilience] '${serviceName}' failed (${error?.message}). Routing to fallback.`,
          CONTEXT,
        );
        return fallback();
      }

      // Lỗi nghiệp vụ (4xx) của downstream được trả nguyên trạng cho caller xử lý
      if (!unavailable && !isTransientError(error)) {
        throw error;
      }

      this.appLogger.error(
        `[Resilience] External service '${serviceName}' failure: ${error?.message}`,
        error?.stack,
        CONTEXT,
      );

      // Không lộ chi tiết lỗi nội bộ của đối tác ra client
      if (unavailable) {
        throw new ServiceUnavailableException(
          `External service '${serviceName}' is temporarily unavailable.`,
          { cause: error },
        );
      }
      throw new BadGatewayException(`External service '${serviceName}' failed.`, {
        cause: error,
      });
    }
  }

  /**
   * Thuật toán Exponential Backoff kết hợp Full Jitter (AWS Architecture Blog).
   * Dừng retry ngay khi mạch OPEN hoặc lỗi không phải tạm thời.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    breaker: CircuitBreaker<[Operation], unknown>,
    options?: RetryOptions,
  ): Promise<T> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 1);
    const {
      delayMs = 200,
      backoffMultiplier = 2,
      maxDelayMs = 5000,
      retryOn = isTransientError,
    } = options ?? {};

    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= maxAttempts || breaker.opened || !retryOn(err)) throw err;

        const cap = Math.min(maxDelayMs, delayMs * Math.pow(backoffMultiplier, attempt - 1));
        const delay = Math.floor(Math.random() * cap);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Cung cấp số liệu thống kê phục vụ HealthCheck & Prometheus APM
   */
  getMetrics(): BreakerMetrics[] {
    return [...this.breakers.entries()].map(([name, breaker]) => {
      const bulkhead = this.bulkheads.get(name);
      return {
        name,
        state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
        activeExecutions: bulkhead?.active ?? 0,
        queuedExecutions: bulkhead?.queued ?? 0,
        stats: {
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          timeouts: breaker.stats.timeouts,
          rejects: breaker.stats.rejects,
          fallbacks: breaker.stats.fallbacks,
        },
      };
    });
  }
}
