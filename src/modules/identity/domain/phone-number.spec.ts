import { InvalidPhoneNumberError, maskPhoneNumber, normalizePhoneNumber, phoneTailDigits } from './phone-number';

describe('Phone number (sign-in identifier)', () => {
  describe('normalizePhoneNumber', () => {
    it.each([
      ['0901234567'],
      ['0901 234 567'],
      ['090.123.4567'],
      ['090-123-4567'],
      ['(090) 123 4567'],
      ['+84901234567'],
      ['+84 90 123 4567'],
      ['84901234567'],
      ['0084901234567'],
      ['+84 0901234567'], // giữ số 0 trong nước sau mã quốc gia
      ['  0901234567\t'],
      ['０９０１２３４５６７'], // chữ số toàn độ rộng từ bàn phím IME
    ])('should map %p to the same account +84901234567', (input) => {
      expect(normalizePhoneNumber(input)).toBe('+84901234567');
    });

    it.each([
      ['0321234567', '+84321234567'], // Viettel 032
      ['0521234567', '+84521234567'], // Vietnamobile 052
      ['0591234567', '+84591234567'], // Gmobile 059
      ['0701234567', '+84701234567'], // MobiFone 070
      ['0861234567', '+84861234567'],
      ['0991234567', '+84991234567'],
    ])('should accept the Vietnamese mobile prefix of %p', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });

    it.each([
      ['0241234567', 'Hà Nội landline (024) cannot receive SMS codes'],
      ['0281234567', 'HCMC landline (028)'],
      ['0541234567', '054 is not a mobile prefix'],
      ['0711234567', '071 is not allocated to mobile'],
      ['0311234567', '031 is not a mobile prefix'],
      ['0801234567', '080 is not a mobile prefix'],
      ['+84241234567', 'landline in international form'],
    ])('should reject %p (%s)', (input) => {
      expect(() => normalizePhoneNumber(input)).toThrow(InvalidPhoneNumberError);
    });

    it.each([
      [''],
      ['   '],
      ['090123456'], // 9 chữ số
      ['09012345678'], // 11 chữ số bắt đầu bằng 0
      ['8490123456'], // 10 chữ số bắt đầu bằng 84 - không phải số trong nước, không phải quốc tế
      ['901234567'], // thiếu số 0
      ['+84 9O1234567'], // chữ O thay số 0
      ['05|1234567'], // ký tự '|' từng lọt qua regex cũ
      ['+'],
      ['+0123456789'], // mã quốc gia không bắt đầu bằng 0
      ['+1234567'], // 7 chữ số < E.164 tối thiểu 8
      ['+1234567890123456'], // 16 chữ số > 15
      ['0901234567; DROP TABLE users'],
    ])('should reject malformed input %p', (input) => {
      expect(() => normalizePhoneNumber(input)).toThrow(InvalidPhoneNumberError);
    });

    it('should reject non-string input instead of coercing it', () => {
      expect(() => normalizePhoneNumber(901234567 as unknown as string)).toThrow(InvalidPhoneNumberError);
      expect(() => normalizePhoneNumber(undefined as unknown as string)).toThrow(InvalidPhoneNumberError);
    });

    it('should accept foreign mobile numbers in international form only (foreign tenants)', () => {
      expect(normalizePhoneNumber('+82 10-1234-5678')).toBe('+821012345678');
      expect(normalizePhoneNumber('0081 90 1234 5678')).toBe('+819012345678');
      // Không có mã quốc gia → hiểu là số Việt Nam → 11 chữ số bắt đầu bằng 0 bị từ chối, không đoán quốc gia
      expect(() => normalizePhoneNumber('01012345678')).toThrow(InvalidPhoneNumberError);
    });
  });

  describe('maskPhoneNumber', () => {
    it('should show only the first 3 and last 3 digits of the national number', () => {
      expect(maskPhoneNumber('+84901234567')).toBe('090****567');
    });

    it('should mask foreign numbers without revealing the middle digits', () => {
      const masked = maskPhoneNumber('+821012345678');
      expect(masked).toBe('+82****678');
      expect(masked).not.toContain('12345');
    });
  });

  it('should expose the last 6 digits used by the password policy', () => {
    expect(phoneTailDigits('+84901234567')).toBe('234567');
  });
});
