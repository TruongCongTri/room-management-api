import {
  checkTenantProfile,
  decodeCccd,
  guardianRequirement,
  isMinorOn,
  maskBankAccount,
  maskIdNumber,
  normalizeIdNumber,
  TenantProfileInput,
  toSearchName,
} from './tenant-profile.rules';
import { IdDocumentType } from '../../contracts/domain/occupancy.enums';

const TODAY = '2026-10-18';
/** Nam sinh 1999: chữ số thứ 4 = 0 (nam, 1900-1999), chữ số 5-6 = 99 */
const adult = (overrides: Partial<TenantProfileInput> = {}): TenantProfileInput => ({
  idDocumentType: IdDocumentType.CCCD,
  idCardNumber: '079099001234',
  nationality: 'VN',
  gender: 'MALE',
  dateOfBirth: '1999-08-15',
  idCardIssueDate: '2021-05-10',
  phone: '+84901234567',
  refundBankAccount: null,
  refundBankName: null,
  consentGuardianTenantId: null,
  ...overrides,
});
const fields = (profile: TenantProfileInput) => checkTenantProfile(profile, TODAY).map((i) => i.field);

describe('Tenant profile rules', () => {
  describe('normalisation, masking, search name', () => {
    it.each([
      ['079 099 001 234', '079099001234'],
      ['079.099.001-234', '079099001234'],
      ['０７９０９９００１２３４', '079099001234'],
      [' m 1234 5678 ', 'M12345678'],
      ['b/1234567', 'B1234567'],
    ])('should normalise %p to %p', (raw, expected) => {
      expect(normalizeIdNumber(raw)).toBe(expected);
    });

    it('should build a lower-case search name without Vietnamese diacritics (including đ)', () => {
      expect(toSearchName('  Nguyễn   Văn ĐỨC ')).toBe('nguyen van duc');
      expect(toSearchName('Trần Thị Ánh Hồng')).toBe('tran thi anh hong');
      expect(toSearchName('Kim Min-ji')).toBe('kim min-ji');
    });

    it('should mask without ever needing the full number', () => {
      expect(maskIdNumber('1234')).toBe('********1234');
      expect(maskBankAccount('4567')).toBe('*********4567');
      expect(maskBankAccount(null)).toBeNull();
    });
  });

  describe('CCCD / personal identification number', () => {
    it.each([
      ['079099001234', { gender: 'MALE', birthYear: 1999, provinceCode: 79 }],
      ['079199001234', { gender: 'FEMALE', birthYear: 1999, provinceCode: 79 }],
      ['001215001234', { gender: 'MALE', birthYear: 2015, provinceCode: 1 }],
      ['096300001234', { gender: 'FEMALE', birthYear: 2000, provinceCode: 96 }],
      ['079400001234', { gender: 'MALE', birthYear: 2100, provinceCode: 79 }],
    ])('should decode %p', (number, decoded) => {
      expect(decodeCccd(number)).toEqual(decoded);
    });

    it('should reject century codes 6-9, wrong lengths and letters', () => {
      for (const n of ['079699001234', '079999001234', '07909900123', '0790990012345', '07909900123A']) expect(decodeCccd(n)).toBeNull();
    });

    it('should accept a consistent adult profile', () => {
      expect(checkTenantProfile(adult(), TODAY)).toEqual([]);
    });

    it('should catch a number whose gender digit or birth year does not match the person', () => {
      expect(checkTenantProfile(adult({ gender: 'FEMALE' }), TODAY)).toEqual([
        { field: 'idCardNumber', message: 'The 4th digit of the number does not match the gender' },
      ]);
      expect(fields(adult({ dateOfBirth: '1998-08-15' }))).toEqual(['idCardNumber']);
      // Thế kỷ sai: 0 = sinh 1900-1999, nhưng ngày sinh 2005
      expect(fields(adult({ idCardNumber: '079005001234', dateOfBirth: '2005-01-01' }))).toEqual(['idCardNumber']);
      expect(fields(adult({ idCardNumber: '079205001234', dateOfBirth: '2005-01-01' }))).toEqual([]);
    });

    it('should reject province 000 and codes above 096', () => {
      expect(fields(adult({ idCardNumber: '000099001234' }))).toEqual(['idCardNumber']);
      expect(fields(adult({ idCardNumber: '097099001234' }))).toEqual(['idCardNumber']);
    });

    it('should identify foreign nationals by passport, never by CCCD', () => {
      expect(fields(adult({ nationality: 'KR' }))).toEqual(['idDocumentType']);
    });
  });

  describe('passport', () => {
    const passport = (number: string, nationality = 'KR') =>
      fields(adult({ idDocumentType: IdDocumentType.PASSPORT, idCardNumber: number, nationality, gender: 'FEMALE' }));

    it.each(['M12345678', 'B1234567', '123456789', 'C01X00T47', 'AB123456'])('should accept the international format %p', (n) => {
      expect(passport(n)).toEqual([]);
    });

    it.each(['ABCDEFGH', '12345', '1234567890123', 'M1234-567'])('should reject %p', (n) => {
      expect(passport(n)).toEqual(['idCardNumber']);
    });

    it('should allow a Vietnamese citizen identified by passport', () => {
      expect(passport('B1234567', 'VN')).toEqual([]);
    });
  });

  describe('dates', () => {
    it('should reject impossible, future and >120-year-old birth dates', () => {
      expect(fields(adult({ dateOfBirth: '1999-02-30' }))).toEqual(['dateOfBirth']);
      expect(fields(adult({ dateOfBirth: '2026-10-19', idCardNumber: '079226001234', idCardIssueDate: null }))).toEqual(['dateOfBirth']);
      expect(fields(adult({ dateOfBirth: '1905-01-01', idCardNumber: '079005001234', idCardIssueDate: null }))).toEqual(['dateOfBirth']);
      expect(fields(adult({ dateOfBirth: '1906-01-01', idCardNumber: '079006001234', idCardIssueDate: null }))).toEqual([]);
    });

    it('should reject an issue date in the future or before birth', () => {
      expect(fields(adult({ idCardIssueDate: '2026-10-19' }))).toEqual(['idCardIssueDate']);
      expect(fields(adult({ idCardIssueDate: '1999-08-14' }))).toEqual(['idCardIssueDate']);
      expect(fields(adult({ idCardIssueDate: '2026-10-18' }))).toEqual([]);
      expect(fields(adult({ idCardIssueDate: '2021-13-01' }))).toEqual(['idCardIssueDate']);
    });
  });

  describe('adults, children and guardians', () => {
    const child = (overrides: Partial<TenantProfileInput> = {}) =>
      adult({ idCardNumber: '079315004321', gender: 'FEMALE', dateOfBirth: '2015-03-02', idCardIssueDate: null, phone: null, ...overrides });

    it('should require a phone number for adults only', () => {
      expect(fields(adult({ phone: null }))).toEqual(['phone']);
      expect(fields(child({ consentGuardianTenantId: 'g' }))).toEqual([]);
    });

    it('should switch exactly on the 18th birthday (Vietnam calendar day)', () => {
      expect(isMinorOn('2008-10-18', TODAY)).toBe(false);
      expect(isMinorOn('2008-10-19', TODAY)).toBe(true);
      expect(guardianRequirement({ dateOfBirth: '2008-10-19', consentGuardianTenantId: null }, TODAY)).toBe('REQUIRED');
      expect(guardianRequirement({ dateOfBirth: '2008-10-18', consentGuardianTenantId: null }, TODAY)).toBeNull();
    });

    it('should treat a 29 February birthday as reached on 1 March', () => {
      expect(isMinorOn('2008-02-29', '2026-02-28')).toBe(true);
      expect(isMinorOn('2008-02-29', '2026-03-01')).toBe(false);
    });

    it('should require a guardian for a child and refuse one for an adult', () => {
      expect(guardianRequirement(child(), TODAY)).toBe('REQUIRED');
      expect(guardianRequirement(child({ consentGuardianTenantId: 'g' }), TODAY)).toBeNull();
      expect(guardianRequirement(adult({ consentGuardianTenantId: 'g' }), TODAY)).toBe('FORBIDDEN');
      expect(guardianRequirement(adult(), TODAY)).toBeNull();
      // Ngày sinh hỏng → đã có lỗi định dạng riêng, không đoán quy tắc giám hộ
      expect(guardianRequirement({ dateOfBirth: 'nope', consentGuardianTenantId: null }, TODAY)).toBeNull();
    });
  });

  it('should require the bank name with a refund account', () => {
    expect(fields(adult({ refundBankAccount: '0071001234567' }))).toEqual(['refundBankName']);
    expect(fields(adult({ refundBankAccount: '0071001234567', refundBankName: 'Vietcombank' }))).toEqual([]);
  });

  it('should report every problem at once', () => {
    expect(fields(adult({ nationality: 'US', phone: null, idCardIssueDate: '2030-01-01' }))).toEqual(
      expect.arrayContaining(['idDocumentType', 'idCardIssueDate', 'phone']),
    );
  });
});

describe('ListTenantsQueryDto', () => {
  // Hồi quy: enableImplicitConversion biến "false" thành true → minor=false từng trả về trẻ em
  it('should read minor=false as false and minor=true as true from the query string', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { ListTenantsQueryDto } = await import('../dto/tenants.dto');
    const parse = (minor: string) => plainToInstance(ListTenantsQueryDto, { minor }, { enableImplicitConversion: true });
    expect(parse('false').minor).toBe(false);
    expect(parse('true').minor).toBe(true);
    expect((await validate(parse('maybe'))).map((e) => e.property)).toEqual(['minor']);
  });
});
