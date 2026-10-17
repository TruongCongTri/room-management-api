export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  fingerprint: string;
  statusCode?: number;
  response?: any;
  createdAt: number;
}

export interface IdempotentOptions {
  /**
   * Có bắt buộc phải có header Idempotency-Key hay không (Mặc định: true)
   */
  required?: boolean;

  /**
   * Thời gian lưu trữ kết quả đã hoàn tất (Mặc định: 86400s = 24 giờ)
   */
  ttlSeconds?: number;

  /**
   * Thời gian khóa tạm thời khi đang xử lý (Mặc định: 60s để phòng server crash)
   */
  lockTimeoutSeconds?: number;
}