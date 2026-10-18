/** Tiện ích dùng chung của PropertiesModule & AssetsModule: lỗi nghiệp vụ chuẩn hóa và chuyển đổi numeric */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SystemErrorCode } from '../../common/constants/error-codes.constant';

/** Cột numeric của PostgreSQL về số JS (tiền VND, diện tích) */
export const toNumber = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export const notFound = (resource: string, field?: string) =>
  new NotFoundException({
    errorCode: SystemErrorCode.RES_NOT_FOUND,
    message: `${resource} not found in this building.`,
    ...(field ? { details: [{ field, issue: 'NOT_FOUND' }] } : {}),
  });

export const alreadyExists = (field: string, value: string) =>
  new ConflictException({
    errorCode: SystemErrorCode.RES_ALREADY_EXISTS,
    message: `${field} '${value}' already exists.`,
    details: [{ field, issue: 'ALREADY_EXISTS' }],
  });

export const staleVersion = () =>
  new ConflictException({
    errorCode: SystemErrorCode.RES_CONCURRENCY_CONFLICT,
    message: 'The record was changed by someone else. Reload and try again.',
  });

export const nothingToUpdate = () =>
  new BadRequestException({
    errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
    message: 'Nothing to update.',
    details: [{ field: 'body', message: 'Provide at least one field to change' }],
  });

/** Vi phạm unique (23505) trên đúng index / constraint - dùng khi hai request ghi song song vượt qua kiểm tra trước */
export const isUniqueViolation = (err: any, constraint: string): boolean =>
  err?.code === '23505' && (err?.constraint === constraint || String(err?.detail ?? err?.message ?? '').includes(constraint));

export function assertSomethingToUpdate(dto: object): void {
  const { version: _version, ...changes } = dto as Record<string, unknown>;
  if (Object.values(changes).every((value) => value === undefined)) throw nothingToUpdate();
}

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD) */
export function vietnamToday(now = Date.now()): string {
  return new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
