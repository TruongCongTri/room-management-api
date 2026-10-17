import { ServiceUnavailableException } from '@nestjs/common';
import type {
  HealthCheckService,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StorageHealthIndicator } from './indicators/storage.health';
import { GracefulShutdownService } from '../../core/shutdown/graceful-shutdown.service';
import { AppConfigService } from '../../core/config/app-config.service';

// Mock @nestjs/terminus để ngăn Jest nạp file ESM từ node_modules
jest.mock('@nestjs/terminus', () => ({
  HealthCheck: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  HealthCheckService: class HealthCheckService {},
  MemoryHealthIndicator: class MemoryHealthIndicator {},
  DiskHealthIndicator: class DiskHealthIndicator {},
}));

// Nạp HealthController sau khi đã thiết lập mock cho terminus
import { HealthController } from './controllers/health.controller';

describe('HealthModule (Enterprise Terminus Probes)', () => {
  let controller: HealthController;
  let healthService: HealthCheckService;
  let memoryIndicator: MemoryHealthIndicator;
  let diskIndicator: DiskHealthIndicator;
  let dbIndicator: DatabaseHealthIndicator;
  let redisIndicator: RedisHealthIndicator;
  let shutdownService: GracefulShutdownService;

  beforeEach(() => {
    healthService = {
      check: jest.fn().mockImplementation(async (indicators) => {
        const results = await Promise.all(indicators.map((fn: any) => fn()));
        return {
          status: 'ok',
          info: Object.assign({}, ...results),
        };
      }),
    } as unknown as HealthCheckService;

    memoryIndicator = {
      checkHeap: jest.fn().mockResolvedValue({ memory_heap: { status: 'up' } }),
      checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
    } as unknown as MemoryHealthIndicator;

    diskIndicator = {
      checkStorage: jest.fn().mockResolvedValue({ storage_disk: { status: 'up' } }),
    } as unknown as DiskHealthIndicator;

    dbIndicator = {
      isHealthy: jest.fn().mockResolvedValue({ database: { status: 'up', latencyMs: 2 } }),
    } as unknown as DatabaseHealthIndicator;

    redisIndicator = {
      isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up', latencyMs: 1 } }),
    } as unknown as RedisHealthIndicator;

    shutdownService = {
      isShuttingDown: jest.fn().mockReturnValue(false),
    } as unknown as GracefulShutdownService;

    const config = {
      health: {
        heapLimitBytes: 1024 * 1024 * 1024,
        rssLimitBytes: 1536 * 1024 * 1024,
        diskPath: '/',
        diskThresholdPercent: 0.95,
      },
    } as unknown as AppConfigService;

    controller = new HealthController(
      healthService,
      memoryIndicator,
      diskIndicator,
      dbIndicator,
      redisIndicator,
      shutdownService,
      config,
      new StorageHealthIndicator(),
    );
  });

  describe('StorageHealthIndicator', () => {
    it('should report UP with mode=disabled when object storage is turned off', async () => {
      await expect(new StorageHealthIndicator({ isEnabled: false } as any).isHealthy('object_storage')).resolves.toEqual({
        object_storage: { status: 'up', mode: 'disabled' },
      });
    });

    it('should report UP with latency when HeadBucket succeeds, DOWN when it fails', async () => {
      const ok = { isEnabled: true, pingBucket: jest.fn().mockResolvedValue(undefined) } as any;
      expect((await new StorageHealthIndicator(ok).isHealthy()).object_storage).toEqual({
        status: 'up',
        latencyMs: expect.any(Number),
      });

      const broken = { isEnabled: true, pingBucket: jest.fn().mockRejectedValue(new Error('NoSuchBucket')) } as any;
      expect((await new StorageHealthIndicator(broken).isHealthy()).object_storage).toEqual(
        expect.objectContaining({ status: 'down', message: 'NoSuchBucket' }),
      );
    });
  });

  describe('RedisHealthIndicator', () => {
    it('should report UP with mode=disabled when Redis is turned off (dev/test)', async () => {
      await expect(new RedisHealthIndicator(null).isHealthy('redis')).resolves.toEqual({
        redis: { status: 'up', mode: 'disabled' },
      });
    });

    it('should report DOWN (→ readiness 503) when the connection is not ready', async () => {
      const result = await new RedisHealthIndicator({ status: 'reconnecting' } as any).isHealthy('redis');
      expect(result.redis.status).toBe('down');
    });

    it('should report UP with latency when PING succeeds', async () => {
      const redis = { status: 'ready', ping: jest.fn().mockResolvedValue('PONG') } as any;
      const result = await new RedisHealthIndicator(redis).isHealthy('redis');
      expect(result.redis).toEqual({ status: 'up', latencyMs: expect.any(Number) });
    });
  });

  describe('Liveness Probe (/health/liveness)', () => {
    it('should return UP when event loop and heap memory are healthy', async () => {
      const result = await controller.checkLiveness();

      expect(result.status).toBe('ok');
      expect(memoryIndicator.checkHeap).toHaveBeenCalled();
      // Đảm bảo không kiểm tra Database/Redis trong liveness để tránh cascading restart
      expect(dbIndicator.isHealthy).not.toHaveBeenCalled();
      expect(redisIndicator.isHealthy).not.toHaveBeenCalled();
    });
  });

  describe('Readiness Probe (/health/readiness)', () => {
    it('should return UP when all infrastructure components are operational', async () => {
      const result = await controller.checkReadiness();

      expect(result.status).toBe('ok');
      expect(dbIndicator.isHealthy).toHaveBeenCalledWith('database');
      expect(redisIndicator.isHealthy).toHaveBeenCalledWith('redis');
      expect(diskIndicator.checkStorage).toHaveBeenCalled();
    });

    it('should throw ServiceUnavailableException (503) immediately when Pod is shutting down', async () => {
      jest.spyOn(shutdownService, 'isShuttingDown').mockReturnValue(true);

      await expect(controller.checkReadiness()).rejects.toThrow(
        ServiceUnavailableException,
      );

      // Khi đang shutdown, ngắt kiểm tra các thành phần bên dưới để giải phóng tài nguyên
      expect(dbIndicator.isHealthy).not.toHaveBeenCalled();
    });
  });
});


// npx jest src/infrastructure/health/health.spec.ts