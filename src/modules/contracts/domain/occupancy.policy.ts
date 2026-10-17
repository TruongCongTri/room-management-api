/**
 * Chính sách thuần (không I/O) cho phòng nhiều người ở - ContractOccupancyService (tài liệu 02, mục 5.4)
 * gọi các hàm này bên trong transaction + khóa `checkout:contract:{contractId}`:
 *  - Người đứng tên chuyển đi khi còn người ở → chuyển quyền đứng tên (và CCCD của hợp đồng) cho người kế nhiệm.
 *  - Người cuối cùng chuyển đi → phải trả phòng (checkout settlement), không chuyển quyền.
 *  - Định mức điện EVN chỉ tính người đã đăng ký tạm trú thành công.
 */
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { IdDocumentType, OccupancyStatus, OccupantRole, ResidencyStatus } from './occupancy.enums';

/** Tuổi có đầy đủ năng lực hành vi dân sự để đứng tên hợp đồng (BLDS 2015, Điều 20) */
export const PRIMARY_HOLDER_MIN_AGE = 18;

export interface OccupantSnapshot {
  tenantId: string;
  role: OccupantRole;
  status: OccupancyStatus;
  residencyStatus: ResidencyStatus;
  /** YYYY-MM-DD */
  movedInAt: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  idDocumentType: IdDocumentType;
  /** Đã có số CCCD / hộ chiếu (bản mã + blind index) */
  hasIdDocument: boolean;
  /** Đã đồng ý xử lý dữ liệu cá nhân (Luật 91/2025/QH15) */
  hasPdplConsent: boolean;
  /** Thứ tự kế nhiệm do các bên thỏa thuận (1 = ưu tiên nhất); null = theo ngày chuyển đến */
  successionOrder?: number | null;
}

export type NotEligibleReason = 'NOT_ACTIVE' | 'UNDERAGE' | 'MISSING_ID_DOCUMENT' | 'MISSING_PDPL_CONSENT';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Đủ 18 tuổi vào ngày `onDate` (so sánh chuỗi YYYY-MM-DD, không phụ thuộc múi giờ) */
export function isAdultOn(dateOfBirth: string, onDate: string, minAge = PRIMARY_HOLDER_MIN_AGE): boolean {
  if (!DATE.test(dateOfBirth) || !DATE.test(onDate)) {
    throw new UnprocessableEntityException({
      errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
      message: 'Dates must be formatted as YYYY-MM-DD.',
    });
  }
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  // Sinh ngày 29/02: tròn tuổi vào 01/03 của năm không nhuận
  const birthday = new Date(Date.UTC(year + minAge, month - 1, day)).toISOString().slice(0, 10);
  return birthday <= onDate;
}

export function primaryHolderIneligibility(occupant: OccupantSnapshot, onDate: string): NotEligibleReason[] {
  const reasons: NotEligibleReason[] = [];
  if (occupant.status !== OccupancyStatus.ACTIVE) reasons.push('NOT_ACTIVE');
  if (!isAdultOn(occupant.dateOfBirth, onDate)) reasons.push('UNDERAGE');
  if (!occupant.hasIdDocument) reasons.push('MISSING_ID_DOCUMENT');
  if (!occupant.hasPdplConsent) reasons.push('MISSING_PDPL_CONSENT');
  return reasons;
}

const bySuccession = (a: OccupantSnapshot, b: OccupantSnapshot): number => {
  const orderA = a.successionOrder ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.successionOrder ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  if (a.movedInAt !== b.movedInAt) return a.movedInAt < b.movedInAt ? -1 : 1;
  return a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0; // tất định khi trùng mọi tiêu chí
};

/**
 * Chọn người đứng tên kế tiếp khi người đứng tên hiện tại chuyển đi vào ngày `effectiveDate`.
 *  - `preferredTenantId` (do quản lý chỉ định theo thỏa thuận của các bên) phải đủ điều kiện, nếu không → 422.
 *  - Không chỉ định: người đủ điều kiện có successionOrder nhỏ nhất, rồi chuyển đến sớm nhất.
 *  - Không còn ai ở lại → 409 BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT (phải trả phòng, quyết toán cọc).
 *  - Còn người ở nhưng không ai đủ điều kiện (vd: chỉ còn trẻ em) → 409 BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED.
 */
export function selectNextPrimaryHolder(
  occupants: readonly OccupantSnapshot[],
  outgoingTenantId: string,
  effectiveDate: string,
  preferredTenantId?: string,
): OccupantSnapshot {
  const outgoing = occupants.find(
    (o) => o.tenantId === outgoingTenantId && o.role === OccupantRole.PRIMARY_HOLDER && o.status === OccupancyStatus.ACTIVE,
  );
  if (!outgoing) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_NOT_ACTIVE,
      message: 'The outgoing tenant is not the active primary holder of this contract.',
    });
  }

  const remaining = occupants.filter((o) => o.tenantId !== outgoingTenantId && o.status === OccupancyStatus.ACTIVE);
  if (remaining.length === 0) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT,
      message: 'The primary holder is the last occupant: execute a checkout settlement instead of a transfer.',
    });
  }

  if (preferredTenantId) {
    const preferred = remaining.find((o) => o.tenantId === preferredTenantId);
    const reasons = preferred ? primaryHolderIneligibility(preferred, effectiveDate) : (['NOT_ACTIVE'] as NotEligibleReason[]);
    if (!preferred || reasons.length > 0) {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE,
        message: 'The designated successor cannot hold the contract.',
        details: reasons.map((issue) => ({ field: 'newPrimaryTenantId', issue })),
      });
    }
    return preferred;
  }

  const next = remaining.filter((o) => primaryHolderIneligibility(o, effectiveDate).length === 0).sort(bySuccession)[0];
  if (!next) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED,
      message: 'No remaining occupant is eligible (adult, ID document, PDPL consent) to become the primary holder.',
    });
  }
  return next;
}

/** Định mức điện bậc thang: chỉ người đang ở VÀ đã đăng ký tạm trú thành công (TT 09/2023/TT-BCT) */
export function countEvnQuotaHeadcount(occupants: readonly OccupantSnapshot[]): number {
  return occupants.filter((o) => o.status === OccupancyStatus.ACTIVE && o.residencyStatus === ResidencyStatus.REGISTERED)
    .length;
}

/** Thêm người ở: mọi người (kể cả trẻ em) phải có giấy tờ định danh, không vượt sức chứa của phòng */
export function assertCanAddOccupant(
  occupants: readonly OccupantSnapshot[],
  candidate: Pick<OccupantSnapshot, 'tenantId' | 'hasIdDocument' | 'hasPdplConsent'>,
  maxOccupants: number,
): void {
  if (!candidate.hasIdDocument) {
    throw new UnprocessableEntityException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_ID_DOCUMENT_REQUIRED,
      message: 'Every occupant must provide a CCCD / personal ID number or passport.',
    });
  }
  if (!candidate.hasPdplConsent) {
    throw new UnprocessableEntityException({
      errorCode: SystemErrorCode.BIZ_PDPL_CONSENT_REQUIRED,
      message: 'Personal data processing consent is required for every occupant.',
    });
  }
  const active = occupants.filter((o) => o.status === OccupancyStatus.ACTIVE);
  if (active.some((o) => o.tenantId === candidate.tenantId)) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_ALREADY_ACTIVE,
      message: 'This person already lives in the room.',
    });
  }
  if (active.length + 1 > maxOccupants) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_LIMIT_EXCEEDED,
      message: `The room allows at most ${maxOccupants} occupant(s).`,
    });
  }
}
