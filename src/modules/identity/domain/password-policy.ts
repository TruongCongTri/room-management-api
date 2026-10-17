/**
 * Chính sách mật khẩu (tài liệu 04, mục 1.4) - theo hướng NIST SP 800-63B: ưu tiên ĐỘ DÀI và chặn mật khẩu
 * phổ biến thay vì ép tổ hợp ký tự (cho phép cụm từ có dấu cách, tiếng Việt có dấu).
 * Mật khẩu được chuẩn hóa NFKC trước khi kiểm tra và băm, để "Mật khẩu" gõ trên iOS (dựng sẵn) và
 * Android (tổ hợp) cho cùng một giá trị.
 */
import { phoneTailDigits } from './phone-number';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export enum PasswordIssue {
  TOO_SHORT = 'TOO_SHORT',
  TOO_LONG = 'TOO_LONG',
  CONTAINS_PHONE_NUMBER = 'CONTAINS_PHONE_NUMBER',
  COMMON_PASSWORD = 'COMMON_PASSWORD',
  SAME_AS_CURRENT = 'SAME_AS_CURRENT',
}

/** Mật khẩu phổ biến >= 10 ký tự (ngắn hơn đã bị TOO_SHORT chặn) - gồm cả các mẫu tiếng Việt hay gặp */
const COMMON_PASSWORDS = new Set(
  [
    '1234567890', '12345678910', '123456789a', 'a123456789', '1234567890a', '0123456789', '0987654321',
    '1111111111', '123123123123', '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty1234', 'qwerty12345',
    'qwerty123456', 'asdfghjkl1', 'zxcvbnm123', 'password12', 'password123', 'password1234', 'passw0rd123',
    'p@ssw0rd123', 'iloveyou123', 'abc1234567', 'abcd123456', 'abcdefghij', 'admin12345', 'admin@123456',
    'welcome123', 'letmein123', 'matkhau123', 'matkhau1234', 'matkhaumoi', 'anhyeuem123', 'emyeuanh123',
    'yeuemmaimai', 'xinchao123', 'vietnam123', 'vietnam1234', 'hanoi12345', 'saigon1234', 'hochiminh123',
    'zaq12wsxcde', 'changeme123', 'football123', 'superman123', 'sunshine123', 'princess123',
  ].map((p) => p.toLowerCase()),
);

export interface PasswordPolicyContext {
  phoneE164: string;
}

const codePointLength = (value: string) => [...value].length;

function isTrivialPattern(password: string): boolean {
  const chars = [...password.toLowerCase()];
  // Một ký tự lặp lại ("aaaaaaaaaa", 10 dấu cách)
  if (new Set(chars).size === 1) return true;
  // Dãy chữ số liên tiếp tăng / giảm ("3456789012" vòng quanh 0–9)
  if (/^[0-9]+$/.test(password)) {
    const steps = chars.slice(1).map((c, i) => (Number(c) - Number(chars[i]) + 10) % 10);
    if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true;
  }
  return false;
}

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Trả về các vi phạm (rỗng = hợp lệ). Không ném lỗi: caller quyết định mã lỗi / chi tiết trả cho client */
export function checkPasswordPolicy(rawPassword: string, context: PasswordPolicyContext): PasswordIssue[] {
  const password = normalizePassword(rawPassword ?? '');
  const issues: PasswordIssue[] = [];
  const length = codePointLength(password);

  if (length < PASSWORD_MIN_LENGTH) issues.push(PasswordIssue.TOO_SHORT);
  if (length > PASSWORD_MAX_LENGTH) issues.push(PasswordIssue.TOO_LONG);
  if (password.replace(/\D/g, '').includes(phoneTailDigits(context.phoneE164))) {
    issues.push(PasswordIssue.CONTAINS_PHONE_NUMBER);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || isTrivialPattern(password)) {
    issues.push(PasswordIssue.COMMON_PASSWORD);
  }
  return issues;
}
