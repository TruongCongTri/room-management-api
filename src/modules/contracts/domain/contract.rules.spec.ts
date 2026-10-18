import { ConflictException } from '@nestjs/common';
import {
  addDays,
  addYears,
  assertResidencyTransition,
  checkContractTerms,
  checkPlannedPeople,
  checkTemporaryStayValidUntil,
  depositTopUp,
  formatAddendumNo,
  formatContractCode,
  isCalendarDate,
  isValidLicensePlate,
  normalizeLicensePlate,
  residencyOnMoveOut,
  roomCodePart,
} from './contract.rules';
import { IdDocumentType, OccupancyStatus, ResidenceChannel, ResidencyStatus, residenceChannelFor } from './occupancy.enums';

const R = ResidencyStatus;

describe('Contract rules', () => {
  describe('dates', () => {
    it('should accept only real calendar dates', () => {
      expect(isCalendarDate('2028-02-29')).toBe(true);
      expect(isCalendarDate('2026-02-29')).toBe(false);
      expect(isCalendarDate('2026-04-31')).toBe(false);
      expect(isCalendarDate('2026-4-01')).toBe(false);
      expect(isCalendarDate('')).toBe(false);
    });

    it('should add days across month and year ends', () => {
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    });

    it('should add years and clamp 29 February to the 28th (never beyond the legal maximum)', () => {
      expect(addYears('2026-10-18', 2)).toBe('2028-10-18');
      expect(addYears('2028-02-29', 2)).toBe('2030-02-28');
    });
  });

  describe('codes', () => {
    it('should build the contract code per year and building sequence', () => {
      expect(formatContractCode(2026, 7, 'P.302')).toBe('HD-2026/007-P302');
      expect(formatContractCode(2026, 1234, 'p 12-a')).toBe('HD-2026/1234-P12A');
      expect(roomCodePart('...')).toBe('ROOM');
    });

    it('should number addenda from the contract code', () => {
      expect(formatAddendumNo('HD-2026/007-P302', 1)).toBe('PL-2026/007-P302-01');
      expect(formatAddendumNo('HD-2026/007-P302', 12)).toBe('PL-2026/007-P302-12');
    });
  });

  describe('terms', () => {
    const terms = (o: Partial<{ startDate: string; endDate: string; paymentDueDay: number }> = {}) => ({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      paymentDueDay: 5,
      ...o,
    });
    const fields = (t: ReturnType<typeof terms>) => checkContractTerms(t).map((i) => i.field);

    it('should accept a normal one-year term', () => {
      expect(checkContractTerms(terms())).toEqual([]);
    });

    it('should require the end after the start (same day is not a term)', () => {
      expect(fields(terms({ endDate: '2026-11-01' }))).toEqual(['endDate']);
      expect(fields(terms({ endDate: '2026-10-31' }))).toEqual(['endDate']);
      expect(fields(terms({ endDate: '2026-11-02' }))).toEqual([]);
    });

    it('should reject impossible dates and due days outside 1..28', () => {
      expect(fields(terms({ startDate: '2026-02-30' }))).toEqual(['startDate']);
      expect(fields(terms({ paymentDueDay: 0 }))).toEqual(['paymentDueDay']);
      expect(fields(terms({ paymentDueDay: 29 }))).toEqual(['paymentDueDay']);
      expect(fields(terms({ paymentDueDay: 28 }))).toEqual([]);
      expect(fields(terms({ paymentDueDay: 1 }))).toEqual([]);
    });

    it('should reject the holder in the planned list, duplicates and move-in dates outside the term', () => {
      const t = terms();
      expect(checkPlannedPeople('h', [{ tenantId: 'h', movedInAt: null }], t).map((i) => i.field)).toEqual(['coOccupants[0].tenantId']);
      expect(
        checkPlannedPeople('h', [{ tenantId: 'a', movedInAt: null }, { tenantId: 'a', movedInAt: null }], t).map((i) => i.field),
      ).toEqual(['coOccupants[1].tenantId']);
      expect(checkPlannedPeople('h', [{ tenantId: 'a', movedInAt: '2026-10-31' }], t).map((i) => i.field)).toEqual(['coOccupants[0].movedInAt']);
      expect(checkPlannedPeople('h', [{ tenantId: 'a', movedInAt: '2027-11-01' }], t).map((i) => i.field)).toEqual(['coOccupants[0].movedInAt']);
      // Biên: đúng ngày bắt đầu và đúng ngày kết thúc
      expect(checkPlannedPeople('h', [{ tenantId: 'a', movedInAt: '2026-11-01' }, { tenantId: 'b', movedInAt: '2027-10-31' }], t)).toEqual([]);
    });
  });

  describe('residence', () => {
    const ok = (status: OccupancyStatus, from: ResidencyStatus, to: ResidencyStatus) => () => assertResidencyTransition(status, from, to);

    it('should allow exactly PENDING → SUBMITTED → REGISTERED while living there', () => {
      expect(ok(OccupancyStatus.ACTIVE, R.PENDING_DECLARATION, R.SUBMITTED)).not.toThrow();
      expect(ok(OccupancyStatus.ACTIVE, R.SUBMITTED, R.REGISTERED)).not.toThrow();
    });

    it.each([
      [R.PENDING_DECLARATION, R.REGISTERED],
      [R.REGISTERED, R.SUBMITTED],
      [R.REGISTERED, R.REGISTERED],
      [R.SUBMITTED, R.DEREGISTERED],
      [R.DEREGISTRATION_PENDING, R.DEREGISTERED],
    ])('should refuse %s → %s while living there', (from, to) => {
      expect(ok(OccupancyStatus.ACTIVE, from, to)).toThrow(ConflictException);
    });

    it('should allow only DEREGISTRATION_PENDING → DEREGISTERED after moving out', () => {
      expect(ok(OccupancyStatus.MOVED_OUT, R.DEREGISTRATION_PENDING, R.DEREGISTERED)).not.toThrow();
      expect(ok(OccupancyStatus.MOVED_OUT, R.SUBMITTED, R.REGISTERED)).toThrow(ConflictException);
      expect(ok(OccupancyStatus.MOVED_OUT, R.DEREGISTERED, R.DEREGISTERED)).toThrow(ConflictException);
    });

    it('should answer with BIZ_RESIDENCY_TRANSITION_INVALID and the allowed next step', () => {
      try {
        assertResidencyTransition(OccupancyStatus.ACTIVE, R.PENDING_DECLARATION, R.REGISTERED);
        fail('expected a conflict');
      } catch (err) {
        const body = (err as ConflictException).getResponse() as any;
        expect(body.errorCode).toBe('BIZ_RESIDENCY_TRANSITION_INVALID');
        expect(body.details[0]).toMatchObject({ field: 'residencyStatus', from: R.PENDING_DECLARATION, to: R.REGISTERED, allowed: R.SUBMITTED });
      }
    });

    it('should route residence by nationality: Vietnamese use CT01 even with a passport, foreigners never', () => {
      expect(residenceChannelFor({ idDocumentType: IdDocumentType.CCCD, nationality: 'VN' })).toBe(ResidenceChannel.CT01);
      expect(residenceChannelFor({ idDocumentType: IdDocumentType.PASSPORT, nationality: 'VN' })).toBe(ResidenceChannel.CT01);
      expect(residenceChannelFor({ idDocumentType: IdDocumentType.PASSPORT, nationality: 'KR' })).toBe(ResidenceChannel.FOREIGNER_TEMPORARY_RESIDENCE);
    });

    it('should skip deregistration for someone never declared, and require it otherwise', () => {
      expect(residencyOnMoveOut(R.PENDING_DECLARATION)).toBe(R.DEREGISTERED);
      expect(residencyOnMoveOut(R.SUBMITTED)).toBe(R.DEREGISTRATION_PENDING);
      expect(residencyOnMoveOut(R.REGISTERED)).toBe(R.DEREGISTRATION_PENDING);
      expect(residencyOnMoveOut(R.DEREGISTERED)).toBe(R.DEREGISTERED);
    });

    it('should cap the temporary stay at 2 years from today (Residence Law 2020, Art. 27)', () => {
      const today = '2026-10-18';
      expect(checkTemporaryStayValidUntil('2028-10-18', today)).toBeNull();
      expect(checkTemporaryStayValidUntil('2028-10-19', today)?.message).toBe('At most 2 years from today');
      expect(checkTemporaryStayValidUntil('2026-10-18', today)?.message).toBe('Must be after today');
      expect(checkTemporaryStayValidUntil('2026-10-19', today)).toBeNull();
      expect(checkTemporaryStayValidUntil(null, today)?.message).toMatch(/Required/);
      expect(checkTemporaryStayValidUntil('2027-02-30', today)?.message).toBe('Not a valid calendar date');
    });
  });

  describe('money & vehicles', () => {
    it('should top the deposit up to one month of the new rent, never below zero', () => {
      expect(depositTopUp(6_500_000, 7_000_000)).toBe(500_000);
      expect(depositTopUp(6_500_000, 6_500_000)).toBe(0);
      expect(depositTopUp(7_000_000, 6_500_000)).toBe(0);
      expect(depositTopUp(0, 6_500_000)).toBe(6_500_000);
    });

    it('should normalise plates (upper case, single spaces) and treat blank as none', () => {
      expect(normalizeLicensePlate(' 59-g2  123.45 ')).toBe('59-G2 123.45');
      expect(normalizeLicensePlate('   ')).toBeNull();
      expect(normalizeLicensePlate(null)).toBeNull();
    });

    it.each(['59-G2 123.45', '51F-123.45', '30A12345', 'NG-123-45'])('should accept the plate %p', (p) => {
      expect(isValidLicensePlate(p)).toBe(true);
    });

    it.each(['ABCDEF', '12', '-59G2', '59G2-', '59_G2_123', 'A'.repeat(21)])('should reject the plate %p', (p) => {
      expect(isValidLicensePlate(p)).toBe(false);
    });
  });
});
