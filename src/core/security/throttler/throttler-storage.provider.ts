/**
 * Bộ nhớ lưu trữ Throttler: Redis (đếm chung giữa các Pod) hoặc bộ nhớ trong tiến trình (dev/test).
 */
import type Redis from 'ioredis';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Fixed-window counter + block window, nguyên tử trong một lần gọi Lua.
 * KEYS[1]=hits, KEYS[2]=block; ARGV: ttlMs, limit, blockDurationMs
 * Trả về: {totalHits, hitsTtlMs, isBlocked(0/1), blockTtlMs}
 */
const INCREMENT_LUA = `
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockTtl}
end

local hits = redis.call('INCR', KEYS[1])
local hitsTtl = redis.call('PTTL', KEYS[1])
if hitsTtl < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  hitsTtl = ttl
end

if hits > limit then
  redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
  return {hits, hitsTtl, 1, blockDuration}
end
return {hits, hitsTtl, 0, 0}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    const [totalHits, hitsTtlMs, blocked, blockTtlMs] = (await this.redis.eval(
      INCREMENT_LUA,
      2,
      `${base}:hits`,
      `${base}:block`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(hitsTtlMs / 1000),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockTtlMs / 1000),
    };
  }
}

export function createThrottlerStorage(redis: Redis | null): ThrottlerStorage {
  return redis ? new RedisThrottlerStorage(redis) : new ThrottlerStorageService();
}
