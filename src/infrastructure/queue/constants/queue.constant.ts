export const QUEUE_NAMES = {
  /** Zalo ZNS / Email / SMS / Telegram */
  NOTIFICATION: 'notification-queue',
  /** Kết xuất PDF pháp lý: hợp đồng thuê, biên bản bàn giao, CT01, biên bản thanh lý cọc */
  DOCUMENT_RENDERING: 'document-rendering-queue',
  /** Kỳ hóa đơn cuối tháng: mỗi job = một phòng của một tòa nhà */
  MONTHLY_BILLING: 'monthly-billing-queue',
  /** Xuất tờ khai thuế 01/BĐS, 01/BK-BĐS và hồ sơ cư trú dạng stream Excel */
  STATUTORY_EXPORT: 'statutory-export-queue',
  /** Gửi hóa đơn điện tử sang VNPT / Viettel / MISA */
  E_INVOICE_DISPATCH: 'e-invoice-dispatch-queue',
  /** Sự kiện miền được Outbox relay chuyển sang (jobId = outbox event id → không trùng lặp) */
  DOMAIN_EVENTS: 'domain-events-queue',
  /** Webhook egress có retry/backoff */
  WEBHOOK_DISPATCH: 'webhook-dispatch-queue',
} as const;

export const DLQ_SUFFIX = '-dlq';

/** Thời gian giữ job lỗi trên queue chính (bản sao đầy đủ đã nằm trong DLQ) */
export const FAILED_JOB_RETENTION_SECONDS = 24 * 3600;
