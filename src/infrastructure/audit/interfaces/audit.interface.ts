/**
 * Định nghĩa hành vi, cấu trúc diff và bộ lọc tra cứu theo phạm vi:
 *
 * */
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  RESTORE = 'RESTORE',
  EXECUTE = 'EXECUTE',
}

export interface FieldDiff {
  from: any;
  to: any;
}

export type EntityDiffSnapshot = Record<string, FieldDiff>;

/** Bộ lọc tra cứu audit (được ValidationPipe kiểm tra & ép kiểu từ query string) */
export class ScopedAuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  resourceId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  departmentId?: string;

  /** Chỉ có hiệu lực với phạm vi GLOBAL: thu hẹp về một tòa nhà được phép truy cập */
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
