/**
 * Tầng trừu tượng hóa lưu trữ trạng thái Idempotency:
 *  - Redis (production, multi-pod): khóa nguyên tử SET NX EX, giải phóng khóa bằng Lua compare-and-delete.
 *  - Bộ nhớ trong tiến trình (unit test / dev khi REDIS_ENABLED=false).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IdempotencyRecord } from './idempotency.interface';
import { IDEMPOTENCY_REDIS_PREFIX } from './idempotency.constants';

const MEMORY_SWEEP_INTERVAL_MS = 60_000;

/** Chỉ xóa khi bản ghi vẫn IN_PROGRESS của đúng request (không xóa nhầm kết quả COMPLETED) */
const RELEASE_LOCK_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.status == 'IN_PROGRESS' and record.fingerprint == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class IdempotencyStorageService {
  private readonly memoryStore = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  private lastSweep = Date.now();

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null) {}

  private buildKey(idempotencyKey: string): string {
    return `${IDEMPOTENCY_REDIS_PREFIX}:${idempotencyKey}`;
  }

  /**
   * Khóa tài nguyên dạng nguyên tử (Atomic Lock) khi bắt đầu xử lý request.
   * Trả về true nếu lấy khóa thành công, false nếu khóa đã tồn tại (đang xử lý hoặc đã xong)
   */
  async acquireLock(key: string, fingerprint: string, lockTtlSeconds: number): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const record: IdempotencyRecord = { status: 'IN_PROGRESS', fingerprint, createdAt: Date.now() };

    if (this.redis) {
      const result = await this.redis.set(fullKey, JSON.stringify(record), 'EX', lockTtlSeconds, 'NX');
      return result === 'OK';
    }

    this.sweepMemory();
    const existing = this.memoryStore.get(fullKey);
    if (existing && existing.expiresAt > Date.now()) {
      return false;
    }
    this.memoryStore.set(fullKey, { record, expiresAt: Date.now() + lockTtlSeconds * 1000 });
    return true;
  }

  /**
   * Lấy bản ghi Idempotency hiện tại
   */
  async getRecord(key: string): Promise<IdempotencyRecord | null> {
    const fullKey = this.buildKey(key);

    if (this.redis) {
      const raw = await this.redis.get(fullKey);
      return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
    }

    const item = this.memoryStore.get(fullKey);
    if (item && item.expiresAt > Date.now()) {
      return item.record;
    }
    return null;
  }

  /**
   * Lưu kết quả thành công và chuyển trạng thái sang COMPLETED
   */
  async markCompleted(
    key: string,
    fingerprint: string,
    statusCode: number,
    response: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    const fullKey = this.buildKey(key);
    const record: IdempotencyRecord = {
      status: 'COMPLETED',
      fingerprint,
      statusCode,
      response,
      createdAt: Date.now(),
    };

    if (this.redis) {
      await this.redis.set(fullKey, JSON.stringify(record), 'EX', ttlSeconds);
      return;
    }

    this.memoryStore.set(fullKey, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /**
   * Giải phóng khóa khi xử lý thất bại (5xx, Exception) để cho phép client retry
   */
  async releaseLock(key: string, fingerprint: string): Promise<void> {
    const fullKey = this.buildKey(key);

    if (this.redis) {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, fullKey, fingerprint);
      return;
    }

    const item = this.memoryStore.get(fullKey);
    if (item?.record.status === 'IN_PROGRESS' && item.record.fingerprint === fingerprint) {
      this.memoryStore.delete(fullKey);
    }
  }

  /** Dọn bản ghi hết hạn để Map không phình vô hạn */
  private sweepMemory(): void {
    const now = Date.now();
    if (now - this.lastSweep < MEMORY_SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, item] of this.memoryStore) {
      if (item.expiresAt <= now) this.memoryStore.delete(key);
    }
  }
}
