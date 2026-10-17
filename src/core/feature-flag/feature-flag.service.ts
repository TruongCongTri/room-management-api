/**
 * Quản trị tính năng từ xa (Feature Flag) không cần build/deploy lại:
 *  - Giá trị nền khai báo qua FEATURE_FLAGS (JSON) trong ConfigMap.
 *  - Override runtime lưu trong Redis (hash `feature_flags`) - dùng chung cho mọi Pod; mỗi Pod đồng bộ lại
 *    sau FEATURE_FLAG_CACHE_TTL_MS nên isEnabled() luôn đồng bộ, không tốn round-trip Redis trên mỗi request.
 *  - Canary theo phần trăm (băm ổn định theo user → tenant), allowlist theo tenant / user.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { RequestContextService } from '../context/request-context.service';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { FeatureFlagRule } from '../config/schemas/app.schema';

export type { FeatureFlagRule } from '../config/schemas/app.schema';

const REDIS_HASH_KEY = 'feature_flags';

@Injectable()
export class FeatureFlagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly defaults: Map<string, FeatureFlagRule>;
  private overrides = new Map<string, FeatureFlagRule>();
  private refreshTimer?: NodeJS.Timeout;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly contextService: RequestContextService,
    @Optional() config?: AppConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {
    this.defaults = new Map(Object.entries(config?.featureFlags.defaults ?? {}));
    this.cacheTtlMs = config?.featureFlags.cacheTtlMs ?? 10_000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis) return;
    await this.refresh();
    if (this.cacheTtlMs > 0) {
      this.refreshTimer = setInterval(() => void this.refresh(), this.cacheTtlMs);
      this.refreshTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /**
   * Đánh giá xem feature flag có kích hoạt cho ngữ cảnh hiện tại hay không
   */
  isEnabled(flagKey: string): boolean {
    const rule = this.getRule(flagKey);
    if (!rule || !rule.enabled) {
      return false;
    }

    const tenantId = this.contextService.getTenantId();
    const userId = this.contextService.getUserId();

    if (rule.allowedTenantIds?.length && (!tenantId || !rule.allowedTenantIds.includes(tenantId))) {
      return false;
    }
    if (rule.allowedUserIds?.length && (!userId || !rule.allowedUserIds.includes(userId))) {
      return false;
    }

    // Canary rollout theo tỷ lệ phần trăm: cùng user luôn rơi vào cùng bucket (trải nghiệm nhất quán)
    if (typeof rule.percentage === 'number' && rule.percentage < 100) {
      const identifier = userId || tenantId || 'anonymous';
      return this.calculateHashBucket(flagKey, identifier) < rule.percentage;
    }

    return true;
  }

  getRule(flagKey: string): FeatureFlagRule | undefined {
    return this.overrides.get(flagKey) ?? this.defaults.get(flagKey);
  }

  getAllFlags(): Record<string, FeatureFlagRule> {
    return Object.fromEntries([...this.defaults, ...this.overrides]);
  }

  /**
   * Bật/tắt hoặc đổi tỷ lệ canary ngay lập tức (lan tới mọi Pod qua Redis trong FEATURE_FLAG_CACHE_TTL_MS)
   */
  async setFlag(flagKey: string, rule: FeatureFlagRule): Promise<void> {
    this.overrides.set(flagKey, rule);
    await this.redis?.hset(REDIS_HASH_KEY, flagKey, JSON.stringify(rule));
    this.logger.log(`Feature flag '${flagKey}' updated: ${JSON.stringify(rule)}`);
  }

  /** Gỡ override runtime, quay về giá trị nền của FEATURE_FLAGS */
  async clearOverride(flagKey: string): Promise<void> {
    this.overrides.delete(flagKey);
    await this.redis?.hdel(REDIS_HASH_KEY, flagKey);
  }

  private async refresh(): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') return;
    try {
      const raw = await this.redis.hgetall(REDIS_HASH_KEY);
      const next = new Map<string, FeatureFlagRule>();
      for (const [key, value] of Object.entries(raw)) {
        try {
          next.set(key, JSON.parse(value) as FeatureFlagRule);
        } catch {
          this.logger.warn(`Ignoring malformed feature flag override '${key}'.`);
        }
      }
      this.overrides = next;
    } catch (err: any) {
      // Giữ nguyên override đã biết khi Redis gián đoạn (fail-static)
      this.logger.warn(`Feature flag refresh failed: ${err.message}`);
    }
  }

  private calculateHashBucket(flagKey: string, identifier: string): number {
    const hash = createHash('sha256').update(`${flagKey}:${identifier}`).digest();
    return hash.readUInt32BE(0) % 100; // Trả về số nguyên từ 0 - 99
  }
}
