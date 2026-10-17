/**
 * Nhóm biến: PostgreSQL (TypeORM).
 *
 * Hai cách khai báo, có thể kết hợp:
 *  - DATABASE_URL (connection string Supabase / Heroku / Render...) - ưu tiên cao nhất.
 *  - Biến rời DB_MASTER_* (thuận tiện cho PostgreSQL cài trực tiếp trên máy / K8s Secret).
 *
 * Họ địa chỉ IP (DB_IP_FAMILY):
 *  - Supabase direct  `db.<ref>.supabase.co:5432`        → CHỈ IPv6 (trừ khi mua IPv4 add-on).
 *  - Supabase pooler  `aws-<n>-<region>.pooler.supabase.com` → CHỈ IPv4 (session 5432 / transaction 6543).
 *  - PostgreSQL local cài trên Windows lắng nghe cả 0.0.0.0 và ::  → có thể ép IPv6 (::1).
 */
import { isIP } from 'net';
import { z } from 'zod';
import {
  addIssue,
  assertPemOrPath,
  envBool,
  envEnum,
  envInt,
  envIpFamily,
  envOptionalEnum,
  envOptionalInt,
  envOptionalString,
  envString,
  parseUrlSafe,
  stripIpv6Brackets,
  ZodRefineCtx,
} from './env.helpers';

export const DB_SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

export const databaseEnvShape = {
  // Connection string (ưu tiên hơn DB_MASTER_*): postgresql://user:pass@host:5432/db?sslmode=require
  DATABASE_URL: envOptionalString(),
  DATABASE_REPLICA_URL: envOptionalString(),

  // PostgreSQL Master (Write Node) - bắt buộc khi không dùng DATABASE_URL
  DB_MASTER_HOST: envOptionalString(),
  DB_MASTER_PORT: envInt(5432, 1, 65535),
  DB_MASTER_USER: envOptionalString(),
  DB_MASTER_PASSWORD: envOptionalString(),
  DB_NAME: envOptionalString(),

  // PostgreSQL Replica (Read Node) - tùy chọn, bỏ trống sẽ đọc/ghi trên Master (một pool duy nhất)
  DB_REPLICA_HOST: envOptionalString(),
  DB_REPLICA_PORT: envInt(5432, 1, 65535),
  DB_REPLICA_USER: envOptionalString(),
  DB_REPLICA_PASSWORD: envOptionalString(),

  // TLS: bỏ trống → lấy theo ?sslmode của DATABASE_URL, mặc định 'disable'
  DB_SSL_MODE: envOptionalEnum(DB_SSL_MODES),
  // CA của Supabase (prod-ca-2021.crt) hoặc RDS: PEM nội tuyến hoặc đường dẫn file (cần cho verify-ca/verify-full)
  DB_SSL_CA: envOptionalString(),

  DB_IP_FAMILY: envIpFamily(),
  // 'transaction' (Supavisor/PgBouncer 6543): không gửi startup parameter như statement_timeout.
  // Bỏ trống → tự nhận diện theo host/port.
  DB_POOL_MODE: envOptionalEnum(['session', 'transaction'] as const),
  DB_SCHEMA: envString('public'),
  DB_APPLICATION_NAME: envString('room-management-api'),

  // Connection Pool & Timeouts
  DB_POOL_MAX: envInt(20, 1),
  DB_POOL_MIN: envInt(2, 0),
  DB_CONNECTION_TIMEOUT_MS: envInt(5000, 100),
  DB_IDLE_TIMEOUT_MS: envInt(30000, 1000),
  // Tái tạo kết nối định kỳ (DNS failover / pooler rebalancing). 0 = không giới hạn
  DB_MAX_LIFETIME_SECONDS: envInt(0, 0),
  DB_STATEMENT_TIMEOUT_MS: envInt(15000, 100),
  DB_LOCK_TIMEOUT_MS: envOptionalInt(0),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: envOptionalInt(0),
  DB_SLOW_QUERY_MS: envInt(500, 1),
  DB_RETRY_ATTEMPTS: envOptionalInt(0, 100),
  DB_RETRY_DELAY_MS: envInt(3000, 0),
  DB_LOG_QUERIES: envBool(false),

  // Chỉ dành cho máy local: production chạy migration bằng Job/InitContainer riêng
  DB_MIGRATIONS_RUN: envBool(false),
  // Kiểm tra role kết nối KHÔNG phải superuser/BYPASSRLS (nếu có, RLS đa tenant mất tác dụng)
  DB_RLS_ROLE_CHECK: envEnum(['off', 'warn', 'error'] as const, 'warn'),
};

type DatabaseEnv = z.infer<z.ZodObject<typeof databaseEnvShape>> & { NODE_ENV: string };

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

function validateConnectionUrl(ctx: ZodRefineCtx, name: string, raw: string): URL | null {
  const url = parseUrlSafe(raw);
  if (!url || !POSTGRES_PROTOCOLS.has(url.protocol)) {
    addIssue(ctx, name, `${name} must be a valid postgres:// or postgresql:// connection string`);
    return null;
  }
  if (!url.hostname) addIssue(ctx, name, `${name} must include a host`);
  if (!url.username) addIssue(ctx, name, `${name} must include a username`);
  if (url.pathname.replace(/^\//, '') === '') {
    addIssue(ctx, name, `${name} must include a database name (…/postgres)`);
  }
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !(DB_SSL_MODES as readonly string[]).includes(sslmode)) {
    addIssue(ctx, name, `${name} has unsupported sslmode '${sslmode}' (allowed: ${DB_SSL_MODES.join(', ')})`);
  }
  return url;
}

function assertFamilyMatchesHost(
  ctx: ZodRefineCtx,
  path: string,
  host: string | undefined,
  family: 0 | 4 | 6,
): void {
  if (!host || family === 0) return;
  const literalFamily = isIP(stripIpv6Brackets(host));
  if (literalFamily !== 0 && literalFamily !== family) {
    addIssue(
      ctx,
      'DB_IP_FAMILY',
      `DB_IP_FAMILY=${family} contradicts ${path} '${host}' (an IPv${literalFamily} literal)`,
    );
  }
}

export function refineDatabaseEnv(env: DatabaseEnv, ctx: ZodRefineCtx): void {
  let masterHost = env.DB_MASTER_HOST;

  if (env.DATABASE_URL) {
    const url = validateConnectionUrl(ctx, 'DATABASE_URL', env.DATABASE_URL);
    masterHost = url ? stripIpv6Brackets(url.hostname) : masterHost;
  } else {
    const required: Array<keyof DatabaseEnv> = [
      'DB_MASTER_HOST',
      'DB_MASTER_USER',
      'DB_MASTER_PASSWORD',
      'DB_NAME',
    ];
    for (const key of required) {
      if (!env[key]) addIssue(ctx, key, `${key} is required (or set DATABASE_URL)`);
    }
  }

  if (env.DATABASE_REPLICA_URL) {
    validateConnectionUrl(ctx, 'DATABASE_REPLICA_URL', env.DATABASE_REPLICA_URL);
  } else if (env.DB_REPLICA_HOST && (!env.DB_REPLICA_USER || !env.DB_REPLICA_PASSWORD)) {
    addIssue(
      ctx,
      'DB_REPLICA_USER',
      'DB_REPLICA_USER and DB_REPLICA_PASSWORD are required when DB_REPLICA_HOST is set',
    );
  }

  assertFamilyMatchesHost(ctx, env.DATABASE_URL ? 'DATABASE_URL host' : 'DB_MASTER_HOST', masterHost, env.DB_IP_FAMILY);

  if (env.DB_POOL_MIN > env.DB_POOL_MAX) {
    addIssue(ctx, 'DB_POOL_MIN', 'DB_POOL_MIN must be <= DB_POOL_MAX');
  }

  assertPemOrPath(ctx, 'DB_SSL_CA', env.DB_SSL_CA);

  if (env.NODE_ENV === 'production' && env.DB_MIGRATIONS_RUN) {
    addIssue(
      ctx,
      'DB_MIGRATIONS_RUN',
      'DB_MIGRATIONS_RUN must be false in production (run migrations from a Kubernetes Job / InitContainer)',
    );
  }
}
