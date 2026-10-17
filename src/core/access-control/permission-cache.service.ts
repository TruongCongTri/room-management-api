/**
 * Cache ma trận quyền đã làm phẳng (flattened & deduplicated) theo user_id,
 * tránh query bảng Role/Permission ở mọi request.
 * Redis khi được bật (chia sẻ giữa các Pod), fallback bộ nhớ trong tiến trình.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { EffectivePermissionRule } from './access-control.types';

const KEY_PREFIX = 'permissions:user:';
const DEFAULT_TTL_SECONDS = 3600;
const MEMORY_MAX_ENTRIES = 10_000;

@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name);
  private readonly memoryFallback = new Map<
    string,
    { rules: EffectivePermissionRule[]; expiresAt: number }
  >();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null,
  ) {}

  /**
   * Lưu ma trận quyền đã làm phẳng vào Cache. Key pattern: permissions:user:{userId}
   */
  async cacheUserPermissions(
    userId: string,
    rules: EffectivePermissionRule[],
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    const deduplicated = this.deduplicate(rules);
    try {
      if (this.redis) {
        await this.redis.set(this.key(userId), JSON.stringify(deduplicated), 'EX', ttlSeconds);
        return;
      }
      this.setMemory(userId, deduplicated, ttlSeconds);
    } catch (err: any) {
      this.logger.error(`Failed to cache permissions for user ${userId}: ${err.message}`);
    }
  }

  /**
   * Lấy danh sách quyền từ Cache (null nếu miss hoặc cache lỗi → caller tải lại từ DB)
   */
  async getUserPermissions(userId: string): Promise<EffectivePermissionRule[] | null> {
    try {
      if (this.redis) {
        const raw = await this.redis.get(this.key(userId));
        return raw ? (JSON.parse(raw) as EffectivePermissionRule[]) : null;
      }
      const cached = this.memoryFallback.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.rules;
      }
      this.memoryFallback.delete(userId);
      return null;
    } catch (err: any) {
      this.logger.warn(`Permission cache read failed for user ${userId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Cache-aside: trả quyền từ cache, nếu miss thì gọi loader (DB) và ghi lại cache
   */
  async getOrLoad(
    userId: string,
    loader: () => Promise<EffectivePermissionRule[]>,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<EffectivePermissionRule[]> {
    const cached = await this.getUserPermissions(userId);
    if (cached) return cached;

    const rules = await loader();
    await this.cacheUserPermissions(userId, rules, ttlSeconds);
    return this.deduplicate(rules);
  }

  /**
   * Xóa cache khi user được gán Role mới hoặc phân quyền thay đổi
   */
  async invalidateUserPermissions(userId: string): Promise<void> {
    this.memoryFallback.delete(userId);
    try {
      await this.redis?.del(this.key(userId));
    } catch (err: any) {
      this.logger.error(`Failed to invalidate permissions for user ${userId}: ${err.message}`);
      throw err; // Không nuốt lỗi: quyền cũ có thể còn hiệu lực tới khi TTL hết
    }
  }

  private key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
  }

  private deduplicate(rules: EffectivePermissionRule[]): EffectivePermissionRule[] {
    const seen = new Map<string, EffectivePermissionRule>();
    for (const rule of rules) {
      const id = `${rule.resource}:${rule.action}:${rule.scope}:${rule.effect}:${JSON.stringify(rule.conditions ?? null)}`;
      seen.set(id, rule);
    }
    return [...seen.values()];
  }

  private setMemory(userId: string, rules: EffectivePermissionRule[], ttlSeconds: number): void {
    if (this.memoryFallback.size >= MEMORY_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of this.memoryFallback) {
        if (entry.expiresAt <= now) this.memoryFallback.delete(key);
      }
      // Vẫn đầy: loại entry cũ nhất (Map giữ thứ tự chèn)
      if (this.memoryFallback.size >= MEMORY_MAX_ENTRIES) {
        const oldest = this.memoryFallback.keys().next().value;
        if (oldest !== undefined) this.memoryFallback.delete(oldest);
      }
    }
    this.memoryFallback.set(userId, { rules, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
