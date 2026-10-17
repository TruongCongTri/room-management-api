import { join } from 'path';
import { Logger } from '@nestjs/common';
import { DataSourceOptions, Logger as TypeOrmLogger } from 'typeorm';
import type { AppConfigService } from '../config/app-config.service';
import type {
  DatabaseConnectionConfig,
  DatabaseNodeConfig,
} from '../config/resolvers/database.resolver';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { createFamilyPinnedStream } from './database.network';

export const MIGRATIONS_TABLE = 'typeorm_migrations';

/**
 * Tham số pg-pool / pg Client (TypeORM chuyển nguyên `extra` xuống driver).
 * Transaction pooler (Supavisor :6543) từ chối startup parameter như statement_timeout,
 * nên các timeout phía server chỉ được gửi ở session mode / kết nối trực tiếp.
 */
export function buildDriverExtra(db: DatabaseConnectionConfig): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    // 1. Quản trị kích thước Connection Pool
    max: db.pool.max,
    min: db.pool.min,
    idleTimeoutMillis: db.pool.idleTimeoutMs,
    connectionTimeoutMillis: db.pool.connectionTimeoutMs,

    // 2. Tự động phát hiện & ngắt kết nối chết (Dead Connection Reaping)
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,

    // 3. Ngắt câu query treo phía driver (luôn áp dụng, kể cả qua pooler)
    query_timeout: db.statementTimeoutMs + 1000,
  };

  if (db.pool.maxLifetimeSeconds > 0) {
    extra.maxLifetimeSeconds = db.pool.maxLifetimeSeconds;
  }

  if (db.poolMode === 'session') {
    // Ngắt câu query treo phía server và không giữ transaction mở vô thời hạn (khóa dòng/bảng)
    extra.statement_timeout = db.statementTimeoutMs;
    extra.idle_in_transaction_session_timeout = db.idleInTransactionTimeoutMs;
    if (db.lockTimeoutMs) extra.lock_timeout = db.lockTimeoutMs;
  }

  // Ép IPv4 / IPv6 cho mọi socket của pool (Supabase pooler: IPv4, direct / local ::1: IPv6)
  if (db.ipFamily !== 0) {
    extra.stream = createFamilyPinnedStream(db.ipFamily);
  }

  return extra;
}

function toCredentials(node: DatabaseNodeConfig, db: DatabaseConnectionConfig) {
  return {
    host: node.host,
    port: node.port,
    username: node.username,
    password: node.password,
    database: node.database,
    ssl: db.ssl,
  };
}

/**
 * Cấu hình DataSource dùng chung cho runtime (DatabaseModule) và TypeORM CLI (data-source.ts),
 * đảm bảo migration chạy với đúng naming strategy và tham số kết nối như ứng dụng.
 */
export function buildDataSourceOptions(
  config: AppConfigService,
  logger?: TypeOrmLogger,
): DataSourceOptions {
  const db = config.database;
  const poolLogger = new Logger('PostgresPool');

  // Chỉ bật replication khi có Replica thật: nếu không, TypeORM tạo pool thứ hai trỏ về Master,
  // nhân đôi số kết nối (đắt đỏ với giới hạn connection của Supabase / RDS).
  const connection = db.replica
    ? {
        replication: {
          master: toCredentials(db.master, db),
          slaves: [toCredentials(db.replica, db)],
        },
      }
    : toCredentials(db.master, db);

  return {
    type: 'postgres',
    ...connection,
    schema: db.schema,
    applicationName: db.applicationName,
    connectTimeoutMS: db.pool.connectionTimeoutMs,
    extra: buildDriverExtra(db),
    // Lỗi của kết nối nhàn rỗi trong pool (DB restart, pooler cắt kết nối) không được làm sập process
    poolErrorHandler: (err: Error) => poolLogger.warn(`Idle PostgreSQL client error: ${err.message}`),
    // gen_random_uuid() có sẵn từ PostgreSQL 13 (không cần quyền CREATE EXTENSION trên Supabase/RDS)
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    namingStrategy: new SnakeNamingStrategy(),
    logger,
    synchronize: false, // Bắt buộc false: schema chỉ thay đổi qua migration
    migrationsRun: false, // Migration chạy bởi Job/InitContainer (DB_MIGRATIONS_RUN chỉ dành cho local)
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: MIGRATIONS_TABLE,
    maxQueryExecutionTime: db.slowQueryMs, // Kích hoạt logQuerySlow khi vượt ngưỡng
  };
}
