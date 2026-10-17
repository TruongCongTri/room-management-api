/**
 * Biến môi trường cho e2e: chạy với PostgreSQL + Redis THẬT của docker compose
 *   docker compose --profile postgres up -d
 * Dữ liệu được cô lập: database room_management_test, Redis DB 15, prefix khóa riêng.
 * Biến đã có sẵn trong môi trường CI sẽ không bị ghi đè.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  LOG_PRETTY: 'false',
  DB_MASTER_HOST: 'localhost',
  DB_MASTER_PORT: '5433',
  DB_MASTER_USER: 'postgres',
  DB_MASTER_PASSWORD: 'postgres',
  DB_NAME: 'room_management_test',
  DB_RLS_ROLE_CHECK: 'off',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_DB: '15',
  REDIS_KEY_PREFIX: 'rma-e2e:',
  QUEUE_PREFIX: 'rma-e2e:bull',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
  JWT_SECRET: 'e2e-jwt-secret-with-at-least-32-characters!!',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-with-at-least-32-characters',
  SHUTDOWN_DRAIN_DELAY_MS: '0',
  SHUTDOWN_HOOK_TIMEOUT_MS: '3000',
  OUTBOX_POLL_INTERVAL_MS: '200',
  OUTBOX_LEASE_MS: '5000',
  WS_ENABLED: 'false',
  SWAGGER_ENABLED: 'false',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}

/**
 * Biến mà từng file e2e tự ghi đè (identity-e2e-env.ts, disable-outbox-poller.ts): luôn đặt lại về mức chuẩn
 * ở đầu MỖI file - với --runInBand các file dùng chung process.env của worker, giá trị bị ghi đè sẽ rò sang file sau.
 */
const PER_FILE_BASELINE: Record<string, string> = {
  THROTTLE_LIMIT: '3',
  THROTTLE_SENSITIVE_LIMIT: '5',
  AUTH_OTP_DEBUG_ECHO: 'false',
  OUTBOX_ENABLED: 'true',
};
Object.assign(process.env, PER_FILE_BASELINE);
