/**
 * Nhóm biến: Resilience, HTTP client ngoại vi, Queue, Cache, Lock, Outbox, Audit,
 * Object Storage, Notification, WebSocket và Document rendering.
 */
import { z } from 'zod';
import {
  addIssue,
  envBool,
  envInt,
  envNumber,
  envOptionalBool,
  envOptionalString,
  envString,
  parseUrlSafe,
  ZodRefineCtx,
} from './env.helpers';

/** Biểu thức cron 5-6 trường (kiểm tra cấu trúc; cú pháp chi tiết do @nestjs/schedule xác thực) */
const cronSchema = (defaultValue: string) =>
  envString(defaultValue).pipe(
    z.string().refine((v) => [5, 6].includes(v.split(/\s+/).length), 'must be a 5 or 6 field cron expression'),
  );

export const infrastructureEnvShape = {
  // Resilience & Circuit Breaker (mặc định cho mọi đối tác, có thể ghi đè theo từng lời gọi)
  CIRCUIT_BREAKER_TIMEOUT_MS: envInt(8000, 1),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: envInt(30000, 1),
  CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT: envInt(50, 1, 100),
  CIRCUIT_BREAKER_VOLUME_THRESHOLD: envInt(5, 1),
  BULKHEAD_MAX_CONCURRENT: envInt(20, 1),
  BULKHEAD_MAX_QUEUE: envInt(10, 0),

  // HTTP client gọi đối tác (hóa đơn điện tử, Zalo ZNS, ngân hàng VietQR)
  HTTP_CLIENT_TIMEOUT_MS: envInt(15000, 100),
  HTTP_CLIENT_MAX_RETRIES: envInt(3, 0, 10),

  // Queue (BullMQ) - dùng chung kết nối Redis, tách namespace bằng prefix riêng
  QUEUE_PREFIX: envString('rma:bull'),
  QUEUE_DEFAULT_ATTEMPTS: envInt(5, 1, 50),
  QUEUE_BACKOFF_DELAY_MS: envInt(2000, 100),
  QUEUE_WORKER_CONCURRENCY: envInt(5, 1, 500),

  // Cache đa tầng
  CACHE_DEFAULT_TTL_SECONDS: envInt(300, 1),
  CACHE_MEMORY_MAX_ENTRIES: envInt(5000, 100),
  // Near-cache L1 trong RAM của từng Pod (0 = tắt, chỉ dùng làm fallback khi Redis sự cố)
  CACHE_L1_TTL_SECONDS: envInt(0, 0, 300),
  CACHE_XFETCH_BETA: envNumber(1, 0.1, 10),

  // Distributed lock
  LOCK_DEFAULT_TTL_MS: envInt(10000, 100),
  LOCK_RETRY_COUNT: envInt(10, 0, 1000),
  LOCK_RETRY_DELAY_MS: envInt(200, 1),
  LOCK_MAX_RETRY_DELAY_MS: envInt(2000, 1),

  // Transactional Outbox
  OUTBOX_ENABLED: envBool(true),
  OUTBOX_POLL_INTERVAL_MS: envInt(3000, 100),
  OUTBOX_BATCH_SIZE: envInt(50, 1, 1000),
  OUTBOX_MAX_RETRIES: envInt(5, 1, 100),
  OUTBOX_BASE_RETRY_DELAY_MS: envInt(2000, 100),
  // Thời gian "thuê" một batch; Pod chết giữa chừng → batch được Pod khác nhận lại sau lease
  OUTBOX_LEASE_MS: envInt(60000, 1000),
  OUTBOX_RETENTION_DAYS: envInt(7, 1),
  OUTBOX_CLEANUP_CRON: cronSchema('0 3 * * *'),

  // Audit log
  AUDIT_HTTP_ENABLED: envBool(true),
  AUDIT_TIERING_ENABLED: envBool(false),
  AUDIT_HOT_RETENTION_DAYS: envInt(90, 1),
  AUDIT_TIERING_CRON: cronSchema('0 2 * * *'),
  AUDIT_TIERING_BATCH_SIZE: envInt(1000, 10, 50000),

  // Object Storage (AWS S3 / MinIO / Supabase Storage S3-compatible)
  STORAGE_ENABLED: envBool(false),
  STORAGE_ENDPOINT: envOptionalString(),
  STORAGE_REGION: envString('ap-southeast-1'),
  STORAGE_BUCKET: envString('room-management'),
  STORAGE_ACCESS_KEY: envOptionalString(),
  STORAGE_SECRET_KEY: envOptionalString(),
  STORAGE_FORCE_PATH_STYLE: envBool(false),
  STORAGE_PUBLIC_BASE_URL: envOptionalString(),
  STORAGE_UPLOAD_URL_TTL_SECONDS: envInt(900, 60, 604800),
  STORAGE_DOWNLOAD_URL_TTL_SECONDS: envInt(300, 60, 604800),
  STORAGE_MAX_UPLOAD_BYTES: envInt(10 * 1024 * 1024, 1),
  STORAGE_COLD_BUCKET: envOptionalString(),

  // Notification - bỏ trống thông tin nhà cung cấp → kênh tương ứng bị vô hiệu hóa
  // Dry-run: chỉ ghi log (đã che PII), không gửi thật. Mặc định bật ngoài production.
  NOTIFICATION_DRY_RUN: envOptionalBool(),
  MAIL_FROM: envString('Room Management <no-reply@room-management.local>'),
  SMTP_HOST: envOptionalString(),
  SMTP_PORT: envInt(587, 1, 65535),
  SMTP_SECURE: envBool(false),
  SMTP_USER: envOptionalString(),
  SMTP_PASSWORD: envOptionalString(),
  TELEGRAM_BOT_TOKEN: envOptionalString(),
  TELEGRAM_DEFAULT_CHAT_ID: envOptionalString(),
  ZALO_OA_ACCESS_TOKEN: envOptionalString(),
  TWILIO_ACCOUNT_SID: envOptionalString(),
  TWILIO_AUTH_TOKEN: envOptionalString(),
  TWILIO_FROM_NUMBER: envOptionalString(),

  // WebSocket (Socket.IO)
  WS_ENABLED: envBool(true),

  // Webhook egress (dispatcher có retry qua queue)
  WEBHOOK_DISPATCH_TIMEOUT_MS: envInt(10000, 100),
  WEBHOOK_DISPATCH_MAX_ATTEMPTS: envInt(8, 1, 50),

  // PDF: font TTF hỗ trợ Unicode tiếng Việt (vd: NotoSans-Regular.ttf). Bỏ trống → Helvetica (không dấu)
  PDF_FONT_PATH: envOptionalString(),
  PDF_FONT_BOLD_PATH: envOptionalString(),
};

type InfrastructureEnv = z.infer<z.ZodObject<typeof infrastructureEnvShape>> & {
  NODE_ENV: string;
};

export function refineInfrastructureEnv(env: InfrastructureEnv, ctx: ZodRefineCtx): void {
  if (env.LOCK_MAX_RETRY_DELAY_MS < env.LOCK_RETRY_DELAY_MS) {
    addIssue(ctx, 'LOCK_MAX_RETRY_DELAY_MS', 'LOCK_MAX_RETRY_DELAY_MS must be >= LOCK_RETRY_DELAY_MS');
  }

  if (env.OUTBOX_LEASE_MS <= env.OUTBOX_POLL_INTERVAL_MS) {
    addIssue(ctx, 'OUTBOX_LEASE_MS', 'OUTBOX_LEASE_MS must be greater than OUTBOX_POLL_INTERVAL_MS');
  }

  if (env.STORAGE_ENABLED) {
    if (env.STORAGE_ENDPOINT && !parseUrlSafe(env.STORAGE_ENDPOINT)) {
      addIssue(ctx, 'STORAGE_ENDPOINT', 'STORAGE_ENDPOINT must be a valid URL (e.g. http://localhost:9000)');
    }
    // Trên AWS có thể dùng IAM Role (IRSA) thay cho access key → chỉ bắt buộc với endpoint tùy biến
    if (env.STORAGE_ENDPOINT && (!env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY)) {
      addIssue(
        ctx,
        'STORAGE_ACCESS_KEY',
        'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY are required with a custom STORAGE_ENDPOINT (MinIO / Supabase S3)',
      );
    }
  }

  if (env.AUDIT_TIERING_ENABLED && !env.STORAGE_ENABLED) {
    addIssue(
      ctx,
      'AUDIT_TIERING_ENABLED',
      'AUDIT_TIERING_ENABLED requires STORAGE_ENABLED=true (archives must be uploaded before hot rows are purged)',
    );
  }

  if (env.SMTP_USER && !env.SMTP_PASSWORD) {
    addIssue(ctx, 'SMTP_PASSWORD', 'SMTP_PASSWORD is required when SMTP_USER is set');
  }

  const twilio = [env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM_NUMBER];
  if (twilio.some(Boolean) && !twilio.every(Boolean)) {
    addIssue(
      ctx,
      'TWILIO_ACCOUNT_SID',
      'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must be configured together',
    );
  }
}
