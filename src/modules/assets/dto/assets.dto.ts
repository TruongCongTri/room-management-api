/** DTO của AssetsModule (tài liệu 04, tag Assets & Furniture Catalog). Phí VND là số nguyên. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AssetCategory } from '../entities/asset.entity';
import { AssetConditionGrade } from '../entities/room-asset.entity';
import { MAX_VND } from '../../properties/dto/properties.dto';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateAssetDto {
  @ApiProperty({ example: 'AC_DAIKIN_1_5HP' })
  @Transform(upper)
  @Matches(/^[A-Z0-9_]{2,50}$/, { message: 'code must be 2-50 letters, digits or underscores' })
  code: string;

  @ApiProperty({ maxLength: 150, example: 'Máy lạnh Daikin Inverter 1.5 HP' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ enum: AssetCategory })
  @IsEnum(AssetCategory)
  category: AssetCategory;

  @ApiProperty({ minimum: 0, example: 300000 })
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  standardMonthlyRentalFee: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  replacementValue?: number;
}

export class UpdateAssetDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(150) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) standardMonthlyRentalFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) replacementValue?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

export class QueryAssetsDto {
  @ApiPropertyOptional({ enum: AssetCategory })
  @IsOptional()
  @IsEnum(AssetCategory)
  category?: AssetCategory;
}

export class QueryRoomAssetsDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() roomId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() assetId?: string;

  @ApiPropertyOptional({ description: 'Serial number or part of it (QR / label scan)', example: 'DK-2026' })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  serialNumber?: string;

  @ApiPropertyOptional({ enum: AssetConditionGrade }) @IsOptional() @IsEnum(AssetConditionGrade) conditionGrade?: AssetConditionGrade;
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}

export class AssignRoomAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  roomId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  assetId: string;

  @ApiProperty({ example: 'DK-2026-992019' })
  @Transform(upper)
  @Matches(/^[A-Z0-9][A-Z0-9._/-]{2,99}$/, { message: 'serialNumber must be 3-100 letters, digits or . _ / -' })
  serialNumber: string;

  @ApiPropertyOptional({ enum: AssetConditionGrade, default: AssetConditionGrade.GRADE_A_NEW })
  @IsOptional()
  @IsEnum(AssetConditionGrade)
  conditionGrade?: AssetConditionGrade;

  @ApiPropertyOptional({ minimum: 0, description: "Defaults to the catalogue item's standardMonthlyRentalFee" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  customMonthlyFee?: number;

  @ApiPropertyOptional({ format: 'date', description: 'Defaults to today (Vietnam time); not in the future' })
  @IsOptional()
  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'installedDate must be YYYY-MM-DD' })
  installedDate?: string;
}

export class UpdateRoomAssetDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Move the unit to another room of the building' })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ enum: AssetConditionGrade })
  @IsOptional()
  @IsEnum(AssetConditionGrade)
  conditionGrade?: AssetConditionGrade;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  customMonthlyFee?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}
