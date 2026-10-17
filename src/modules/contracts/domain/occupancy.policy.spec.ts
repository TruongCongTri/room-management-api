import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import {
  assertCanAddOccupant,
  countEvnQuotaHeadcount,
  isAdultOn,
  OccupantSnapshot,
  selectNextPrimaryHolder,
} from './occupancy.policy';
import { IdDocumentType, OccupancyStatus, OccupantRole, ResidencyStatus } from './occupancy.enums';

const EFFECTIVE = '2026-10-17';

const occupant = (tenantId: string, overrides: Partial<OccupantSnapshot> = {}): OccupantSnapshot => ({
  tenantId,
  role: OccupantRole.CO_OCCUPANT,
  status: OccupancyStatus.ACTIVE,
  residencyStatus: ResidencyStatus.REGISTERED,
  movedInAt: '2026-01-10',
  dateOfBirth: '1995-05-05',
  idDocumentType: IdDocumentType.CCCD,
  hasIdDocument: true,
  hasPdplConsent: true,
  successionOrder: null,
  ...overrides,
});

const holder = (overrides: Partial<OccupantSnapshot> = {}) =>
  occupant('holder', { role: OccupantRole.PRIMARY_HOLDER, movedInAt: '2025-12-01', ...overrides });

/** Bắt lỗi và trả về errorCode client sẽ nhận được */
const errorCodeOf = (fn: () => unknown): { type: string; errorCode: string; details?: unknown } => {
  try {
    fn();
  } catch (err: any) {
    const response = err.getResponse();
    return { type: err.constructor.name, errorCode: response.errorCode, details: response.details };
  }
  throw new Error('Expected the call to throw');
};

describe('Occupancy policy (shared room, one contract holder)', () => {
  describe('selectNextPrimaryHolder', () => {
    it('should pass the contract to the occupant who moved in earliest when no succession order is agreed', () => {
      const next = selectNextPrimaryHolder(
        [holder(), occupant('late', { movedInAt: '2026-06-01' }), occupant('early', { movedInAt: '2026-02-01' })],
        'holder',
        EFFECTIVE,
      );
      expect(next.tenantId).toBe('early');
    });

    it('should honour the agreed succession order over move-in dates', () => {
      const next = selectNextPrimaryHolder(
        [holder(), occupant('early', { movedInAt: '2026-02-01' }), occupant('agreed', { movedInAt: '2026-06-01', successionOrder: 1 })],
        'holder',
        EFFECTIVE,
      );
      expect(next.tenantId).toBe('agreed');
    });

    it('should skip minors, occupants without ID or consent, and people who already moved out', () => {
      const next = selectNextPrimaryHolder(
        [
          holder(),
          occupant('child', { movedInAt: '2025-12-01', dateOfBirth: '2012-03-03', successionOrder: 1 }),
          occupant('no-id', { movedInAt: '2025-12-02', hasIdDocument: false }),
          occupant('no-consent', { movedInAt: '2025-12-03', hasPdplConsent: false }),
          occupant('gone', { movedInAt: '2025-12-04', status: OccupancyStatus.MOVED_OUT }),
          occupant('eligible', { movedInAt: '2026-08-01' }),
        ],
        'holder',
        EFFECTIVE,
      );
      expect(next.tenantId).toBe('eligible');
    });

    it('should accept a valid designated successor even if someone else moved in earlier', () => {
      const next = selectNextPrimaryHolder(
        [holder(), occupant('early', { movedInAt: '2026-01-01' }), occupant('chosen', { movedInAt: '2026-09-01' })],
        'holder',
        EFFECTIVE,
        'chosen',
      );
      expect(next.tenantId).toBe('chosen');
    });

    it('should reject an ineligible designated successor with the reasons, instead of silently picking someone else', () => {
      const result = errorCodeOf(() =>
        selectNextPrimaryHolder(
          [holder(), occupant('adult'), occupant('teen', { dateOfBirth: '2010-01-01', hasPdplConsent: false })],
          'holder',
          EFFECTIVE,
          'teen',
        ),
      );
      expect(result).toEqual({
        type: UnprocessableEntityException.name,
        errorCode: 'BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE',
        details: [
          { field: 'newPrimaryTenantId', issue: 'UNDERAGE' },
          { field: 'newPrimaryTenantId', issue: 'MISSING_PDPL_CONSENT' },
        ],
      });
    });

    it('should reject a designated successor who does not live in the room', () => {
      expect(errorCodeOf(() => selectNextPrimaryHolder([holder(), occupant('adult')], 'holder', EFFECTIVE, 'stranger')).errorCode).toBe(
        'BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE',
      );
    });

    it('should require a checkout (not a transfer) when the holder is the last occupant', () => {
      expect(
        errorCodeOf(() => selectNextPrimaryHolder([holder(), occupant('gone', { status: OccupancyStatus.MOVED_OUT })], 'holder', EFFECTIVE)),
      ).toEqual({ type: ConflictException.name, errorCode: 'BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT', details: undefined });
    });

    it('should block the transfer when only minors would remain', () => {
      expect(
        errorCodeOf(() => selectNextPrimaryHolder([holder(), occupant('child', { dateOfBirth: '2015-07-07' })], 'holder', EFFECTIVE))
          .errorCode,
      ).toBe('BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED');
    });

    it('should refuse when the outgoing person is not the active holder', () => {
      expect(errorCodeOf(() => selectNextPrimaryHolder([holder(), occupant('adult')], 'adult', EFFECTIVE)).errorCode).toBe(
        'BIZ_OCCUPANT_NOT_ACTIVE',
      );
      expect(
        errorCodeOf(() => selectNextPrimaryHolder([holder({ status: OccupancyStatus.MOVED_OUT }), occupant('adult')], 'holder', EFFECTIVE))
          .errorCode,
      ).toBe('BIZ_OCCUPANT_NOT_ACTIVE');
    });

    it('should break exact ties deterministically', () => {
      const occupants = [holder(), occupant('b-tenant'), occupant('a-tenant')];
      expect(selectNextPrimaryHolder(occupants, 'holder', EFFECTIVE).tenantId).toBe('a-tenant');
      expect(selectNextPrimaryHolder([...occupants].reverse(), 'holder', EFFECTIVE).tenantId).toBe('a-tenant');
    });
  });

  describe('isAdultOn (18th birthday boundary)', () => {
    it('should become eligible exactly on the 18th birthday, not the day before', () => {
      expect(isAdultOn('2008-10-17', '2026-10-17')).toBe(true);
      expect(isAdultOn('2008-10-18', '2026-10-17')).toBe(false);
    });

    it('should treat a 29 February birthday as reached on 1 March in non-leap years', () => {
      expect(isAdultOn('2008-02-29', '2026-02-28')).toBe(false);
      expect(isAdultOn('2008-02-29', '2026-03-01')).toBe(true);
    });

    it('should reject malformed dates instead of guessing', () => {
      expect(() => isAdultOn('17/10/2008', '2026-10-17')).toThrow(UnprocessableEntityException);
    });
  });

  describe('countEvnQuotaHeadcount', () => {
    it('should count only occupants still living there whose temporary residence is registered', () => {
      expect(
        countEvnQuotaHeadcount([
          holder(),
          occupant('registered'),
          occupant('pending', { residencyStatus: ResidencyStatus.PENDING_DECLARATION }),
          occupant('submitted', { residencyStatus: ResidencyStatus.SUBMITTED }),
          occupant('left', { status: OccupancyStatus.MOVED_OUT, residencyStatus: ResidencyStatus.DEREGISTRATION_PENDING }),
        ]),
      ).toBe(2);
    });
  });

  describe('assertCanAddOccupant', () => {
    const newcomer = { tenantId: 'new', hasIdDocument: true, hasPdplConsent: true };

    it('should allow filling the room exactly to capacity and refuse one more', () => {
      expect(() => assertCanAddOccupant([holder()], newcomer, 2)).not.toThrow();
      expect(errorCodeOf(() => assertCanAddOccupant([holder(), occupant('second')], newcomer, 2)).errorCode).toBe(
        'BIZ_OCCUPANT_LIMIT_EXCEEDED',
      );
    });

    it('should not count people who moved out against capacity, and let them move back in', () => {
      expect(() =>
        assertCanAddOccupant([holder(), occupant('new', { status: OccupancyStatus.MOVED_OUT })], newcomer, 2),
      ).not.toThrow();
    });

    it('should require an ID document and consent from every occupant, including children', () => {
      expect(errorCodeOf(() => assertCanAddOccupant([holder()], { ...newcomer, hasIdDocument: false }, 4)).errorCode).toBe(
        'BIZ_OCCUPANT_ID_DOCUMENT_REQUIRED',
      );
      expect(errorCodeOf(() => assertCanAddOccupant([holder()], { ...newcomer, hasPdplConsent: false }, 4)).errorCode).toBe(
        'BIZ_PDPL_CONSENT_REQUIRED',
      );
    });

    it('should reject adding someone who already lives in the room', () => {
      expect(errorCodeOf(() => assertCanAddOccupant([holder(), occupant('new')], newcomer, 4)).errorCode).toBe(
        'BIZ_OCCUPANT_ALREADY_ACTIVE',
      );
    });
  });
});

// npx jest src/modules/contracts/domain/occupancy.policy.spec.ts
