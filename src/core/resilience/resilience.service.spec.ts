import { ResilienceService } from './resilience.service';
import { Resilient } from './resilience.decorator';
import { Bulkhead, BulkheadRejectedError } from './bulkhead';
import { AppLoggerService } from '../logger/app-logger.service';
import {
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

describe('ResilienceService (Circuit Breaker, Retry & Bulkhead)', () => {
  let service: ResilienceService;
  let mockLogger: jest.Mocked<AppLoggerService>;

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<AppLoggerService>;

    service = new ResilienceService(mockLogger);
  });

  afterEach(() => service.onModuleDestroy());

  it('should successfully execute operation under normal conditions', async () => {
    const operation = jest.fn().mockResolvedValue('INVOICE_ISSUED_OK');

    await expect(service.execute('zalo-zns', operation)).resolves.toBe('INVOICE_ISSUED_OK');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should execute EACH call with its own operation (no stale closure reuse per breaker)', async () => {
    const first = await service.execute('vietjet', async () => 'contract-for-user-A');
    const second = await service.execute('vietjet', async () => 'contract-for-user-B');

    expect(first).toBe('contract-for-user-A');
    expect(second).toBe('contract-for-user-B');
  });

  it('should reject requests when Bulkhead capacity and queue are exhausted (Fail-Fast)', async () => {
    const slowOperation = () => new Promise((resolve) => setTimeout(resolve, 100));
    const options = { bulkhead: { maxConcurrent: 1, maxQueue: 0 } };

    const task1 = service.execute('limited-partner', slowOperation, undefined, options);

    await expect(
      service.execute('limited-partner', slowOperation, undefined, options),
    ).rejects.toThrow(ServiceUnavailableException);

    await task1;
  });

  it('should trip Circuit Breaker to OPEN when errors exceed threshold and route to Fallback', async () => {
    const failingOperation = jest.fn().mockRejectedValue(new Error('PARTNER Connection Timeout'));
    const fallbackFn = jest.fn().mockResolvedValue('CACHED_FALLBACK_PRICE');

    const breakerOptions = {
      circuitBreaker: {
        errorThresholdPercentage: 50,
        volumeThreshold: 2,
        resetTimeout: 10000,
        timeout: 1000,
      },
    };

    await service.execute('e-invoice-gateway', failingOperation, fallbackFn, breakerOptions);
    await service.execute('e-invoice-gateway', failingOperation, fallbackFn, breakerOptions);

    // Lần gọi thứ 3: Mạch đã OPEN, không gọi downstream nữa mà sang thẳng fallback
    const result = await service.execute('e-invoice-gateway', failingOperation, fallbackFn, breakerOptions);

    expect(result).toBe('CACHED_FALLBACK_PRICE');
    expect(failingOperation).toHaveBeenCalledTimes(2);
    expect(service.getMetrics()[0].state).toBe('OPEN');
  });

  it('should retry transient errors with backoff and eventually succeed', async () => {
    const flaky = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('OK');

    const result = await service.execute('vnpay', flaky, undefined, {
      retry: { maxAttempts: 3, delayMs: 1 },
    });

    expect(result).toBe('OK');
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('should NOT retry business (4xx) errors and should propagate them unchanged', async () => {
    const notFound = jest.fn().mockRejectedValue(new NotFoundException('INVOICENO not found'));

    await expect(
      service.execute('sabre-pnr', notFound, undefined, { retry: { maxAttempts: 3, delayMs: 1 } }),
    ).rejects.toThrow(NotFoundException);
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('should wrap downstream failures without leaking partner error details', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('internal partner stacktrace secret'));

    const error: any = await service.execute('partner-x', failing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.message).not.toContain('secret');
  });

  it('should correctly report metrics and circuit state for APM / HealthCheck', async () => {
    await service.execute('payment-vnpay', jest.fn().mockResolvedValue('OK'));

    const metrics = service.getMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('payment-vnpay');
    expect(metrics[0].state).toBe('CLOSED');
    expect(metrics[0].stats.successes).toBeGreaterThanOrEqual(1);
  });

  describe('Bulkhead', () => {
    it('should never exceed maxConcurrent when handing slots to queued callers', async () => {
      const bulkhead = new Bulkhead('test', { maxConcurrent: 2, maxQueue: 10 });
      let running = 0;
      let peak = 0;
      const task = () =>
        bulkhead.execute(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        });

      await Promise.all(Array.from({ length: 8 }, task));
      expect(peak).toBe(2);
      expect(bulkhead.active).toBe(0);
    });

    it('should reject queued callers after queueTimeoutMs', async () => {
      const bulkhead = new Bulkhead('timeout', { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 10 });
      const blocker = bulkhead.execute(() => new Promise((r) => setTimeout(r, 50)));

      await expect(bulkhead.execute(async () => 'late')).rejects.toBeInstanceOf(
        BulkheadRejectedError,
      );
      await blocker;
    });
  });

  describe('@Resilient() decorator', () => {
    class ZaloZnsAdapter {
      constructor(public readonly resilienceService: ResilienceService) {}

      @Resilient('decorated-partner')
      async search(route: string): Promise<string> {
        return `rents:${route}`;
      }
    }

    it('should route calls through ResilienceService with the right arguments', async () => {
      const adapter = new ZaloZnsAdapter(service);
      await expect(adapter.search('SGN-HAN')).resolves.toBe('rents:SGN-HAN');
      await expect(adapter.search('HAN-DAD')).resolves.toBe('rents:HAN-DAD');
    });
  });
});

// npx jest src/core/resilience/resilience.service.spec.ts
