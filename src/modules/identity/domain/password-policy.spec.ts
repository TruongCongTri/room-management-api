import { checkPasswordPolicy, normalizePassword, PasswordIssue } from './password-policy';

const PHONE = '+84901234567'; // 6 chữ số cuối: 234567
const check = (password: string) => checkPasswordPolicy(password, { phoneE164: PHONE });

describe('Password policy', () => {
  it('should accept a long passphrase with spaces and Vietnamese diacritics', () => {
    expect(check('mùa thu Hà Nội đẹp lắm')).toEqual([]);
  });

  describe('length (counted in characters, not bytes / UTF-16 units)', () => {
    it('should reject 9 characters and accept exactly 10', () => {
      expect(check('Kx9#mPq2v')).toEqual([PasswordIssue.TOO_SHORT]);
      expect(check('Kx9#mPq2vL')).toEqual([]);
    });

    it('should count each emoji / accented letter as one character', () => {
      // 9 emoji = 18 UTF-16 units nhưng chỉ 9 ký tự → vẫn quá ngắn
      expect(check('🔑🏠🌙⭐🍜🎋🐉🌸🚲')).toContain(PasswordIssue.TOO_SHORT);
      // "Đ" dựng sẵn và "D + dấu" tổ hợp đều là 1 ký tự sau NFKC
      expect(check('Đường9#kxQ')).toEqual([]);
    });

    it('should accept 128 characters and reject 129', () => {
      expect(check('a'.repeat(127) + 'b')).toEqual([]);
      expect(check('a'.repeat(128) + 'b')).toEqual([PasswordIssue.TOO_LONG]);
    });
  });

  describe('phone number', () => {
    it('should reject a password containing the last 6 digits of the phone number', () => {
      expect(check('MyHome234567!')).toEqual([PasswordIssue.CONTAINS_PHONE_NUMBER]);
    });

    it('should also catch the digits when separated by other characters', () => {
      expect(check('Room-23-45-67xyz')).toEqual([PasswordIssue.CONTAINS_PHONE_NUMBER]);
    });

    it('should allow other digits and only 5 of the tail digits', () => {
      expect(check('Kx#mPqvLw34567')).toEqual([]);
      expect(check('Kx81#mPqvLw34567')).toEqual([]); // chữ số khác không ghép thành đuôi số điện thoại
    });
  });

  describe('common and trivial passwords', () => {
    it.each(['password123', 'PASSWORD123', 'Matkhau123', 'qwertyuiop', '1q2w3e4r5t', 'anhyeuem123'])(
      'should reject the common password %p (case-insensitive)',
      (password) => {
        expect(check(password)).toContain(PasswordIssue.COMMON_PASSWORD);
      },
    );

    it('should reject a single repeated character, including 10 spaces', () => {
      expect(check('aaaaaaaaaa')).toEqual([PasswordIssue.COMMON_PASSWORD]);
      expect(check('          ')).toEqual([PasswordIssue.COMMON_PASSWORD]);
    });

    it('should reject ascending, descending and wrapping digit sequences', () => {
      expect(check('3456789012')).toContain(PasswordIssue.COMMON_PASSWORD);
      expect(check('9876543210')).toContain(PasswordIssue.COMMON_PASSWORD);
      expect(check('5678901234')).toContain(PasswordIssue.COMMON_PASSWORD);
    });

    it('should not flag digits that merely look random', () => {
      expect(check('3945018276')).toEqual([]);
    });
  });

  it('should report every violated rule at once', () => {
    expect(check('234567')).toEqual(
      expect.arrayContaining([PasswordIssue.TOO_SHORT, PasswordIssue.CONTAINS_PHONE_NUMBER]),
    );
  });

  it('should normalise composed and decomposed forms to the same password (iOS vs Android keyboards)', () => {
    const composed = 'Mật khẩu ổn định';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(normalizePassword(decomposed)).toBe(normalizePassword(composed));
  });
});
