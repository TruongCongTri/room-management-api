/**
 * Import TRƯỚC AppModule trong properties.e2e-spec.ts:
 *  - Ứng dụng kết nối bằng role app_user (KHÔNG superuser, KHÔNG BYPASSRLS) → Row-Level Security của PostgreSQL
 *    thực sự được áp dụng; dữ liệu mẫu được dựng bằng kết nối owner riêng trong file test.
 *  - Nới throttle theo IP; tắt poller outbox để kiểm tra bản ghi outbox còn PENDING.
 */
process.env.DB_MASTER_USER = 'app_user';
process.env.DB_MASTER_PASSWORD = 'app_user';
process.env.THROTTLE_LIMIT = '10000';
process.env.THROTTLE_SENSITIVE_LIMIT = '10000';
process.env.OUTBOX_ENABLED = 'false';
