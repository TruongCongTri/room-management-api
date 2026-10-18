/**
 * DTO của PropertiesModule (tài liệu 04, tag Properties & Room Directory).
 * Tiền VND là số nguyên (đồng); diện tích tối đa 2 chữ số thập phân. Mã / số phòng được chuẩn hóa chữ in hoa
 * để "p.302" và "P.302" không thành hai phòng.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { REGEX_PATTERNS } from '../../../common/constants/regex.constant';
import { ElectricityBillingMode } from '../entities/building.entity';
import { MANUAL_ROOM_STATUSES, ManualRoomStatus, RoomStatus } from '../entities/room.entity';

export const MAX_VND = 9_999_999_999; // numeric(12,2)
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const AREA = { maxDecimalPlaces: 2 } as const;
/** Slug công khai: 3-80 ký tự, chữ thường / số, gạch nối đơn (khớp CHECK chk_buildings_public_slug) */
export const PUBLIC_SLUG = /^(?=.{3,80}$)[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------- buildings

export class CreateBuildingDto {
  @ApiProperty({ example: 'BLD-HCM-Q7-01' })
  @Transform(upper)
  @Matches(/^[A-Z0-9][A-Z0-9-]{2,29}$/, { message: 'code must be 3-30 letters, digits or dashes' })
  code: string;

  @ApiProperty({ maxLength: 150 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ maxLength: 255 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  addressLine: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ward: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  district: string;

  @ApiPropertyOptional({ maxLength: 100, default: 'Thành phố Hồ Chí Minh' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ApiProperty({ example: '0312345678' })
  @Transform(trim)
  @Matches(REGEX_PATTERNS.VIETNAM_TAX_CODE, { message: 'landlordTaxCode must be 10 digits (or 10 digits + "-" + 3 digits)' })
  landlordTaxCode: string;

  @ApiProperty({ maxLength: 150 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  landlordFullName: string;

  @ApiPropertyOptional({ example: '0071000123456' })
  @IsOptional()
  @Matches(/^[0-9]{6,19}$/, { message: 'bankAccountNumber must be 6-19 digits' })
  bankAccountNumber?: string;

  @ApiPropertyOptional({ example: '970436', description: 'NAPAS bank BIN for VietQR' })
  @IsOptional()
  @Matches(/^[0-9]{6}$/, { message: 'bankBinCode must be 6 digits' })
  bankBinCode?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 80 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  totalRoomsCapacity?: number;

  @ApiPropertyOptional({ enum: ElectricityBillingMode, default: ElectricityBillingMode.EVN_TIERED_QUOTA })
  @IsOptional()
  @IsEnum(ElectricityBillingMode)
  electricityBillingMode?: ElectricityBillingMode;

  @ApiPropertyOptional({ minimum: 0, default: 25000 })
  @IsOptional()
  @IsNumber(AREA)
  @Min(0)
  @Max(99_999_999)
  defaultWaterRatePerM3?: number;
}

export class UpdateBuildingDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(150) name?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(255) addressLine?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) ward?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) district?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @Matches(REGEX_PATTERNS.VIETNAM_TAX_CODE, { message: 'landlordTaxCode must be 10 digits (or 10 digits + "-" + 3 digits)' })
  landlordTaxCode?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(150) landlordFullName?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes the VietQR account' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Matches(/^[0-9]{6,19}$/, { message: 'bankAccountNumber must be 6-19 digits' })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Matches(/^[0-9]{6}$/, { message: 'bankBinCode must be 6 digits' })
  bankBinCode?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 }) @IsOptional() @IsInt() @Min(1) @Max(500) totalRoomsCapacity?: number;
  @ApiPropertyOptional({ enum: ElectricityBillingMode }) @IsOptional() @IsEnum(ElectricityBillingMode) electricityBillingMode?: ElectricityBillingMode;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsNumber(AREA) @Min(0) @Max(99_999_999) defaultWaterRatePerM3?: number;
  @ApiPropertyOptional({ description: 'Show the building on the portfolio website (needs a publicSlug)' })
  @IsOptional()
  @IsBoolean()
  isPubliclyListed?: boolean;

  @ApiPropertyOptional({ nullable: true, example: 'sunrise-quan-7', description: 'lower-case words separated by dashes; null removes it' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(PUBLIC_SLUG, { message: 'publicSlug must be 3-80 lower-case letters or digits separated by single dashes' })
  publicSlug?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  publicDescription?: string | null;

  @ApiPropertyOptional({ description: 'Optimistic lock' }) @IsOptional() @IsInt() @Min(1) version?: number;
}

// ---------------------------------------------------------------------------- room types

export class CreateRoomTypeDto {
  @ApiProperty({ example: '1BR_DELUXE' })
  @Transform(upper)
  @Matches(/^[A-Z0-9_]{2,50}$/, { message: 'code must be 2-50 letters, digits or underscores' })
  code: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ minimum: 1, description: 'VND per month, whole number' })
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  baseMonthlyRent: number;

  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 9999.99 })
  @IsNumber(AREA)
  @Min(0.01)
  @Max(9999.99)
  standardAreaSqm: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  defaultMaxOccupants?: number;
}

export class UpdateRoomTypeDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ minimum: 1 }) @IsOptional() @IsInt() @Min(1) @Max(MAX_VND) baseMonthlyRent?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(AREA) @Min(0.01) @Max(9999.99) standardAreaSqm?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) defaultMaxOccupants?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

// ---------------------------------------------------------------------------- rooms

export class CreateRoomDto {
  @ApiProperty({ example: 'P.302' })
  @Transform(upper)
  @Matches(REGEX_PATTERNS.ROOM_NUMBER, { message: 'roomNumber must be 1-20 letters, digits, dots or dashes' })
  roomNumber: string;

  @ApiProperty({ minimum: 1, maximum: 30 })
  @IsInt()
  @Min(1)
  @Max(30)
  floor: number;

  @ApiProperty({ minimum: 0.01, maximum: 9999.99 })
  @IsNumber(AREA)
  @Min(0.01)
  @Max(9999.99)
  areaSqm: number;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  roomTypeId: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: "Defaults to the room type's defaultMaxOccupants" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxOccupants?: number;

  @ApiPropertyOptional({ minimum: 1, nullable: true, description: 'VND; null/absent = room type base rent' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  priceOverride?: number | null;
}

export class UpdateRoomDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(upper)
  @Matches(REGEX_PATTERNS.ROOM_NUMBER, { message: 'roomNumber must be 1-20 letters, digits, dots or dashes' })
  roomNumber?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(30) floor?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(AREA) @Min(0.01) @Max(9999.99) areaSqm?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() roomTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) maxOccupants?: number;

  @ApiPropertyOptional({ nullable: true, description: 'null = back to the room type base rent' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  priceOverride?: number | null;

  @ApiPropertyOptional({ enum: MANUAL_ROOM_STATUSES, description: 'OCCUPIED is set only by contracts' })
  @IsOptional()
  @IsIn(MANUAL_ROOM_STATUSES)
  status?: ManualRoomStatus;

  @ApiPropertyOptional({ description: 'false hides the room from the portfolio website' })
  @IsOptional()
  @IsBoolean()
  isPubliclyListed?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

export const ROOM_SORT_FIELDS = ['roomNumber', 'floor', 'effectivePrice'] as const;

export class QueryRoomsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ enum: RoomStatus })
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  floor?: number;

  @ApiPropertyOptional({ enum: ROOM_SORT_FIELDS, default: 'roomNumber' })
  @IsOptional()
  @IsIn(ROOM_SORT_FIELDS)
  sortBy: (typeof ROOM_SORT_FIELDS)[number] = 'roomNumber';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['ASC', 'DESC'])
  sortOrder: 'ASC' | 'DESC' = 'ASC';
}
