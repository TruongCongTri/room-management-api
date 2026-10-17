/**
 * Nhóm biến: Redis (Cache, Distributed Lock, Throttler, Idempotency, Permission cache, BullMQ, Socket.IO).
 *
 *  - Local Docker:  REDIS_HOST=127.0.0.1 REDIS_PORT=6379 (docker compose up -d redis)
 *  - Online:        REDIS_URL=rediss://default:<password>@<host>:6379  (Upstash / Redis Cloud / Aiven / ElastiCache TLS)
 *  - HA tự quản:    REDIS_MODE=sentinel REDIS_SENTINELS=10.0.0.1:26379,10.0.0.2:26379
 */
import { z } from 'zod';
import {
  addIssue,
  assertPemOrPath,
  envBool,
  envEnum,
  envInt,
  envIpFamily,
  envOptionalString,
  envString,
  parseUrlSafe,
  ZodRefineCtx,
} from './env.helpers';

export const redisEnvShape = {
  REDIS_ENABLED: envBool(true),
  // Connection string (ưu tiên hơn REDIS_HOST/PORT/USERNAME/PASSWORD/DB/TLS). rediss:// = bật TLS
  REDIS_URL: envOptionalString(),
  REDIS_MODE: envEnum(['standalone', 'sentinel'] as const, 'standalone'),

  REDIS_HOST: envString('127.0.0.1'),
  REDIS_PORT: envInt(6379, 1, 65535),
  REDIS_USERNAME: envOptionalString(),
  REDIS_PASSWORD: envOptionalString(),
  REDIS_DB: envInt(0, 0, 15),

  REDIS_TLS: envBool(false),
  REDIS_TLS_REJECT_UNAUTHORIZED: envBool(true),
  REDIS_TLS_CA: envOptionalString(),

  // 0 = tự động, 6 = bắt buộc IPv6 (vd: Upstash qua mạng nội bộ Fly.io), 4 = chỉ IPv4
  REDIS_FAMILY: envIpFamily(),
  REDIS_KEY_PREFIX: envString('rma:'),
  REDIS_CONNECT_TIMEOUT_MS: envInt(10000, 100),
  // Timeout cho lệnh thường (không áp dụng cho kết nối blocking của BullMQ). 0 = tắt
  REDIS_COMMAND_TIMEOUT_MS: envInt(5000, 0),

  // Sentinel
  REDIS_SENTINELS: envOptionalString(),
  REDIS_SENTINEL_NAME: envString('mymaster'),
  REDIS_SENTINEL_PASSWORD: envOptionalString(),
};

type RedisEnv = z.infer<z.ZodObject<typeof redisEnvShape>> & { NODE_ENV: string };

const SENTINEL_ENTRY = /^[^\s:,]+:\d{1,5}$/;

export function refineRedisEnv(env: RedisEnv, ctx: ZodRefineCtx): void {
  if (env.REDIS_URL) {
    const url = parseUrlSafe(env.REDIS_URL);
    if (!url || !['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
      addIssue(ctx, 'REDIS_URL', 'REDIS_URL must be a valid redis:// or rediss:// URL');
    } else if (url.pathname.length > 1 && !/^\/\d{1,2}$/.test(url.pathname)) {
      addIssue(ctx, 'REDIS_URL', 'REDIS_URL database index must be a number (e.g. redis://host:6379/0)');
    }
  }

  if (env.REDIS_MODE === 'sentinel') {
    const entries = (env.REDIS_SENTINELS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      addIssue(ctx, 'REDIS_SENTINELS', 'REDIS_SENTINELS is required when REDIS_MODE=sentinel ("host:port,host:port")');
    } else if (!entries.every((entry) => SENTINEL_ENTRY.test(entry))) {
      addIssue(ctx, 'REDIS_SENTINELS', 'REDIS_SENTINELS must be a comma-separated list of "host:port"');
    }
    if (env.REDIS_URL) {
      addIssue(ctx, 'REDIS_URL', 'REDIS_URL cannot be combined with REDIS_MODE=sentinel');
    }
  }

  assertPemOrPath(ctx, 'REDIS_TLS_CA', env.REDIS_TLS_CA);

  if (env.NODE_ENV === 'production' && !env.REDIS_ENABLED) {
    addIssue(
      ctx,
      'REDIS_ENABLED',
      'Redis is mandatory in production (rate limit, idempotency and permission cache must be shared across pods)',
    );
  }
}
