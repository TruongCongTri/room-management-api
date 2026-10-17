/**
 * Dịch vụ lõi điều phối khóa phân tán (Redis SET NX PX + Lua compare-and-delete),
 * kiểm soát Watchdog timer và cung cấp phương thức runWithLock() an toàn (RAII).
 *
 * REDIS_ENABLED=false → khóa trong tiến trình (chỉ an toàn khi chạy MỘT instance, dùng cho dev/test).
 */
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { LockHandle, LockOptions, LockReleaseOptions } from '../interfaces/lock.interface';
import { SAFE_RELEASE_LUA, SAFE_EXTEND_LUA } from '../scripts/lua-scripts';
import { RequestContextService } from '../../../core/context/request-context.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { REDIS_CLIENT } from '../../../core/redis/redis.constants';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class DistributedLockService implements OnModuleDestroy {
  private static instance?: DistributedLockService;

  private readonly logger = new Logger(DistributedLockService.name);
  private readonly activeWatchdogs = new Map<string, { timer: NodeJS.Timeout; controller: AbortController }>();
  private readonly memoryLocks = new Map<string, { token: string; expiresAt: number }>();
  private readonly defaults: {
    ttlMs: number;
    retryCount: number;
    retryDelayMs: number;
    maxRetryDelayMs: number;
  };

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly contextService: RequestContextService,
    @Optional() config?: AppConfigService,
  ) {
    const lock = config?.lock;
    this.defaults = {
      ttlMs: lock?.defaultTtlMs ?? 10000,
      retryCount: lock?.retryCount ?? 10,
      retryDelayMs: lock?.retryDelayMs ?? 200,
      maxRetryDelayMs: lock?.maxRetryDelayMs ?? 2000,
    };
    if (!redis) {
      this.logger.warn('Redis is disabled: distributed locks fall back to in-process locks (single instance only).');
    }
    DistributedLockService.instance = this;
  }

  /** Dùng bởi @DistributedLock() / @DistributedCron() khi class không inject lockService */
  static getInstance(): DistributedLockService | undefined {
    return DistributedLockService.instance;
  }

  onModuleDestroy(): void {
    for (const { timer } of this.activeWatchdogs.values()) clearInterval(timer);
    this.activeWatchdogs.clear();
  }

  /** lock:{buildingId|global}:{rawKey} - cron hệ thống không có tòa nhà dùng chung namespace 'global' */
  private formatKey(rawKey: string): string {
    const buildingId = this.contextService.getBuildingId() || 'global';
    return `lock:${buildingId}:${rawKey}`;
  }

  /**
   * Xin quyền giữ khóa phân tán (Acquire Lock) kèm Exponential Backoff + Full Jitter
   */
  async acquire(key: string, options: LockOptions = {}): Promise<LockHandle> {
    const fullKey = this.formatKey(key);
    const ttlMs = options.ttlMs || this.defaults.ttlMs;
    const retryCount = options.retryCount ?? this.defaults.retryCount;
    const retryDelayMs = options.retryDelayMs || this.defaults.retryDelayMs;
    const maxRetryDelayMs = Math.max(this.defaults.maxRetryDelayMs, retryDelayMs);
    const token = randomUUID();

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (await this.trySet(fullKey, token, ttlMs)) {
        const handle: LockHandle = { key: fullKey, token, ttlMs, acquiredAt: Date.now(), lost: false };
        if (options.autoRenew) {
          this.startWatchdog(handle);
        }
        return handle;
      }

      if (attempt < retryCount) {
        // Full Jitter (AWS Architecture Blog): sleep = random(0, min(cap, base * 2^attempt))
        const cap = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** attempt);
        await sleep(Math.floor(Math.random() * cap));
      }
    }

    throw new ConflictException(
      `Failed to acquire distributed lock for resource '${key}'. Resource is currently locked by another operation.`,
    );
  }

  /**
   * Giải phóng khóa an toàn bằng Lua Script (chỉ xóa nếu đúng token).
   * minHoldMs: giữ khóa tối thiểu tính từ lúc lấy (chống lệch đồng hồ giữa các Pod).
   */
  async release(handle: LockHandle, options: LockReleaseOptions = {}): Promise<boolean> {
    this.stopWatchdog(handle);

    const remainingHoldMs = options.minHoldMs ? options.minHoldMs - (Date.now() - handle.acquiredAt) : 0;
    if (remainingHoldMs > 0) {
      return this.extend(handle, remainingHoldMs);
    }

    try {
      if (!this.redis) {
        const current = this.memoryLocks.get(handle.key);
        if (current?.token !== handle.token) return false;
        this.memoryLocks.delete(handle.key);
        return true;
      }
      const result = await this.redis.eval(SAFE_RELEASE_LUA, 1, handle.key, handle.token);
      return result === 1;
    } catch (err: any) {
      this.logger.error(`Error releasing lock for key '${handle.key}': ${err.message}`);
      return false;
    }
  }

  /**
   * Đặt lại TTL của khóa nếu token vẫn hợp lệ
   */
  async extend(handle: LockHandle, additionalTtlMs: number): Promise<boolean> {
    try {
      if (!this.redis) {
        const current = this.memoryLocks.get(handle.key);
        if (current?.token !== handle.token || current.expiresAt <= Date.now()) return false;
        current.expiresAt = Date.now() + additionalTtlMs;
        return true;
      }
      const result = await this.redis.eval(SAFE_EXTEND_LUA, 1, handle.key, handle.token, additionalTtlMs);
      return result === 1;
    } catch (err: any) {
      this.logger.warn(`Failed to extend lock for key '${handle.key}': ${err.message}`);
      return false;
    }
  }

  /**
   * Thực thi một khối tác vụ được bọc trong vòng đời an toàn của Lock (RAII Pattern).
   * Tác vụ nhận LockHandle để kiểm tra handle.signal khi bật autoRenew.
   */
  async runWithLock<T>(
    key: string,
    operation: (handle: LockHandle) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const handle = await this.acquire(key, options);
    try {
      return await operation(handle);
    } finally {
      await this.release(handle);
    }
  }

  private async trySet(fullKey: string, token: string, ttlMs: number): Promise<boolean> {
    if (!this.redis) {
      const current = this.memoryLocks.get(fullKey);
      if (current && current.expiresAt > Date.now()) return false;
      this.memoryLocks.set(fullKey, { token, expiresAt: Date.now() + ttlMs });
      return true;
    }
    // SET resource token PX ttlMs NX (Atomic operation)
    return (await this.redis.set(fullKey, token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  private startWatchdog(handle: LockHandle): void {
    const controller = new AbortController();
    handle.signal = controller.signal;

    // Gia hạn khi đã trôi qua 50% thời gian TTL
    const intervalMs = Math.max(Math.floor(handle.ttlMs / 2), 50);
    const timer = setInterval(async () => {
      const extended = await this.extend(handle, handle.ttlMs);
      if (!extended && this.activeWatchdogs.has(handle.token)) {
        handle.lost = true;
        this.logger.error(
          `Lost distributed lock '${handle.key}' (could not renew). The protected operation must stop.`,
        );
        controller.abort(new Error(`Distributed lock '${handle.key}' was lost`));
        this.stopWatchdog(handle);
      }
    }, intervalMs);

    // Không giữ event loop nếu process muốn dừng
    timer.unref();
    this.activeWatchdogs.set(handle.token, { timer, controller });
  }

  private stopWatchdog(handle: LockHandle): void {
    const watchdog = this.activeWatchdogs.get(handle.token);
    if (watchdog) {
      clearInterval(watchdog.timer);
      this.activeWatchdogs.delete(handle.token);
    }
  }
}
