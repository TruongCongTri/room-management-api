/**
 * Đối tác bên ngoài và chính sách cô lập mặc định (tài liệu 01, mục 5.1):
 * mỗi đối tác có bulkhead riêng để một cổng chậm (vd: hóa đơn điện tử) không làm nghẽn
 * Event Loop hay chặn thao tác phòng / chỉ số đồng hồ nội bộ.
 *
 * @example
 * @Resilient(EXTERNAL_PARTNERS.E_INVOICE.name, EXTERNAL_PARTNERS.E_INVOICE.policy, 'queueForRetry')
 * async issueEInvoice(invoice: Invoice) { ... }
 */
import { ResiliencePolicyOptions } from './resilience.interface';

export interface ExternalPartner {
  name: string;
  policy: ResiliencePolicyOptions;
}

const partner = (name: string, maxConcurrent: number, timeoutMs: number): ExternalPartner => ({
  name,
  policy: {
    bulkhead: { maxConcurrent, maxQueue: maxConcurrent },
    // Ngắt mạch khi > 50% lỗi; fallback thường là xếp hàng gửi lại nền
    circuitBreaker: { timeout: timeoutMs, errorThresholdPercentage: 50, resetTimeout: 30_000, volumeThreshold: 5 },
    retry: { maxAttempts: 3, delayMs: 300, backoffMultiplier: 2, maxDelayMs: 3_000 },
  },
});

export const EXTERNAL_PARTNERS = {
  /** VNPT / Viettel / MISA - hóa đơn điện tử (NĐ 70/2025/NĐ-CP, NĐ 68/2026/NĐ-CP) */
  E_INVOICE: partner('e-invoice-gateway', 20, 10_000),
  /** Zalo Notification Service - hóa đơn tháng kèm VietQR */
  ZALO_ZNS: partner('zalo-zns', 30, 5_000),
  /** Cổng SMS (Twilio / VietGuys) - OTP */
  SMS_GATEWAY: partner('sms-gateway', 10, 5_000),
  /** Ngân hàng / NAPAS - sinh mã VietQR động & tra soát giao dịch */
  VIETQR_BANK: partner('vietqr-bank', 10, 8_000),
  /** Telegram Bot API - cảnh báo nội bộ */
  TELEGRAM: partner('telegram-bot', 5, 5_000),
} as const;
