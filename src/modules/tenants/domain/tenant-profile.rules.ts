/**
 * Quy tắc hồ sơ một người ở (tài liệu 02, mục 2.1b) - hàm thuần, áp dụng cho TẠO và mọi lần SỬA (hồ sơ sau khi gộp):
 *  - Số giấy tờ được chuẩn hóa trước khi kiểm tra, băm blind index và mã hóa.
 *  - CCCD / số định danh cá nhân (Thông tư 59/2021/TT-BCA): 12 chữ số = 3 số mã tỉnh nơi đăng ký khai sinh +
 *    1 số giới tính & thế kỷ sinh (0/1 nam/nữ 1900-1999, 2/3 2000-2099, 4/5 2100-2199) + 2 số cuối năm sinh + 6 số ngẫu nhiên.
 *    Giới tính và năm sinh trên số phải khớp hồ sơ → bắt lỗi gõ nhầm / nhập nhầm người.
 *  - Hộ chiếu (người nước ngoài): 6-12 chữ cái / chữ số, có ít nhất một chữ số.
 */
import { IdDocumentType } from '../../contracts/domain/occupancy.enums';
import { isAdultOn } from '../../contracts/domain/occupancy.policy';

export type Gender = 'MALE' | 'FEMALE';

export interface ProfileIssue {
  field: string;
  message: string;
}

export interface TenantProfileInput {
  idDocumentType: IdDocumentType;
  idCardNumber: string; // đã chuẩn hóa
  nationality: string;
  gender: Gender;
  dateOfBirth: string; // YYYY-MM-DD
  idCardIssueDate?: string | null;
  phone?: string | null;
  refundBankAccount?: string | null;
  refundBankName?: string | null;
  consentGuardianTenantId?: string | null;
}

const CCCD = /^[0-9]{12}$/;
const PASSPORT = /^(?=.*[0-9])[A-Z0-9]{6,12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_AGE_YEARS = 120;

/** "079 203.001-234" → "079203001234"; "b 1234567" → "B1234567" */
export function normalizeIdNumber(raw: string): string {
  return (raw ?? '').normalize('NFKC').replace(/[\s.\-/]/g, '').toUpperCase();
}

/** "Nguyễn Văn Đức" → "nguyen van duc" (tìm kiếm không dấu, không cần extension unaccent) */
export function toSearchName(fullName: string): string {
  return (fullName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function maskIdNumber(last4: string): string {
  return `********${last4}`;
}

export function maskBankAccount(last4: string | null | undefined): string | null {
  return last4 ? `*********${last4}` : null;
}

export function isMinorOn(dateOfBirth: string, today: string): boolean {
  return !isAdultOn(dateOfBirth, today);
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Giới tính & năm sinh mã hóa trong CCCD; null khi chữ số thứ 4 không hợp lệ (6-9) */
export function decodeCccd(number: string): { gender: Gender; birthYear: number; provinceCode: number } | null {
  if (!CCCD.test(number)) return null;
  const code = Number(number[3]);
  if (code > 5) return null;
  return {
    gender: code % 2 === 0 ? 'MALE' : 'FEMALE',
    birthYear: 1900 + Math.floor(code / 2) * 100 + Number(number.slice(4, 6)),
    provinceCode: Number(number.slice(0, 3)),
  };
}

/** Mọi vi phạm của hồ sơ (rỗng = hợp lệ). `today` theo giờ Việt Nam (YYYY-MM-DD). */
export function checkTenantProfile(profile: TenantProfileInput, today: string): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  // ---- ngày sinh
  const dobValid = isRealDate(profile.dateOfBirth);
  if (!dobValid) add('dateOfBirth', 'dateOfBirth must be a real date (YYYY-MM-DD)');
  else if (profile.dateOfBirth > today) add('dateOfBirth', 'dateOfBirth cannot be in the future');
  else if (Number(today.slice(0, 4)) - Number(profile.dateOfBirth.slice(0, 4)) > MAX_AGE_YEARS) {
    add('dateOfBirth', `dateOfBirth is more than ${MAX_AGE_YEARS} years ago`);
  }

  // ---- giấy tờ
  if (profile.idDocumentType === IdDocumentType.CCCD) {
    if (profile.nationality !== 'VN') add('idDocumentType', 'Foreign nationals are identified by passport');
    const decoded = decodeCccd(profile.idCardNumber);
    if (!CCCD.test(profile.idCardNumber)) {
      add('idCardNumber', 'A CCCD / personal identification number has exactly 12 digits');
    } else if (!decoded || decoded.provinceCode < 1 || decoded.provinceCode > 96) {
      add('idCardNumber', 'Not a valid CCCD / personal identification number');
    } else if (dobValid) {
      if (decoded.gender !== profile.gender) add('idCardNumber', 'The 4th digit of the number does not match the gender');
      if (decoded.birthYear !== Number(profile.dateOfBirth.slice(0, 4))) {
        add('idCardNumber', 'Digits 4-6 of the number do not match the year of birth');
      }
    }
  } else if (!PASSPORT.test(profile.idCardNumber)) {
    add('idCardNumber', 'A passport number has 6-12 letters or digits, at least one digit');
  }

  if (profile.idCardIssueDate) {
    if (!isRealDate(profile.idCardIssueDate)) add('idCardIssueDate', 'idCardIssueDate must be a real date (YYYY-MM-DD)');
    else if (profile.idCardIssueDate > today) add('idCardIssueDate', 'idCardIssueDate cannot be in the future');
    else if (dobValid && profile.idCardIssueDate < profile.dateOfBirth) add('idCardIssueDate', 'idCardIssueDate cannot be before the date of birth');
  }

  // ---- người thành niên / trẻ em
  if (dobValid && profile.dateOfBirth <= today) {
    const minor = isMinorOn(profile.dateOfBirth, today);
    if (!minor && !profile.phone) add('phone', 'A phone number is required for adults');
  }

  // ---- tài khoản hoàn cọc
  if (profile.refundBankAccount && !profile.refundBankName) add('refundBankName', 'refundBankName is required with refundBankAccount');
  return issues;
}

/**
 * Quy tắc người giám hộ (lỗi nghiệp vụ 422, không phải lỗi định dạng):
 *  - REQUIRED: trẻ em chưa có người giám hộ đồng ý xử lý dữ liệu → BIZ_PDPL_CONSENT_REQUIRED
 *  - FORBIDDEN: người thành niên không có người giám hộ → BIZ_TENANT_GUARDIAN_INVALID
 * Ngày sinh không hợp lệ → null (đã có lỗi định dạng riêng).
 */
export function guardianRequirement(profile: Pick<TenantProfileInput, 'dateOfBirth' | 'consentGuardianTenantId'>, today: string): 'REQUIRED' | 'FORBIDDEN' | null {
  if (!isRealDate(profile.dateOfBirth) || profile.dateOfBirth > today) return null;
  const minor = isMinorOn(profile.dateOfBirth, today);
  if (minor && !profile.consentGuardianTenantId) return 'REQUIRED';
  if (!minor && profile.consentGuardianTenantId) return 'FORBIDDEN';
  return null;
}
