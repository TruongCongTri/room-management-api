/**
 * DTO của /tenants (tài liệu 04, tag Tenants & PDPL Privacy). DTO chỉ kiểm tra hình thức; quy tắc nghiệp vụ trên hồ sơ
 * hoàn chỉnh (CCCD khớp giới tính / năm sinh, ngày tháng, trẻ em & người giám hộ) nằm ở domain/tenant-profile.rules.ts.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IdDocumentType } from '../../contracts/domain/occupancy.enums';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const present = (_: unknown, value: unknown) => value !== null && value !== undefined;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = ['MALE', 'FEMALE'] as const;

export class CreateTenantDto {
  @ApiProperty({ maxLength: 150, example: 'Nguyễn Văn A' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  fullName: string;

  @ApiProperty({ enum: IdDocumentType, default: IdDocumentType.CCCD })
  @IsEnum(IdDocumentType)
  idDocumentType: IdDocumentType;

  @ApiProperty({ example: '079099001234', description: 'CCCD / personal ID (12 digits) or passport number' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  idCardNumber: string;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @ValidateIf(present)
  @Matches(DATE, { message: 'idCardIssueDate must be YYYY-MM-DD' })
  idCardIssueDate?: string | null;

  @ApiPropertyOptional({ maxLength: 150, nullable: true, example: 'Bộ Công an' })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  idCardIssuePlace?: string | null;

  @ApiPropertyOptional({ default: 'VN', example: 'VN' })
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'nationality must be an ISO 3166-1 alpha-2 code' })
  nationality?: string;

  @ApiProperty({ enum: GENDERS })
  @IsIn(GENDERS)
  gender: 'MALE' | 'FEMALE';

  @ApiProperty({ format: 'date', example: '1999-08-15' })
  @Matches(DATE, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth: string;

  @ApiPropertyOptional({ nullable: true, example: '0901234567', description: 'Required for adults' })
  @ValidateIf(present)
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf(present)
  @Transform(lower)
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  @ApiProperty({ maxLength: 255 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  hometownAddress: string;

  @ApiProperty({ maxLength: 255 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  permanentAddress: string;

  @ApiPropertyOptional({ nullable: true, example: '0071001234567' })
  @ValidateIf(present)
  @Matches(/^[0-9]{6,19}$/, { message: 'refundBankAccount must be 6-19 digits' })
  refundBankAccount?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  refundBankName?: string | null;

  @ApiProperty({ description: 'Mandatory consent (Law 91/2025/QH15)' })
  @IsBoolean()
  pdplConsentAccepted: boolean;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Required for a minor' })
  @ValidateIf(present)
  @IsUUID()
  consentGuardianTenantId?: string | null;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(150) fullName?: string;
  @ApiPropertyOptional({ enum: IdDocumentType }) @IsOptional() @IsEnum(IdDocumentType) idDocumentType?: IdDocumentType;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) idCardNumber?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf(present)
  @Matches(DATE, { message: 'idCardIssueDate must be YYYY-MM-DD' })
  idCardIssueDate?: string | null;

  @ApiPropertyOptional({ nullable: true }) @ValidateIf(present) @Transform(trim) @IsString() @MaxLength(150) idCardIssuePlace?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'nationality must be an ISO 3166-1 alpha-2 code' })
  nationality?: string;

  @ApiPropertyOptional({ enum: GENDERS }) @IsOptional() @IsIn(GENDERS) gender?: 'MALE' | 'FEMALE';
  @ApiPropertyOptional() @IsOptional() @Matches(DATE, { message: 'dateOfBirth must be YYYY-MM-DD' }) dateOfBirth?: string;
  @ApiPropertyOptional({ nullable: true }) @ValidateIf(present) @IsString() @MaxLength(20) phone?: string | null;
  @ApiPropertyOptional({ nullable: true }) @ValidateIf(present) @Transform(lower) @IsEmail() @MaxLength(150) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(255) hometownAddress?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(255) permanentAddress?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes the refund account' })
  @ValidateIf(present)
  @Matches(/^[0-9]{6,19}$/, { message: 'refundBankAccount must be 6-19 digits' })
  refundBankAccount?: string | null;

  @ApiPropertyOptional({ nullable: true }) @ValidateIf(present) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) refundBankName?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) @ValidateIf(present) @IsUUID() consentGuardianTenantId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

export class ListTenantsQueryDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 100, description: 'Name (without diacritics) or phone number' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'true = only children, false = only adults' })
  @IsOptional()
  // Đọc giá trị THÔ (obj[key]): enableImplicitConversion đã biến chuỗi "false" thành true trước khi @Transform chạy
  @Transform(({ obj, key }) => (obj[key] === 'true' ? true : obj[key] === 'false' ? false : obj[key]))
  @IsBoolean()
  minor?: boolean;

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
}

export class LookupTenantQueryDto {
  @ApiProperty({ example: '079099001234' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  idCardNumber: string;
}
