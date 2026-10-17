/**
 * Quản lý gắn thẻ (Tagging) và dọn dẹp hàng loạt key theo tag mà không dùng lệnh KEYS * làm nghẽn Redis:
 *  - Redis SET `tag:{buildingId}:{tag}` (vd: tag:{buildingId}:rooms) lưu danh sách key; xóa bằng UNLINK.
 *  - Chỉ mục trong RAM song song để vô hiệu hóa được cả các entry fallback/L1 của Pod hiện tại.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../core/redis/redis.constants';

const TAG_TTL_SECONDS = 7 * 24 * 3600;
const SCAN_BATCH = 500;
const MEMORY_MAX_TAGS = 10_000;
const MEMORY_MAX_KEYS_PER_TAG = 10_000;

@Injectable()
export class CacheTagManager {
  private readonly logger = new Logger(CacheTagManager.name);
  private readonly memoryTags = new Map<string, Set<string>>();

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redisClient: Redis | null = null) {}

  private getTagSetKey(buildingId: string, tag: string): string {
    return `tag:${buildingId}:${tag}`;
  }

  /**
   * Gắn danh sách tag cho một key cụ thể
   */
  async tagKey(tenantId: string, key: string, tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;

    for (const tag of tags) this.rememberInMemory(this.getTagSetKey(tenantId, tag), key);

    if (!this.redisClient || this.redisClient.status !== 'ready') return;
    const pipeline = this.redisClient.pipeline();
    for (const tag of tags) {
      const tagKey = this.getTagSetKey(tenantId, tag);
      pipeline.sadd(tagKey, key);
      // Tự động hết hạn tag set sau 7 ngày để tránh rác bộ nhớ
      pipeline.expire(tagKey, TAG_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  /**
   * Xóa toàn bộ key thuộc tag mà không khóa luồng đơn của Redis (SSCAN theo lô + UNLINK).
   * Trả về danh sách key đã vô hiệu hóa để service dọn cả bộ nhớ trong tiến trình.
   */
  async invalidateTag(tenantId: string, tag: string): Promise<string[]> {
    const tagKey = this.getTagSetKey(tenantId, tag);
    const keys = new Set(this.memoryTags.get(tagKey) ?? []);
    this.memoryTags.delete(tagKey);

    if (this.redisClient && this.redisClient.status === 'ready') {
      let cursor = '0';
      do {
        const [next, batch] = await this.redisClient.sscan(tagKey, cursor, 'COUNT', SCAN_BATCH);
        cursor = next;
        if (batch.length > 0) {
          await this.redisClient.unlink(...batch);
          batch.forEach((k) => keys.add(k));
        }
      } while (cursor !== '0');
      await this.redisClient.unlink(tagKey);
    }

    this.logger.debug(`[Cache] Invalidated ${keys.size} keys under tag '${tag}' for building '${tenantId}'`);
    return [...keys];
  }

  private rememberInMemory(tagKey: string, key: string): void {
    let keys = this.memoryTags.get(tagKey);
    if (!keys) {
      if (this.memoryTags.size >= MEMORY_MAX_TAGS) {
        const oldest = this.memoryTags.keys().next().value;
        if (oldest !== undefined) this.memoryTags.delete(oldest);
      }
      keys = new Set();
      this.memoryTags.set(tagKey, keys);
    }
    if (keys.size < MEMORY_MAX_KEYS_PER_TAG) keys.add(key);
  }
}
