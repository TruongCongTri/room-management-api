/**
 * Phân giải biến môi trường Redis thành cấu hình kết nối có kiểu tĩnh và tạo ioredis options
 * cho từng vai trò (client dùng chung, BullMQ, Socket.IO pub/sub).
 */
import { isIP } from 'net';
import type { RedisOptions } from 'ioredis';
import type { ConnectionOptions as TlsConnectionOptions } from 'tls';
import type { EnvConfig } from '../env.schema';
import { stripIpv6Brackets } from '../schemas/env.helpers';
import { readPemOrPath } from './pem.util';

export interface RedisTlsConfig {
  rejectUnauthorized: boolean;
  ca?: string;
  servername?: string;
}

export interface RedisConnectionConfig {
  enabled: boolean;
  mode: 'standalone' | 'sentinel';
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls: false | RedisTlsConfig;
  family: 0 | 4 | 6;
  keyPrefix: string;
  connectTimeoutMs: number;
  commandTimeoutMs?: number;
  sentinels?: Array<{ host: string; port: number }>;
  sentinelName?: string;
  sentinelPassword?: string;
  /** Nguồn cấu hình, phục vụ log khởi động */
  source: 'url' | 'discrete' | 'sentinel';
}

export function resolveRedisConfig(env: EnvConfig): RedisConnectionConfig {
  const base = {
    enabled: env.REDIS_ENABLED,
    family: env.REDIS_FAMILY,
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS || undefined,
  };

  const buildTls = (enabled: boolean, host: string): false | RedisTlsConfig =>
    enabled
      ? {
          rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
          ca: readPemOrPath(env.REDIS_TLS_CA),
          // SNI bắt buộc với dịch vụ managed (Upstash, Redis Cloud); không gửi SNI cho IP literal
          servername: isIP(host) === 0 ? host : undefined,
        }
      : false;

  if (env.REDIS_URL) {
    const url = new URL(env.REDIS_URL);
    const host = stripIpv6Brackets(url.hostname);
    const dbFromPath = url.pathname.replace(/^\//, '');
    return {
      ...base,
      mode: 'standalone',
      host,
      port: url.port ? Number(url.port) : 6379,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: dbFromPath ? Number(dbFromPath) : env.REDIS_DB,
      tls: buildTls(url.protocol === 'rediss:' || env.REDIS_TLS, host),
      source: 'url',
    };
  }

  const host = stripIpv6Brackets(env.REDIS_HOST);
  const common = {
    ...base,
    host,
    port: env.REDIS_PORT,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
    tls: buildTls(env.REDIS_TLS, host),
  };

  if (env.REDIS_MODE === 'sentinel') {
    return {
      ...common,
      mode: 'sentinel',
      sentinels: (env.REDIS_SENTINELS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.lastIndexOf(':');
          return { host: entry.slice(0, separator), port: Number(entry.slice(separator + 1)) };
        }),
      sentinelName: env.REDIS_SENTINEL_NAME,
      sentinelPassword: env.REDIS_SENTINEL_PASSWORD,
      source: 'sentinel',
    };
  }

  return { ...common, mode: 'standalone', source: 'discrete' };
}

export type RedisClientRole =
  /** Client dùng chung: cache, lock, throttler, idempotency... (có keyPrefix, fail-fast khi mất kết nối) */
  | 'shared'
  /** BullMQ: KHÔNG được dùng keyPrefix của ioredis (BullMQ dùng option `prefix` riêng), lệnh blocking không timeout */
  | 'bullmq'
  /** Socket.IO adapter pub/sub: kênh pub/sub không chịu ảnh hưởng keyPrefix, cần tự kết nối lại vô hạn */
  | 'pubsub';

/**
 * Tạo ioredis options theo vai trò. Toàn bộ thông số mạng (TLS, IP family, Sentinel)
 * đi qua một hàm duy nhất để mọi kết nối Redis trong ứng dụng hoạt động đồng nhất
 * với cả Redis local (Docker) lẫn Redis managed trên Internet.
 */
export function buildRedisOptions(
  config: RedisConnectionConfig,
  role: RedisClientRole,
  connectionName: string,
): RedisOptions {
  const tls: TlsConnectionOptions | undefined = config.tls
    ? {
        rejectUnauthorized: config.tls.rejectUnauthorized,
        ca: config.tls.ca,
        servername: config.tls.servername,
      }
    : undefined;

  const options: RedisOptions = {
    username: config.username,
    password: config.password,
    db: config.db,
    tls,
    family: config.family,
    connectionName,
    connectTimeout: config.connectTimeoutMs,
    keepAlive: 30000,
    // Giãn cách kết nối lại: 200ms → tối đa 5s, không bao giờ bỏ cuộc (Redis là hạ tầng bắt buộc)
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    // Failover ElastiCache/Sentinel: tự kết nối lại khi node chuyển sang read-only
    reconnectOnError: (err: Error) => err.message.startsWith('READONLY'),
  };

  if (config.mode === 'sentinel') {
    options.sentinels = config.sentinels;
    options.name = config.sentinelName;
    options.sentinelPassword = config.sentinelPassword;
    options.enableTLSForSentinelMode = !!tls;
  } else {
    options.host = config.host;
    options.port = config.port;
  }

  switch (role) {
    case 'shared':
      return {
        ...options,
        keyPrefix: config.keyPrefix,
        maxRetriesPerRequest: 2,
        commandTimeout: config.commandTimeoutMs,
        // Mất kết nối → lệnh lỗi ngay để caller fallback (memory store / fail-open) thay vì treo request
        enableOfflineQueue: false,
      };
    case 'bullmq':
      // Bắt buộc với Worker của BullMQ
      return { ...options, maxRetriesPerRequest: null };
    case 'pubsub':
      return { ...options, maxRetriesPerRequest: null };
  }
}

/** Mô tả an toàn (không chứa mật khẩu) phục vụ log khởi động / health */
export function describeRedisTarget(config: RedisConnectionConfig): string {
  if (config.mode === 'sentinel') {
    const nodes = (config.sentinels ?? []).map((s) => `${s.host}:${s.port}`).join(',');
    return `sentinel(${config.sentinelName})@${nodes}/${config.db}${config.tls ? ' [tls]' : ''}`;
  }
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  return `${config.tls ? 'rediss' : 'redis'}://${host}:${config.port}/${config.db}`;
}
