/**
 * Khai báo cấu hình mTLS, chính sách retry và tham số gọi API ngoại vi:
 *
 * */

import { AxiosRequestConfig } from 'axios';

export interface MtlsConfig {
  cert: string; // Nội dung cert hoặc đường dẫn file .pem / .crt
  key: string; // Nội dung private key hoặc đường dẫn file .key
  ca?: string; // Root CA của đối tác nếu dùng private CA
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableStatuses?: number[];
  /**
   * Cho phép retry POST/PATCH (không idempotent). Mặc định false: chỉ retry GET/HEAD/OPTIONS/PUT/DELETE
   * hoặc request có header Idempotency-Key (đối tác tự loại bỏ trùng lặp).
   */
  retryNonIdempotent?: boolean;
}

export interface EnterpriseHttpOptions extends AxiosRequestConfig {
  mtls?: MtlsConfig;
  retry?: RetryConfig;
  skipTracePropagation?: boolean;
}

/** Trường nội bộ gắn vào config của axios trong vòng đời một request */
export interface RequestRuntimeState {
  _retryCount?: number;
  _startedAt?: number;
  retry?: RetryConfig;
}
