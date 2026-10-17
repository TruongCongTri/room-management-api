export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_METADATA_KEY = 'security:idempotent_options';
export const IDEMPOTENCY_REDIS_PREFIX = 'idempotency';

/** Định dạng key hợp lệ (UUID, ULID, chuỗi ngẫu nhiên...) - chặn key quá dài / ký tự lạ */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
