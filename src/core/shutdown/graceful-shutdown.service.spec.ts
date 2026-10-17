import { GracefulShutdownService } from './graceful-shutdown.service';
import { ShutdownRegistry } from './shutdown.registry';
import { ShutdownPhase } from './shutdown.interface';
import { AppConfigService } from '../config/app-config.service';

describe('GracefulShutdownService (Enterprise Lifecycle)', () => {
  let service: GracefulShutdownService;
  let registry: ShutdownRegistry;

  const mockConfig = {
    shutdown: { drainDelayMs: 10, hookTimeoutMs: 200, timeoutMs: 5000 },
  } as unknown as AppConfigService;

  beforeEach(() => {
    registry = new ShutdownRegistry();
    service = new GracefulShutdownService(registry, mockConfig);
  });

  afterEach(async () => {
    // Giải phóng watchdog timer
    await service.onApplicationShutdown('TEST_CLEANUP');
  });

  it('should initialize with isShuttingDown set to false', () => {
    expect(service.isShuttingDown()).toBe(false);
  });

  it('should execute shutdown hooks in strict chronological phase order', async () => {
    const executionTrace: string[] = [];

    registry.register('k8s-drain', ShutdownPhase.DRAIN_TRAFFIC, () => {
      executionTrace.push('DRAIN_TRAFFIC');
    });
    registry.register('bullmq-pause', ShutdownPhase.PAUSE_CONSUMERS, () => {
      executionTrace.push('PAUSE_CONSUMERS');
    });
    registry.register('http-drain', ShutdownPhase.DRAIN_HTTP, () => {
      executionTrace.push('DRAIN_HTTP');
    });
    registry.register('pino-flush', ShutdownPhase.FLUSH_BUFFERS, () => {
      executionTrace.push('FLUSH_BUFFERS');
    });
    registry.register('db-close', ShutdownPhase.RELEASE_POOLS, () => {
      executionTrace.push('CLOSE_DB');
    }, 100);
    registry.register('redis-close', ShutdownPhase.RELEASE_POOLS, () => {
      executionTrace.push('CLOSE_REDIS');
    }, 90);

    // 1. Giả lập Kubernetes gửi tín hiệu SIGTERM (beforeApplicationShutdown)
    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
    expect(executionTrace).toEqual(['DRAIN_TRAFFIC', 'PAUSE_CONSUMERS', 'DRAIN_HTTP']);

    // 2. Giả lập NestJS hoàn tất đóng HTTP server (onApplicationShutdown)
    await service.onApplicationShutdown('SIGTERM');

    expect(executionTrace).toEqual([
      'DRAIN_TRAFFIC',
      'PAUSE_CONSUMERS',
      'DRAIN_HTTP',
      'FLUSH_BUFFERS',
      'CLOSE_REDIS',
      'CLOSE_DB', // order 100: đóng sau cùng
    ]);
  });

  it('should continue executing subsequent hooks even if one hook fails', async () => {
    const faultyHook = jest.fn().mockRejectedValue(new Error('Flushing failed'));
    const nextHook = jest.fn().mockResolvedValue(undefined);

    registry.register('faulty-hook', ShutdownPhase.FLUSH_BUFFERS, faultyHook, 1);
    registry.register('healthy-hook', ShutdownPhase.FLUSH_BUFFERS, nextHook, 2);

    await service.onApplicationShutdown('SIGTERM');

    expect(faultyHook).toHaveBeenCalled();
    expect(nextHook).toHaveBeenCalled();
  });

  it('should time out a hanging hook instead of blocking the whole shutdown', async () => {
    const hangingHook = jest.fn(() => new Promise<void>(() => undefined));
    const nextHook = jest.fn();

    registry.register('hanging', ShutdownPhase.RELEASE_POOLS, hangingHook, 1);
    registry.register('after-hanging', ShutdownPhase.RELEASE_POOLS, nextHook, 2);

    const started = Date.now();
    await service.onApplicationShutdown('SIGTERM');

    expect(nextHook).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('should wait for in-flight HTTP requests before completing phase 3', async () => {
    let finishRequest: () => void = () => undefined;
    service.trackRequest((done) => {
      finishRequest = done;
    });
    expect(service.getInFlightRequestCount()).toBe(1);

    setTimeout(() => finishRequest(), 50);
    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.getInFlightRequestCount()).toBe(0);
  });

  it('should not double-decrement when both finish and close fire', () => {
    let done: () => void = () => undefined;
    service.trackRequest((cb) => {
      done = cb;
    });
    done();
    done();
    expect(service.getInFlightRequestCount()).toBe(0);
  });

  it('should replace a hook registered twice under the same name', () => {
    registry.register('dup', ShutdownPhase.RELEASE_POOLS, jest.fn());
    registry.register('dup', ShutdownPhase.RELEASE_POOLS, jest.fn());
    expect(registry.getHooksForPhase(ShutdownPhase.RELEASE_POOLS)).toHaveLength(1);
  });
});

// npx jest src/core/shutdown/graceful-shutdown.service.spec.ts
