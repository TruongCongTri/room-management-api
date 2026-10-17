/**
 * Tạo file kiểm chuẩn:
 *  Thuật toán XFetch (Probabilistic Early Expiration).
 *  getOrSet: Trả về cache khi còn mới, gọi factory khi cache miss, gộp lời gọi đồng thời (Single-Flight).
 *  invalidateTag: Xóa hàng loạt key thuộc tag (Redis + bộ nhớ trong tiến trình).
 *  Cơ chế Fail-Open: Không làm sập ứng dụng khi Redis gặp sự cố, fallback LRU trong RAM.
 *
 * */

import { RedisCacheService } from './services/redis-cache.service';
import { CacheTagManager } from './services/cache-tag.manager';
import { shouldRecomputeWithXFetch } from './algorithms/xfetch.algorithm';
import { MemoryLruStore } from './stores/memory-lru.store';
import { HttpCacheInterceptor } from './interceptors/http-cache.interceptor';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { AppConfigService } from '../../core/config/app-config.service';
import { RequestContextService } from '../../core/context/request-context.service';

const mockConfig = {
  cache: { defaultTtlSeconds: 300, memoryMaxEntries: 100, l1TtlSeconds: 0, xfetchBeta: 1 },
} as unknown as AppConfigService;

describe('CacheModule (Enterprise Redis & Anti-Stampede Suite)', () => {
  describe('XFetch Algorithm (Probabilistic Early Expiration)', () => {
    it('should return true immediately if current time is past expiration', () => {
      const pastTime = Date.now() - 1000;
      expect(shouldRecomputeWithXFetch(pastTime, 50)).toBe(true);
    });

    it('should return false when key has ample TTL remaining and compute delta is minimal', () => {
      // Còn tận 10 phút nữa mới hết hạn, delta chỉ 5ms
      const ampleFutureTime = Date.now() + 600000;
      expect(shouldRecomputeWithXFetch(ampleFutureTime, 5)).toBe(false);
    });
  });

  describe('MemoryLruStore', () => {
    it('should evict the least recently used entry when full', () => {
      const store = new MemoryLruStore<number>(2);
      store.set('a', 1, 60_000);
      store.set('b', 2, 60_000);
      store.get('a'); // 'a' vừa được dùng → 'b' là cũ nhất
      store.set('c', 3, 60_000);

      expect(store.get('a')).toBe(1);
      expect(store.get('b')).toBeUndefined();
      expect(store.get('c')).toBe(3);
    });

    it('should expire entries after their TTL', () => {
      const store = new MemoryLruStore<number>(10);
      store.set('k', 1, -1);
      expect(store.get('k')).toBeUndefined();
    });
  });

  describe('RedisCacheService & Tag Invalidation', () => {
    let service: RedisCacheService;
    let tagManager: jest.Mocked<CacheTagManager>;
    let mockRedis: any;
    let contextService: RequestContextService;

    beforeEach(() => {
      contextService = new RequestContextService();
      jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_tokyo');

      mockRedis = {
        status: 'ready',
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        unlink: jest.fn().mockResolvedValue(1),
      };

      tagManager = {
        tagKey: jest.fn().mockResolvedValue(undefined),
        invalidateTag: jest.fn().mockResolvedValue(['k1', 'k2', 'k3', 'k4', 'k5']),
      } as unknown as jest.Mocked<CacheTagManager>;

      service = new RedisCacheService(mockConfig, contextService, tagManager, mockRedis);
    });

    it('should prefix keys with active tenantId for strict multi-tenant isolation', async () => {
      await service.set('search_results', { rooms: [] }, { ttlSeconds: 60 });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'cache:tenant_tokyo:search_results',
        expect.stringContaining('"value":{"rooms":[]}'),
        'EX',
        60,
      );
    });

    it('should invoke factory and set cache on cache miss in getOrSet', async () => {
      const dbFactory = jest.fn().mockResolvedValue({ roomCount: 42 });
      const result = await service.getOrSet('room_availability', dbFactory, { ttlSeconds: 120 });

      expect(dbFactory).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ roomCount: 42 });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'cache:tenant_tokyo:room_availability',
        expect.any(String),
        'EX',
        120,
      );
    });

    it('should return cached value and bypass factory on cache hit in getOrSet', async () => {
      const cachedEnvelope = { value: { roomCount: 99 }, expiresAt: Date.now() + 500000, delta: 10 };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedEnvelope));

      const dbFactory = jest.fn();
      const result = await service.getOrSet('room_availability', dbFactory);

      expect(result).toEqual({ roomCount: 99 });
      expect(dbFactory).not.toHaveBeenCalled();
    });

    it('should collapse concurrent cold misses into a single factory call (Single-Flight)', async () => {
      let release!: (value: string) => void;
      const dbFactory = jest.fn(() => new Promise<string>((resolve) => (release = resolve)));

      const callers = Promise.all([
        service.getOrSet('hot_route_HAN_SGN', dbFactory),
        service.getOrSet('hot_route_HAN_SGN', dbFactory),
        service.getOrSet('hot_route_HAN_SGN', dbFactory),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      release('rents');

      expect(await callers).toEqual(['rents', 'rents', 'rents']);
      expect(dbFactory).toHaveBeenCalledTimes(1);
    });

    it('should invalidate multiple cache keys tagged under a specific domain entity', async () => {
      const purgedCount = await service.invalidateTag('room_VN100');

      expect(tagManager.invalidateTag).toHaveBeenCalledWith('tenant_tokyo', 'room_VN100');
      expect(purgedCount).toBe(5);
    });

    it('should fail-open gracefully without throwing when Redis encounters an error', async () => {
      mockRedis.get.mockRejectedValue(new Error('Connection reset by peer'));

      const dbFactory = jest.fn().mockResolvedValue('DB_FALLBACK_DATA');
      const result = await service.getOrSet('critical_query', dbFactory);

      // Ứng dụng không sập, tự động lấy dữ liệu từ DB Factory
      expect(result).toBe('DB_FALLBACK_DATA');
      expect(dbFactory).toHaveBeenCalledTimes(1);
    });

    it('should serve from the in-memory LRU while Redis is disconnected', async () => {
      await service.set('rent_rules', { refundable: true });
      mockRedis.status = 'reconnecting';
      mockRedis.get.mockClear();

      await expect(service.get('rent_rules')).resolves.toEqual({ refundable: true });
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should work without Redis at all (REDIS_ENABLED=false)', async () => {
      const memoryOnly = new RedisCacheService(mockConfig, contextService, tagManager, null);
      const factory = jest.fn().mockResolvedValue(7);

      await expect(memoryOnly.getOrSet('k', factory)).resolves.toBe(7);
      await expect(memoryOnly.getOrSet('k', factory)).resolves.toBe(7);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('HttpCacheInterceptor', () => {
    const buildContext = (method: string, url: string, user?: { id: string }) => {
      const response: any = { statusCode: 200, setHeader: jest.fn() };
      return {
        response,
        context: {
          getType: () => 'http',
          getHandler: () => undefined,
          getClass: () => undefined,
          switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url, user }), getResponse: () => response }),
        } as unknown as ExecutionContext,
      };
    };

    it('should serve the second GET from cache without invoking the handler', async () => {
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ ttlSeconds: 60, scope: 'tenant' });
      const contextService = new RequestContextService();
      const cache = new RedisCacheService(mockConfig, contextService, { tagKey: jest.fn() } as any, null);
      const interceptor = new HttpCacheInterceptor(reflector, cache);
      const handler = jest.fn(() => of({ airports: ['SGN', 'HAN'] }));

      const first = buildContext('GET', '/api/v1/airports?country=VN');
      expect(await lastValueFrom(interceptor.intercept(first.context, { handle: handler }))).toEqual({ airports: ['SGN', 'HAN'] });
      await new Promise((resolve) => setImmediate(resolve));

      const second = buildContext('GET', '/api/v1/airports?country=VN');
      expect(await lastValueFrom(interceptor.intercept(second.context, { handle: handler }))).toEqual({ airports: ['SGN', 'HAN'] });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(first.response.setHeader).toHaveBeenCalledWith('X-Cache-Lookup', 'MISS');
      expect(second.response.setHeader).toHaveBeenCalledWith('X-Cache-Lookup', 'HIT');
    });

    it('should ignore non-GET requests and routes without @HttpCache()', async () => {
      const reflector = new Reflector();
      const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const cache = { get: jest.fn() } as any;
      const interceptor = new HttpCacheInterceptor(reflector, cache);
      const handler = { handle: () => of('fresh') };

      await lastValueFrom(interceptor.intercept(buildContext('GET', '/x').context, handler));
      spy.mockReturnValue({ ttlSeconds: 60 });
      await lastValueFrom(interceptor.intercept(buildContext('POST', '/x').context, handler));

      expect(cache.get).not.toHaveBeenCalled();
    });
  });
});

// npx jest src/infrastructure/cache/cache.spec.ts
