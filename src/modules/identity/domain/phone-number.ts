/**
 * Số điện thoại là định danh đăng nhập (tài liệu 04, mục 1.4): mọi biến thể người dùng gõ được chuẩn hóa
 * về E.164 TRƯỚC khi tra cứu / lưu / tính khóa Redis, nên "0901 234 567", "84901234567",
 * "+84 90 123 4567" và "(+84) 090-123-4567" là cùng một tài khoản.
 *
 *  - Số Việt Nam (+84): chỉ chấp nhận đầu số DI ĐỘNG (OTP được gửi qua SMS) - trùng với REGEX_PATTERNS.VIETNAM_PHONE.
 *  - Số nước ngoài (khách thuê người nước ngoài): chấp nhận dạng quốc tế "+<mã nước>..." hoặc "00<mã nước>...",
 *    8–15 chữ số theo E.164.
 */
const VN_COUNTRY_CODE = '84';
const VN_MOBILE_NATIONAL = /^(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])[0-9]{7}$/;
const E164_DIGITS = /^[1-9][0-9]{7,14}$/;
const SEPARATORS = /[\s.\-()/]/g;

export class InvalidPhoneNumberError extends Error {
  constructor(message = 'Not a valid mobile phone number.') {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}

/** Chuẩn hóa về E.164 (+84901234567) hoặc ném InvalidPhoneNumberError */
export function normalizePhoneNumber(input: string): string {
  if (typeof input !== 'string') throw new InvalidPhoneNumberError();
  // NFKC: chữ số toàn độ rộng (０９０…) từ bàn phím IME → chữ số ASCII
  let value = input.normalize('NFKC').trim().replace(SEPARATORS, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;

  let digits: string;
  if (value.startsWith('+')) {
    digits = value.slice(1);
    if (!/^[0-9]+$/.test(digits)) throw new InvalidPhoneNumberError();
    // "+84 0901234567": người dùng giữ số 0 đầu của số trong nước sau mã quốc gia
    if (digits.startsWith(`${VN_COUNTRY_CODE}0`)) digits = VN_COUNTRY_CODE + digits.slice(3);
  } else if (/^0[0-9]{9}$/.test(value)) {
    digits = VN_COUNTRY_CODE + value.slice(1);
  } else if (/^84[0-9]{9}$/.test(value)) {
    // Số trong nước luôn bắt đầu bằng 0 → 11 chữ số bắt đầu bằng 84 chỉ có thể là mã quốc gia
    digits = value;
  } else {
    throw new InvalidPhoneNumberError();
  }

  if (!E164_DIGITS.test(digits)) throw new InvalidPhoneNumberError();
  if (digits.startsWith(VN_COUNTRY_CODE) && !VN_MOBILE_NATIONAL.test(digits.slice(VN_COUNTRY_CODE.length))) {
    throw new InvalidPhoneNumberError('Not a Vietnamese mobile number (landlines cannot receive sign-in codes).');
  }
  return `+${digits}`;
}

export function isVietnamesePhone(e164: string): boolean {
  return e164.startsWith(`+${VN_COUNTRY_CODE}`);
}

/**
 * Che số điện thoại cho response, token, log và audit: 090****567 (VN), +44****789 (nước ngoài).
 * Không bao giờ trả số đầy đủ ra ngoài.
 */
export function maskPhoneNumber(e164: string): string {
  const digits = e164.replace(/^\+/, '');
  if (isVietnamesePhone(e164)) {
    const national = `0${digits.slice(VN_COUNTRY_CODE.length)}`;
    return `${national.slice(0, 3)}****${national.slice(-3)}`;
  }
  return `+${digits.slice(0, 2)}****${digits.slice(-3)}`;
}

/** 6 chữ số cuối của số trong nước - mật khẩu không được chứa chuỗi này */
export function phoneTailDigits(e164: string, length = 6): string {
  return e164.replace(/^\+/, '').slice(-length);
}
