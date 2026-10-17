/**
 * Hằng số pháp lý & nghiệp vụ cho thuê nhà ở tại Việt Nam (năm 2026).
 * Đây là GIÁ TRỊ MẶC ĐỊNH theo văn bản hiện hành; giá trị hiệu lực được nạp qua AppConfigService
 * (biến môi trường TAX_* / EVN_* / BILLING_*) để cập nhật biểu giá mà không cần build lại.
 */

/** Múi giờ nghiệp vụ: chốt kỳ hóa đơn, ngày trả phòng, kỳ thuế đều tính theo giờ Việt Nam */
export const VN_BUSINESS_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Thuế cho thuê tài sản của cá nhân 2026:
 *  - Luật Thuế TNCN số 109/2025/QH15 (Điều 7, khoản 4), Luật Thuế GTGT 48/2024/QH15 (sửa đổi bởi 149/2025/QH15).
 *  - Nghị định 68/2026/NĐ-CP (sửa đổi bởi 141/2026/NĐ-CP), Thông tư 18/2026/TT-BTC & 89/2026/TT-BTC.
 *  - Lệ phí môn bài bãi bỏ từ 01/01/2026 (Nghị quyết 198/2025/QH15).
 */
export const VN_TAX_2026 = {
  /** Ngưỡng doanh thu không chịu thuế: 1 tỷ đồng/năm */
  EXEMPT_THRESHOLD_VND: 1_000_000_000,
  /** Ngưỡng cũ (trước 2026) - phục vụ đối soát/kiểm toán các kỳ lịch sử */
  LEGACY_EXEMPT_THRESHOLD_VND: 100_000_000,
  /** GTGT 5% trên toàn bộ doanh thu chịu thuế khi vượt ngưỡng */
  VAT_RATE_PERCENT: 5,
  /** TNCN 5% CHỈ trên phần doanh thu vượt ngưỡng 1 tỷ */
  PIT_RATE_PERCENT: 5,
  BUSINESS_LICENSE_FEE_VND: 0,
} as const;

/** Mẫu tờ khai / biểu mẫu nhà nước */
export const VN_STATUTORY_FORMS = {
  /** Tờ khai thuế đối với hoạt động cho thuê bất động sản (TT 18/2026/TT-BTC) */
  TAX_DECLARATION: '01/BĐS',
  /** Phụ lục bảng kê chi tiết bất động sản cho thuê */
  TAX_ANNEX: '01/BK-BĐS',
  /** Mẫu cũ - chỉ hỗ trợ xuất lại kỳ trước 2026 */
  LEGACY_TAX_DECLARATION: '01/TTS',
  /** Tờ khai thay đổi thông tin cư trú (Luật Cư trú 2020, TT 66/2023/TT-BCA) */
  RESIDENCE_DECLARATION: 'CT01',
} as const;

/** Cách tính tiền điện của tòa nhà (FeatureFlag `evn_tiered_quota` cho phép chuyển runtime) */
export enum ElectricityBillingMode {
  /** Bậc thang sinh hoạt theo định mức người đăng ký tạm trú (TT 16/2014, 25/2018, 09/2023/TT-BCT) */
  EVN_TIERED_QUOTA = 'EVN_TIERED_QUOTA',
  /** Giá bán lẻ Bậc 3 đồng giá cho mọi kWh khi không đăng ký đủ định mức */
  EVN_TIER_3_FLAT = 'EVN_TIER_3_FLAT',
}

/**
 * Biểu giá điện sinh hoạt bậc thang (6 bậc, VND/kWh chưa gồm VAT - QĐ 1279/QĐ-BCT ngày 09/5/2025).
 * `widthKwh = null` là bậc cuối không giới hạn.
 */
export const EVN_RESIDENTIAL_TIERS = [
  { tier: 1, widthKwh: 50, priceVnd: 1984 },
  { tier: 2, widthKwh: 50, priceVnd: 2050 },
  { tier: 3, widthKwh: 100, priceVnd: 2380 },
  { tier: 4, widthKwh: 100, priceVnd: 2998 },
  { tier: 5, widthKwh: 100, priceVnd: 3350 },
  { tier: 6, widthKwh: null, priceVnd: 3460 },
] as const;

export const EVN_RULES = {
  /** 4 người đăng ký tạm trú = 1 định mức hộ gia đình đầy đủ (1 người = 25% độ rộng mỗi bậc) */
  HOUSEHOLD_QUOTA_HEADCOUNT: 4,
  /** Bậc dùng làm đơn giá đồng nhất ở chế độ EVN_TIER_3_FLAT */
  FLAT_RATE_TIER: 3,
  VAT_RATE_PERCENT: 8,
} as const;

/** Quy ước vận hành của tòa nhà 80 phòng */
export const RENTAL_OPERATIONS = {
  TOTAL_ROOMS: 80,
  /** Cron chốt hóa đơn hằng tháng chạy 00:00 ngày 28 */
  MONTHLY_BILLING_DAY: 28,
  /** Tiền đặt cọc tiêu chuẩn = 1 tháng tiền phòng (BLDS 2015, Điều 328) */
  STANDARD_DEPOSIT_MONTHS: 1,
} as const;
