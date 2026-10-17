/**
 * Chuẩn bị hạ tầng thật cho e2e: kiểm tra PostgreSQL/Redis đang chạy, chạy migration lên database kiểm thử
 * và dọn Redis DB kiểm thử để bộ đếm rate-limit / idempotency không rò rỉ giữa các lần chạy.
 */
import './e2e-env';
import Redis from 'ioredis';
import { runMigrations } from '../src/core/database/migration-runner';

export default async function globalSetup(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    db: Number(process.env.REDIS_DB),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    await redis.flushdb();
  } catch (err: any) {
    throw new Error(
      `[e2e] Redis is not reachable (${err.message}). Start the infrastructure first: docker compose --profile postgres up -d`,
    );
  } finally {
    redis.disconnect();
  }

  const exitCode = await runMigrations();
  if (exitCode !== 0) {
    throw new Error(
      '[e2e] Database migrations failed. Is PostgreSQL running (docker compose --profile postgres up -d) and does room_management_test exist?',
    );
  }
}
