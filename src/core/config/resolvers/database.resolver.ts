/**
 * Phân giải biến môi trường thành cấu hình kết nối PostgreSQL có kiểu tĩnh.
 * Không phụ thuộc NestJS để dùng chung cho runtime, TypeORM CLI và migration runner.
 */
import { isIP } from 'net';
import type { EnvConfig } from '../env.schema';
import { stripIpv6Brackets } from '../schemas/env.helpers';
import { readPemOrPath } from './pem.util';

export type DbSslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
export type DbPoolMode = 'session' | 'transaction';
export type DbProvider = 'supabase-pooler' | 'supabase-direct' | 'postgres';

export interface DatabaseNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface DatabaseSslOptions {
  rejectUnauthorized: boolean;
  ca?: string;
  /** verify-ca: xác thực chuỗi CA nhưng bỏ qua kiểm tra hostname */
  checkServerIdentity?: () => undefined;
}

export interface DatabaseConnectionConfig {
  master: DatabaseNodeConfig;
  replica?: DatabaseNodeConfig;
  provider: DbProvider;
  sslMode: DbSslMode;
  ssl: false | DatabaseSslOptions;
  ipFamily: 0 | 4 | 6;
  poolMode: DbPoolMode;
  schema: string;
  applicationName: string;
  pool: {
    max: number;
    min: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
    maxLifetimeSeconds: number;
  };
  statementTimeoutMs: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs: number;
  slowQueryMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  logQueries: boolean;
  migrationsRun: boolean;
  rlsRoleCheck: 'off' | 'warn' | 'error';
}

const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/i;
const SUPABASE_DIRECT_HOST = /^db\.[a-z0-9]+\.supabase\.co$/i;
/** Cổng mặc định của PgBouncer / Supavisor ở transaction mode */
const TRANSACTION_POOLER_PORT = 6543;

interface ParsedUrl {
  node: DatabaseNodeConfig;
  sslMode?: DbSslMode;
}

function parseConnectionUrl(raw: string): ParsedUrl {
  const url = new URL(raw);
  return {
    node: {
      host: stripIpv6Brackets(url.hostname),
      port: url.port ? Number(url.port) : 5432,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    },
    sslMode: (url.searchParams.get('sslmode') as DbSslMode | null) ?? undefined,
  };
}

export function detectDbProvider(host: string): DbProvider {
  if (SUPABASE_POOLER_HOST.test(host)) return 'supabase-pooler';
  if (SUPABASE_DIRECT_HOST.test(host)) return 'supabase-direct';
  return 'postgres';
}

/**
 * Transaction pooler (Supavisor :6543, Supabase dedicated pooler :6543, PgBouncer transaction mode)
 * không cho phép startup parameter như statement_timeout và không giữ trạng thái phiên (SET, LISTEN).
 */
export function detectPoolMode(host: string, port: number, explicit?: DbPoolMode): DbPoolMode {
  if (explicit) return explicit;
  const provider = detectDbProvider(host);
  if (provider !== 'postgres' && port === TRANSACTION_POOLER_PORT) return 'transaction';
  return 'session';
}

function buildSslOptions(mode: DbSslMode, caValue: string | undefined): false | DatabaseSslOptions {
  if (mode === 'disable') return false;
  const ca = readPemOrPath(caValue);
  switch (mode) {
    case 'prefer':
    case 'require':
      // Mã hóa đường truyền nhưng KHÔNG xác thực server (tương đương libpq sslmode=require)
      return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { rejectUnauthorized: true, ca };
  }
}

export function resolveDatabaseConfig(env: EnvConfig): DatabaseConnectionConfig {
  const fromUrl = env.DATABASE_URL ? parseConnectionUrl(env.DATABASE_URL) : undefined;

  const master: DatabaseNodeConfig = fromUrl?.node ?? {
    host: stripIpv6Brackets(env.DB_MASTER_HOST as string),
    port: env.DB_MASTER_PORT,
    username: env.DB_MASTER_USER as string,
    password: env.DB_MASTER_PASSWORD as string,
    database: env.DB_NAME as string,
  };

  let replica: DatabaseNodeConfig | undefined;
  if (env.DATABASE_REPLICA_URL) {
    replica = parseConnectionUrl(env.DATABASE_REPLICA_URL).node;
  } else if (env.DB_REPLICA_HOST) {
    replica = {
      host: stripIpv6Brackets(env.DB_REPLICA_HOST),
      port: env.DB_REPLICA_PORT,
      username: env.DB_REPLICA_USER as string,
      password: env.DB_REPLICA_PASSWORD as string,
      database: master.database,
    };
  }

  const provider = detectDbProvider(master.host);
  // Supabase bắt buộc TLS: mặc định 'require' nếu người dùng không chỉ định
  const sslMode: DbSslMode =
    env.DB_SSL_MODE ?? fromUrl?.sslMode ?? (provider === 'postgres' ? 'disable' : 'require');

  const statementTimeoutMs = env.DB_STATEMENT_TIMEOUT_MS;

  return {
    master,
    replica,
    provider,
    sslMode,
    ssl: buildSslOptions(sslMode, env.DB_SSL_CA),
    ipFamily: env.DB_IP_FAMILY,
    poolMode: detectPoolMode(master.host, master.port, env.DB_POOL_MODE),
    schema: env.DB_SCHEMA,
    applicationName: env.DB_APPLICATION_NAME,
    pool: {
      max: env.DB_POOL_MAX,
      min: env.DB_POOL_MIN,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
      maxLifetimeSeconds: env.DB_MAX_LIFETIME_SECONDS,
    },
    statementTimeoutMs,
    lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS || undefined,
    idleInTransactionTimeoutMs: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS || statementTimeoutMs * 2,
    slowQueryMs: env.DB_SLOW_QUERY_MS,
    retryAttempts: env.DB_RETRY_ATTEMPTS ?? (env.NODE_ENV === 'production' ? 10 : 3),
    retryDelayMs: env.DB_RETRY_DELAY_MS,
    logQueries: env.DB_LOG_QUERIES,
    migrationsRun: env.DB_MIGRATIONS_RUN,
    rlsRoleCheck: env.DB_RLS_ROLE_CHECK,
  };
}

/** Mô tả an toàn (không chứa mật khẩu) phục vụ log khởi động */
export function describeDatabaseTarget(node: DatabaseNodeConfig): string {
  const host = isIP(node.host) === 6 ? `[${node.host}]` : node.host;
  return `${node.username}@${host}:${node.port}/${node.database}`;
}
