import type { Request } from 'express';

export interface WebhookDispatchPayload<T = any> {
  event: string;
  data: T;
  /** Mã sự kiện ổn định (vd: outbox event id) để bên nhận chống trùng lặp. Mặc định: UUID mới */
  id?: string;
  timestamp?: number;
  tenantId?: string;
  traceId?: string;
}

export interface WebhookDispatchOptions {
  url: string;
  secret: string;
  signatureHeader?: string;
  timestampHeader?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Bí mật xác thực: cố định, hoặc phân giải động theo request (đa đối tác / đa tenant, lấy từ Vault) */
export type WebhookSecretResolver = string | ((request: Request) => string | Promise<string>);

export interface WebhookVerificationOptions {
  secret: WebhookSecretResolver;
  signatureHeader?: string;
  timestampHeader?: string;
  toleranceSeconds?: number;
}

export interface WebhookDispatchResult {
  success: boolean;
  statusCode?: number;
  deliveredAt: string;
  webhookId: string;
  /** true khi đã chuyển vào hàng đợi retry thay vì gửi đồng bộ */
  queued?: boolean;
  error?: string;
}

/** Payload job của hàng đợi webhook-dispatch */
export interface WebhookDispatchJob {
  payload: WebhookDispatchPayload;
  options: WebhookDispatchOptions;
}
