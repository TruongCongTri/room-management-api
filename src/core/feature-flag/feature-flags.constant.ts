/**
 * Cờ chính sách nghiệp vụ bật/tắt runtime không cần deploy (tài liệu 01, mục 8.4).
 * Giá trị nền khai báo trong FEATURE_FLAGS (JSON), override qua Redis; `allowedTenantIds`
 * của mỗi rule là danh sách building_id được áp dụng.
 *
 * @example FEATURE_FLAGS={"evn_tiered_quota":{"enabled":true,"allowedTenantIds":["<building-uuid>"]}}
 */
export const FEATURE_FLAGS = {
  /** Bật: tính điện bậc thang theo định mức tạm trú; Tắt: đồng giá Bậc 3 (EVN_TIER_3_FLAT) */
  EVN_TIERED_QUOTA: 'evn_tiered_quota',
  /** Tự động phát hành hóa đơn điện tử sang VNPT/Viettel/MISA khi chốt kỳ */
  E_INVOICE_AUTO_DISPATCH: 'e_invoice_auto_dispatch',
  /** Gửi hóa đơn tháng qua Zalo ZNS (tắt → chỉ email) */
  ZALO_ZNS_INVOICE: 'zalo_zns_invoice',
  /** Áp phí phạt chậm thanh toán tự động trong cron 08:00 */
  LATE_PAYMENT_PENALTY: 'late_payment_penalty',
  /** Ẩn danh hóa PII khách thuê sau hạn lưu trữ thuế (Luật 91/2025/QH15) */
  PII_AUTO_ANONYMIZATION: 'pii_auto_anonymization',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];
