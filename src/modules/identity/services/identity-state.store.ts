/**
 * Kho trạng thái ngắn hạn của IdentityModule (OTP, bộ đếm đăng nhập sai, khóa đăng nhập).
 * Chỉ cung cấp thao tác NGUYÊN TỬ cơ bản; logic nghiệp vụ nằm ở OtpService / LoginLockService để
 * bản Redis (production, nhiều Pod) và bản bộ nhớ (một tiến trình, unit test) hành xử giống hệt nhau.
 */
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

export const IDENTITY_STATE_STORE = Symbol('IDENTITY_STATE_STORE');

export interface IdentityStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET NX EX - true nếu khóa chưa tồn tại và đã được ghi */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  /** INCR; TTL chỉ được đặt khi khóa vừa được tạo (cửa sổ cố định, không trượt) */
  increment(key: string, ttlSec: number): Promise<number>;
  expire(key: string, ttlSec: number): Promise<void>;
  /** Số khóa đã xóa - dùng để xác định người thắng khi hai request cùng tiêu thụ một OTP */
  delete(...keys: string[]): Promise<number>;
  /** Giây còn lại; 0 nếu khóa không tồn tại / không có TTL */
  ttl(key: string): Promise<number>;
}

export class RedisIdentityStateStore implements IdentityStateStore {
  constructor(private readonly redis: Redis) {}

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSec: number) {
    await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSec)));
  }

  async setIfAbsent(key: string, value: string, ttlSec: number) {
    return (await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSec)), 'NX')) === 'OK';
  }

  async increment(key: string, ttlSec: number) {
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, Math.max(1, Math.ceil(ttlSec)), 'NX')
      .exec();
    const [err, value] = results?.[0] ?? [new Error('Redis MULTI returned no result')];
    if (err) throw err;
    return Number(value);
  }

  async expire(key: string, ttlSec: number) {
    await this.redis.expire(key, Math.max(1, Math.ceil(ttlSec)));
  }

  delete(...keys: string[]) {
    return keys.length ? this.redis.del(...keys) : Promise.resolve(0);
  }

  async ttl(key: string) {
    return Math.max(0, await this.redis.ttl(key));
  }
}

/** Fallback một tiến trình (REDIS_ENABLED=false ngoài production) và unit test - dùng Date.now() để fake timers điều khiển được */
export class InMemoryIdentityStateStore implements IdentityStateStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSec: number) {
    this.entries.set(key, { value, expiresAt: Date.now() + Math.max(1, Math.ceil(ttlSec)) * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSec: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  async increment(key: string, ttlSec: number) {
    const entry = this.live(key);
    if (!entry) {
      await this.set(key, '1', ttlSec);
      return 1;
    }
    entry.value = String(Number(entry.value) + 1);
    return Number(entry.value);
  }

  async expire(key: string, ttlSec: number) {
    const entry = this.live(key);
    if (entry) entry.expiresAt = Date.now() + Math.max(1, Math.ceil(ttlSec)) * 1000;
  }

  async delete(...keys: string[]) {
    let removed = 0;
    for (const key of keys) if (this.live(key) && this.entries.delete(key)) removed++;
    return removed;
  }

  async ttl(key: string) {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : 0;
  }
}

export function createIdentityStateStore(redis: Redis | null | undefined, isProduction: boolean): IdentityStateStore {
  if (redis) return new RedisIdentityStateStore(redis);
  if (isProduction) {
    throw new Error('IdentityModule requires Redis in production (OTP, login locks and session revocation are shared across Pods).');
  }
  new Logger('IdentityStateStore').warn('Redis is disabled: OTP and login locks are kept in process memory (single instance only).');
  return new InMemoryIdentityStateStore();
}
