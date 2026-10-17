import { REGEX_PATTERNS } from './regex.constant';
import { SystemErrorCode } from './error-codes.constant';
import { SYSTEM_HEADERS } from './headers.constant';
import { EVN_RESIDENTIAL_TIERS, VN_TAX_2026 } from './vn-rental.constant';

describe('Common Constants & Regex Specifications', () => {
  describe('REGEX_PATTERNS', () => {
    it('should validate valid UUID v4 and reject invalid ones', () => {
      const validUuid = 'c30590a2-aa94-49f1-acba-07973099bc5d';
      const invalidUuid = 'not-a-valid-uuid-format';

      expect(REGEX_PATTERNS.UUID.test(validUuid)).toBe(true);
      expect(REGEX_PATTERNS.UUID.test(invalidUuid)).toBe(false);
    });

    it('should validate Vietnam phone numbers', () => {
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('0987654321')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('+84912345678')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('0123456789')).toBe(false); // Đầu số cũ
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('12345')).toBe(false);
      // Ký tự '|' từng lọt qua lớp ký tự 5[6|8|9] / 7[0|6-9]
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('05|1234567')).toBe(false);
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('07|1234567')).toBe(false);
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('0521234567')).toBe(true); // Vietnamobile 052
      expect(REGEX_PATTERNS.VIETNAM_PHONE.test('0541234567')).toBe(false); // 054 chưa cấp cho di động
    });

    it('should validate rental identifiers (room number, billing month, license plate, tax code)', () => {
      expect(REGEX_PATTERNS.ROOM_NUMBER.test('P.302')).toBe(true);
      expect(REGEX_PATTERNS.ROOM_NUMBER.test('A-1203')).toBe(true);
      expect(REGEX_PATTERNS.ROOM_NUMBER.test('../302')).toBe(false);

      expect(REGEX_PATTERNS.BILLING_MONTH.test('2026-10')).toBe(true);
      expect(REGEX_PATTERNS.BILLING_MONTH.test('2026-13')).toBe(false);

      expect(REGEX_PATTERNS.VIETNAM_LICENSE_PLATE.test('59X1-234.56')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_LICENSE_PLATE.test('51F-12345')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_LICENSE_PLATE.test('ABC')).toBe(false);

      expect(REGEX_PATTERNS.VIETNAM_TAX_CODE.test('0312345678')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_TAX_CODE.test('0312345678-001')).toBe(true);
      expect(REGEX_PATTERNS.VIETNAM_CITIZEN_ID.test('079203001234')).toBe(true);
    });

    it('should validate strong password constraints', () => {
      expect(REGEX_PATTERNS.STRONG_PASSWORD.test('Pass@word123')).toBe(true);
      expect(REGEX_PATTERNS.STRONG_PASSWORD.test('weakpassword')).toBe(false);
      expect(REGEX_PATTERNS.STRONG_PASSWORD.test('NoSpecial123')).toBe(false);
    });
  });

  describe('2026 Vietnam rental constants', () => {
    it('should expose the 1 billion VND tax threshold, 5% VAT / PIT and a 6-tier EVN tariff', () => {
      expect(VN_TAX_2026.EXEMPT_THRESHOLD_VND).toBe(1_000_000_000);
      expect(VN_TAX_2026.VAT_RATE_PERCENT).toBe(5);
      expect(VN_TAX_2026.PIT_RATE_PERCENT).toBe(5);
      expect(EVN_RESIDENTIAL_TIERS).toHaveLength(6);
      expect(EVN_RESIDENTIAL_TIERS[5].widthKwh).toBeNull();
    });
  });

  describe('SystemErrorCode & Headers', () => {
    it('should define distinct error code identifiers', () => {
      expect(SystemErrorCode.AUTH_UNAUTHORIZED).toBe('AUTH_UNAUTHORIZED');
      expect(SystemErrorCode.RES_CONCURRENCY_CONFLICT).toBe('RES_CONCURRENCY_CONFLICT');
      expect(SystemErrorCode.EXT_CIRCUIT_BREAKER_OPEN).toBe('EXT_CIRCUIT_OPEN');
    });

    it('should match standard header names', () => {
      expect(SYSTEM_HEADERS.IDEMPOTENCY_KEY).toBe('idempotency-key');
      expect(SYSTEM_HEADERS.BUILDING_ID).toBe('x-building-id');
      expect(SYSTEM_HEADERS.TRACE_ID).toBe('x-trace-id');
    });
  });
});

// npx jest src/common/constants/constants.spec.ts