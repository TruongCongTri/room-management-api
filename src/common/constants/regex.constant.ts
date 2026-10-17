/**
 * Tổng hợp các Regex chuẩn cho xác thực đầu vào (Validation Pipes / DTOs) của nền tảng quản lý phòng cho thuê:
 * giấy tờ tùy thân Việt Nam (CCCD / Hộ chiếu), biển số xe, kỳ ghi chỉ số / kỳ hóa đơn và dữ liệu PII.
 *
 * */

export const REGEX_PATTERNS = {
  // UUID v4 tiêu chuẩn (RFC 4122)
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  // Số di động Việt Nam (+84 hoặc 0...): 03x Viettel, 05[25689] Vietnamobile/Wintel/Gmobile, 07x MobiFone, 08x, 09x
  VIETNAM_PHONE: /^(?:\+84|0)(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])[0-9]{7}$/,

  // Thẻ Căn cước / CCCD (12 chữ số)
  VIETNAM_CITIZEN_ID: /^[0-9]{12}$/,

  // Hộ chiếu Việt Nam và Quốc tế (1 chữ cái theo sau bởi 7-8 chữ số)
  PASSPORT: /^[A-Z][0-9]{7,8}$/i,

  // Mã số thuế cá nhân / hộ kinh doanh (10 số, hoặc 10 số + "-" + 3 số chi nhánh)
  VIETNAM_TAX_CODE: /^[0-9]{10}(?:-[0-9]{3})?$/,

  // Biển số xe Việt Nam: 29A-123.45, 59X1-234.56, 51F-12345 (ô tô / xe máy / xe điện)
  VIETNAM_LICENSE_PLATE: /^[0-9]{2}[A-Z]{1,2}[0-9]?-?[0-9]{3}\.?[0-9]{2}$/i,

  // Số phòng trong tòa nhà (vd: P.302, 302, A-1203)
  ROOM_NUMBER: /^[A-Z0-9][A-Z0-9.-]{0,19}$/i,

  // Kỳ ghi chỉ số / kỳ hóa đơn (YYYY-MM)
  BILLING_MONTH: /^\d{4}-(0[1-9]|1[0-2])$/,

  // Định dạng ngày ISO 8601 (YYYY-MM-DD)
  DATE_ISO_YMD: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,

  // Mật khẩu mạnh (Tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt)
  STRONG_PASSWORD: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
} as const;
