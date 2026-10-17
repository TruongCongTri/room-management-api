/**
 * Lớp dịch vụ cache trung tâm (đa tầng):
 *  - L2 Redis dùng chung giữa các Pod (REDIS_CLIENT) + L1/fallback LRU trong RAM.
 *  - Tự động gắn namespace tenantId (chống rò rỉ cache giữa các tenant).
 *  - XFetch (Probabilistic Early Expiration) làm mới key nóng trước khi hết hạn.
 *  - Single-flight: khi key nguội hoàn toàn, chỉ MỘT lời gọi factory/Pod chạm DB.
 *  - Fail-Open: Redis sự cố → đọc/ghi LRU trong RAM, ghi log cảnh báo, không ném lỗi ra nghiệp vụ.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { REDIS_CLIENT } from '../../../core/redis/redis.constants';
import { CacheSetOptions, CachedEnvelope } from '../interfaces/cache.interface';
import { CacheTagManager } from './cache-tag.manager';
import { shouldRecomputeWithXFetch } from '../algorithms/xfetch.algorithm';
import { MemoryLruStore } from '../stores/memory-lru.store';

const DEFAULT_COMPUTE_DELTA_MS = 50;

@Injectable()
export class RedisCacheService {
  private static instance?: RedisCacheService;

  private readonly logger = new Logger(RedisCacheService.name);
  private readonly memory: MemoryLruStore<CachedEnvelope<unknown>>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly refreshing = new Set<string>();
  private readonly defaultTtlSeconds: number;
  private readonly l1TtlMs: number;
  private readonly xfetchBeta: number;

  constructor(
    config: AppConfigService,
    private readonly contextService: RequestContextService,
    private readonly tagManager: CacheTagManager,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {
    const cache = config.cache;
    this.defaultTtlSeconds = cache.defaultTtlSeconds;
    this.l1TtlMs = cache.l1TtlSeconds * 1000;
    this.xfetchBeta = cache.xfetchBeta;
    this.memory = new MemoryLruStore(cache.memoryMaxEntries);
    RedisCacheService.instance = this;
  }

  /** Dùng bởi decorator @Cacheable() khi class không inject cacheService */
  static getInstance(): RedisCacheService | undefined {
    return RedisCacheService.instance;
  }

  private tenantNamespace(): string {
    return this.contextService.getTenantId() || 'global';
  }

  private buildKey(rawKey: string): string {
    return `cache:${this.tenantNamespace()}:${rawKey}`;
  }

  private redisReady(): boolean {
    return !!this.redis && this.redis.status === 'ready';
  }

  /**
   * Lưu giá trị vào Redis kèm Envelope bảo vệ chống Cache Stampede
   */
  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    const fullKey = this.buildKey(key);
    const ttl = options.ttlSeconds || this.defaultTtlSeconds;
    const envelope: CachedEnvelope<T> = {
      value,
      expiresAt: Date.now() + ttl * 1000,
      delta: options.computeDeltaMs || DEFAULT_COMPUTE_DELTA_MS,
    };

    this.memory.set(fullKey, envelope, ttl * 1000);

    try {
      if (this.redisReady()) {
        await this.redis!.set(fullKey, JSON.stringify(envelope), 'EX', ttl);
      }
      if (options.tags && options.tags.length > 0) {
        await this.tagManager.tagKey(this.tenantNamespace(), fullKey, options.tags);
      }
    } catch (err: any) {
      this.logger.warn(`[Cache:Set] Cache write failed for key '${key}': ${err.message}`);
    }
  }

  /**
   * Lấy giá trị từ cache (null khi miss)
   */
  async get<T>(key: string): Promise<T | null> {
    const envelope = await this.readEnvelope<T>(this.buildKey(key));
    return envelope ? envelope.value : null;
  }

  /**
   * Pattern "Cache-Aside" kết hợp XFetch + Single-Flight chống sập DB (Anti-Cache Stampede)
   */
  async getOrSet<T>(
    key: string,
    fetchFactory: () => Promise<T>,
    options: CacheSetOptions = {},
  ): Promise<T> {
    const fullKey = this.buildKey(key);
    const envelope = await this.readEnvelope<T>(fullKey);

    if (envelope) {
      if (shouldRecomputeWithXFetch(envelope.expiresAt, envelope.delta, this.xfetchBeta)) {
        this.recomputeInBackground(key, fullKey, fetchFactory, options);
      }
      return envelope.value;
    }

    // Cache miss hoàn toàn: gộp các lời gọi đồng thời cùng key thành một (Single-Flight)
    const pending = this.inFlight.get(fullKey) as Promise<T> | undefined;
    if (pending) return pending;

    const task = this.computeAndStore(key, fetchFactory, options).finally(() => {
      this.inFlight.delete(fullKey);
    });
    this.inFlight.set(fullKey, task);
    return task;
  }

  /**
   * Xóa một key cụ thể
   */
  async del(key: string): Promise<void> {
    const fullKey = this.buildKey(key);
    this.memory.delete(fullKey);
    try {
      if (this.redisReady()) await this.redis!.unlink(fullKey);
    } catch (err: any) {
      this.logger.warn(`[Cache:Del] Failed to delete key '${key}': ${err.message}`);
    }
  }

  /**
   * Xóa cache theo tag nghiệp vụ (ví dụ: 'rooms', 'contracts')
   */
  async invalidateTag(tag: string): Promise<number> {
    try {
      const keys = await this.tagManager.invalidateTag(this.tenantNamespace(), tag);
      keys.forEach((k) => this.memory.delete(k));
      return keys.length;
    } catch (err: any) {
      this.logger.warn(`[Cache:InvalidateTag] Failed to invalidate tag '${tag}': ${err.message}`);
      return 0;
    }
  }

  private async computeAndStore<T>(
    key: string,
    fetchFactory: () => Promise<T>,
    options: CacheSetOptions,
  ): Promise<T> {
    const startTime = Date.now();
    const freshValue = await fetchFactory();
    await this.set(key, freshValue, { ...options, computeDeltaMs: Date.now() - startTime });
    return freshValue;
  }

  /**
   * Đọc envelope: L1 (nếu bật) → Redis → LRU fallback khi Redis không khả dụng / lỗi
   */
  private async readEnvelope<T>(fullKey: string): Promise<CachedEnvelope<T> | null> {
    if (this.l1TtlMs > 0) {
      const l1 = this.memory.get(fullKey, this.l1TtlMs) as CachedEnvelope<T> | undefined;
      if (l1) return l1;
    }

    if (this.redisReady()) {
      try {
        const raw = await this.redis!.get(fullKey);
        if (!raw) return null;
        const envelope = JSON.parse(raw) as CachedEnvelope<T>;
        if (this.l1TtlMs > 0) {
          this.memory.set(fullKey, envelope, Math.max(envelope.expiresAt - Date.now(), 1));
        }
        return envelope;
      } catch (err: any) {
        this.logger.warn(`[Cache:Get] Redis read failed for '${fullKey}': ${err.message}. Falling back to memory.`);
      }
    }

    return (this.memory.get(fullKey) as CachedEnvelope<T> | undefined) ?? null;
  }

  private recomputeInBackground<T>(
    key: string,
    fullKey: string,
    fetchFactory: () => Promise<T>,
    options: CacheSetOptions,
  ): void {
    // Mỗi Pod chỉ làm mới một key một lần tại một thời điểm
    if (this.refreshing.has(fullKey)) return;
    this.refreshing.add(fullKey);

    // Giữ nguyên ngữ cảnh (tenant/trace) của request đã kích hoạt làm mới
    const store = this.contextService.getStore();
    const run = () =>
      this.computeAndStore(key, fetchFactory, options)
        .catch((err: any) =>
          this.logger.error(`[Cache:BackgroundRefresh] Failed to refresh key '${key}': ${err.message}`),
        )
        .finally(() => this.refreshing.delete(fullKey));

    setImmediate(() => (store ? this.contextService.run(store, run) : run()));
  }
}
