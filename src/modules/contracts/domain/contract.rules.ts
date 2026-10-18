/**
 * Quy tắc thuần (không I/O) của vòng đời hợp đồng, cư trú, xe & dịch vụ (tài liệu 02, mục 5.5 - quyết định D8).
 * Tiền là VND nguyên (DTO chỉ nhận số nguyên) → số học Number chính xác.
 */
import { ConflictException } from '@nestjs/common';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { OccupancyStatus, ResidencyStatus } from './occupancy.enums';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày hợp lệ theo lịch (2026-02-30 → false) */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Cộng năm; 29/02 → 28/02 khi năm đích không nhuận (không vượt quá hạn tối đa) */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** "P.302" → "P302": phần phòng trong mã hợp đồng / phụ lục */
export function roomCodePart(roomNumber: string): string {
  return roomNumber.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ROOM';
}

/** HD-{YYYY}/{NNN}-{phòng}, vd: HD-2026/007-P302 */
export function formatContractCode(year: number, sequence: number, roomNumber: string): string {
  return `HD-${year}/${String(sequence).padStart(3, '0')}-${roomCodePart(roomNumber)}`;
}

/** Phụ lục thứ n của hợp đồng (đổi người đứng tên và gia hạn dùng chung bộ đếm): PL-2026/007-P302-01 */
export function formatAddendumNo(contractCode: string, n: number): string {
  return `PL-${contractCode.replace(/^HD-/, '')}-${String(n).padStart(2, '0')}`;
}

export interface ContractTerms {
  startDate: string;
  endDate: string;
  paymentDueDay: number;
}

export interface TermIssue {
  field: string;
  message: string;
}

export function checkContractTerms(terms: ContractTerms): TermIssue[] {
  const issues: TermIssue[] = [];
  const startOk = isCalendarDate(terms.startDate);
  const endOk = isCalendarDate(terms.endDate);
  if (!startOk) issues.push({ field: 'startDate', message: 'Not a valid calendar date' });
  if (!endOk) issues.push({ field: 'endDate', message: 'Not a valid calendar date' });
  if (startOk && endOk && terms.endDate <= terms.startDate) issues.push({ field: 'endDate', message: 'Must be after startDate' });
  if (!Number.isInteger(terms.paymentDueDay) || terms.paymentDueDay < 1 || terms.paymentDueDay > 28) {
    issues.push({ field: 'paymentDueDay', message: 'Must be a day between 1 and 28' });
  }
  return issues;
}

export interface PlannedPerson {
  tenantId: string;
  movedInAt: string | null;
}

/** Danh sách người dự kiến: không trùng, không chứa người đứng tên, ngày chuyển đến nằm trong thời hạn hợp đồng */
export function checkPlannedPeople(holderId: string, planned: readonly PlannedPerson[], terms: Pick<ContractTerms, 'startDate' | 'endDate'>): TermIssue[] {
  const issues: TermIssue[] = [];
  const seen = new Set<string>();
  planned.forEach((p, i) => {
    if (p.tenantId === holderId) issues.push({ field: `coOccupants[${i}].tenantId`, message: 'The holder is already in the contract' });
    else if (seen.has(p.tenantId)) issues.push({ field: `coOccupants[${i}].tenantId`, message: 'Listed twice' });
    seen.add(p.tenantId);
    if (p.movedInAt !== null) {
      if (!isCalendarDate(p.movedInAt)) issues.push({ field: `coOccupants[${i}].movedInAt`, message: 'Not a valid calendar date' });
      else if (p.movedInAt < terms.startDate || p.movedInAt > terms.endDate) {
        issues.push({ field: `coOccupants[${i}].movedInAt`, message: 'Must be within the contract term' });
      }
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------- residence

const WHILE_LIVING: Partial<Record<ResidencyStatus, ResidencyStatus>> = {
  [ResidencyStatus.PENDING_DECLARATION]: ResidencyStatus.SUBMITTED,
  [ResidencyStatus.SUBMITTED]: ResidencyStatus.REGISTERED,
};
const AFTER_LEAVING: Partial<Record<ResidencyStatus, ResidencyStatus>> = {
  [ResidencyStatus.DEREGISTRATION_PENDING]: ResidencyStatus.DEREGISTERED,
};

/** PENDING_DECLARATION → SUBMITTED → REGISTERED khi đang ở; DEREGISTRATION_PENDING → DEREGISTERED sau khi chuyển đi */
export function assertResidencyTransition(occupancy: OccupancyStatus, from: ResidencyStatus, to: ResidencyStatus): void {
  const allowed = occupancy === OccupancyStatus.ACTIVE ? WHILE_LIVING[from] : AFTER_LEAVING[from];
  if (allowed !== to) {
    throw new ConflictException({
      errorCode: SystemErrorCode.BIZ_RESIDENCY_TRANSITION_INVALID,
      message: `Residence status cannot go from ${from} to ${to}${occupancy === OccupancyStatus.MOVED_OUT ? ' after moving out' : ''}.`,
      details: [{ field: 'residencyStatus', issue: 'TRANSITION_INVALID', from, to, ...(allowed ? { allowed } : {}) }],
    });
  }
}

/** Chuyển đi: chưa từng khai báo → không có gì để xóa (DEREGISTERED); còn lại → cần xóa đăng ký tạm trú */
export function residencyOnMoveOut(current: ResidencyStatus): ResidencyStatus {
  if (current === ResidencyStatus.PENDING_DECLARATION) return ResidencyStatus.DEREGISTERED;
  if (current === ResidencyStatus.DEREGISTERED) return ResidencyStatus.DEREGISTERED;
  return ResidencyStatus.DEREGISTRATION_PENDING;
}

/** Luật Cư trú 2020, Điều 27: tạm trú tối đa 2 năm mỗi lần */
export const MAX_TEMPORARY_STAY_YEARS = 2;

export function checkTemporaryStayValidUntil(value: string | null | undefined, today: string): TermIssue | null {
  if (!value) return { field: 'temporaryStayValidUntil', message: 'Required when the residence is REGISTERED' };
  if (!isCalendarDate(value)) return { field: 'temporaryStayValidUntil', message: 'Not a valid calendar date' };
  if (value <= today) return { field: 'temporaryStayValidUntil', message: 'Must be after today' };
  if (value > addYears(today, MAX_TEMPORARY_STAY_YEARS)) return { field: 'temporaryStayValidUntil', message: 'At most 2 years from today' };
  return null;
}

// ---------------------------------------------------------------------------- money, vehicles

/** Bù cọc lên đủ một tháng tiền thuê mới; 0 khi số dư đã đủ */
export function depositTopUp(currentBalance: number, newMonthlyRent: number): number {
  return Math.max(0, newMonthlyRent - currentBalance);
}

/** Biển số: chữ hoa, gộp khoảng trắng ("59-g2  123.45 " → "59-G2 123.45"); rỗng → null */
export function normalizeLicensePlate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const plate = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  return plate === '' ? null : plate;
}

/** Biển số Việt Nam / nước ngoài: 4-20 ký tự chữ, số, dấu chấm, gạch, khoảng trắng; có ít nhất một chữ số */
export function isValidLicensePlate(plate: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\- ]{2,18}[A-Z0-9]$/.test(plate) && /\d/.test(plate);
}
