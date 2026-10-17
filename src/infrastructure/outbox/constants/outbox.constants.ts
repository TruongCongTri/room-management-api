// Quy định các hằng số điều phối hàng đợi và chu kỳ quét sự kiện (giá trị vận hành lấy từ cấu hình OUTBOX_*):

export enum OutboxEventStatus {
  PENDING = 'PENDING',
  /** Đã được một Pod nhận (lease tới next_retry_at); Pod chết giữa chừng → Pod khác nhận lại khi hết lease */
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}

export const OUTBOX_DEFAULTS = {
  BATCH_SIZE: 50,
  POLL_INTERVAL_MS: 3000,
  MAX_RETRIES: 5,
  BASE_RETRY_DELAY_MS: 2000,
  LEASE_MS: 60000,
  RETENTION_DAYS: 7,
} as const;

export const OUTBOX_RELAY_HANDLER = 'OUTBOX_RELAY_HANDLER';
