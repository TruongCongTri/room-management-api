/**
 * DTO của /contracts và /service-catalog (tài liệu 04, tag Contracts & 1-Month Deposit Escrow / Service Catalogue).
 * DTO chỉ kiểm tra hình thức; quy tắc trên hợp đồng hoàn chỉnh (thời hạn, người dự kiến, sức chứa, điều kiện người đứng tên,
 * chuyển trạng thái cư trú) nằm ở domain/ và service.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { MAX_VND } from '../../properties/dto/properties.dto';
import { HolderTransferDepositHandling, ResidencyStatus } from '../domain/occupancy.enums';
import { ContractStatus } from '../entities/contract.entity';
import { ServiceChargeUnit, VehicleType } from '../entities/service-catalog.entity';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const present = (_: unknown, value: unknown) => value !== null && value !== undefined;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateMessage = (field: string) => ({ message: `${field} must be YYYY-MM-DD` });

// ============================================================================ contracts

export class PlannedOccupantDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() tenantId: string;

  @ApiPropertyOptional({ format: 'date', nullable: true, description: 'Default = startDate' })
  @ValidateIf(present)
  @Matches(DATE, dateMessage('movedInAt'))
  movedInAt?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, nullable: true })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(20)
  successionOrder?: number | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'Con' })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  relationshipToHolder?: string | null;
}

class ContractTermsFields {
  @ApiPropertyOptional({ type: [PlannedOccupantDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(19)
  @ValidateNested({ each: true })
  @Type(() => PlannedOccupantDto)
  coOccupants?: PlannedOccupantDto[];

  @ApiPropertyOptional({ minimum: 1, description: "Default = the room's effective rent" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  monthlyRoomRent?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Default = one month of rent' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  depositAmount?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 28, default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  paymentDueDay?: number;

  @ApiPropertyOptional({ default: false, description: 'Must be true to activate' })
  @IsOptional()
  @IsBoolean()
  pcccCommitmentSigned?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Installed units of this room rented with the contract' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  rentedRoomAssetIds?: string[];
}

export class CreateContractDto extends ContractTermsFields {
  @ApiProperty({ format: 'uuid' }) @IsUUID() roomId: string;
  @ApiProperty({ format: 'uuid', description: 'Contract holder (người đứng tên)' }) @IsUUID() primaryTenantId: string;
  @ApiProperty({ format: 'date', example: '2026-10-01' }) @Matches(DATE, dateMessage('startDate')) startDate: string;
  @ApiProperty({ format: 'date', example: '2027-09-30' }) @Matches(DATE, dateMessage('endDate')) endDate: string;
}

export class UpdateDraftContractDto extends ContractTermsFields {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() primaryTenantId?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE, dateMessage('startDate')) startDate?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE, dateMessage('endDate')) endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

export class VersionedActionDto {
  @ApiPropertyOptional({ description: 'Optional optimistic lock' }) @IsOptional() @IsInt() @Min(1) version?: number;
}

export class RenewContractDto {
  @ApiProperty({ format: 'date', example: '2028-09-30' }) @Matches(DATE, dateMessage('newEndDate')) newEndDate: string;

  @ApiPropertyOptional({ nullable: true, description: 'From the current end date + 1' })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  newMonthlyRoomRent?: number | null;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() topUpDeposit?: boolean;
  @ApiPropertyOptional({ maxLength: 500, nullable: true }) @ValidateIf(present) @Transform(trim) @IsString() @MaxLength(500) notes?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

export class ListContractsQueryDto {
  @ApiPropertyOptional({ enum: ContractStatus }) @IsOptional() @IsEnum(ContractStatus) status?: ContractStatus;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() roomId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Holder or anyone who lived there' }) @IsOptional() @IsUUID() tenantId?: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 50, description: 'Part of the contract code or room number (HD-2026/007, P.302)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  q?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Active contracts ending on or before this date' })
  @IsOptional()
  @Matches(DATE, dateMessage('endingBefore'))
  endingBefore?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}

// ============================================================================ occupants

export class AddOccupantDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() tenantId: string;
  @ApiProperty({ format: 'date', example: '2026-11-01' }) @Matches(DATE, dateMessage('movedInAt')) movedInAt: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, nullable: true })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(20)
  successionOrder?: number | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'Bạn cùng phòng' })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  relationshipToHolder?: string | null;
}

export class MoveOutOccupantDto {
  @ApiProperty({ format: 'date', example: '2026-12-15' }) @Matches(DATE, dateMessage('movedOutAt')) movedOutAt: string;
  @ApiPropertyOptional({ maxLength: 500, nullable: true }) @ValidateIf(present) @Transform(trim) @IsString() @MaxLength(500) notes?: string | null;
}

const RESIDENCY_TARGETS = [ResidencyStatus.SUBMITTED, ResidencyStatus.REGISTERED, ResidencyStatus.DEREGISTERED] as const;

export class UpdateResidencyStatusDto {
  @ApiProperty({ enum: RESIDENCY_TARGETS }) @IsIn(RESIDENCY_TARGETS) residencyStatus: (typeof RESIDENCY_TARGETS)[number];

  @ApiPropertyOptional({ format: 'date', nullable: true, description: 'Required with REGISTERED (max 2 years)' })
  @ValidateIf(present)
  @Matches(DATE, dateMessage('temporaryStayValidUntil'))
  temporaryStayValidUntil?: string | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'VNeID-2026-000123' })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  referenceNo?: string | null;
}

export class TransferPrimaryHolderDto {
  @ApiProperty({ format: 'date', example: '2026-12-15' }) @Matches(DATE, dateMessage('effectiveDate')) effectiveDate: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @ValidateIf(present) @IsUUID() newPrimaryTenantId?: string | null;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() outgoingHolderStays?: boolean;

  @ApiPropertyOptional({ enum: HolderTransferDepositHandling, default: HolderTransferDepositHandling.CARRY_OVER })
  @IsOptional()
  @IsEnum(HolderTransferDepositHandling)
  depositHandling?: HolderTransferDepositHandling;

  @ApiPropertyOptional({ enum: ['OUTGOING_HOLDER', 'INCOMING_HOLDER'], default: 'OUTGOING_HOLDER' })
  @IsOptional()
  @IsIn(['OUTGOING_HOLDER', 'INCOMING_HOLDER'])
  outstandingBalanceAssumedBy?: 'OUTGOING_HOLDER' | 'INCOMING_HOLDER';

  @ApiPropertyOptional({ maxLength: 1000, nullable: true }) @ValidateIf(present) @Transform(trim) @IsString() @MaxLength(1000) notes?: string | null;
}

export class StatusFilterQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ALL'], default: 'ACTIVE' }) @IsOptional() @IsIn(['ACTIVE', 'ALL']) status: 'ACTIVE' | 'ALL' = 'ACTIVE';
}

// ============================================================================ vehicles & services

export class RegisterVehicleDto {
  @ApiProperty({ format: 'uuid', description: 'An active occupant of the contract' }) @IsUUID() ownerTenantId: string;
  @ApiProperty({ enum: VehicleType }) @IsEnum(VehicleType) vehicleType: VehicleType;

  @ApiPropertyOptional({ nullable: true, example: '59-G2 123.45', description: 'Required except for bicycles' })
  @ValidateIf(present)
  @IsString()
  @MaxLength(30)
  licensePlate?: string | null;

  @ApiProperty({ maxLength: 100, example: 'Honda Vision' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) brandModel: string;
  @ApiPropertyOptional({ maxLength: 50, nullable: true }) @ValidateIf(present) @Transform(upper) @IsString() @IsNotEmpty() @MaxLength(50) parkingCardCode?: string | null;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional({ nullable: true, example: '59-G2 123.45', description: 'Null only for bicycles' }) @ValidateIf(present) @IsString() @MaxLength(30) licensePlate?: string | null;
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) brandModel?: string;
  @ApiPropertyOptional({ maxLength: 50, nullable: true, description: 'null removes the card' })
  @ValidateIf((o) => o.parkingCardCode !== undefined && o.parkingCardCode !== null)
  @Transform(upper)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  parkingCardCode?: string | null;
}

export class DeactivateVehicleDto {
  @ApiPropertyOptional({ format: 'date', description: 'Default today' }) @IsOptional() @Matches(DATE, dateMessage('deactivatedAt')) deactivatedAt?: string;
}

export class VehiclesQueryDto extends StatusFilterQueryDto {}

export class AddContractServiceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() serviceCatalogId: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Per-room services only (default 1)' }) @IsOptional() @IsInt() @Min(1) @Max(20) quantity?: number;
  @ApiPropertyOptional({ minimum: 0, description: 'Default = catalogue price' }) @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) agreedUnitPrice?: number;
}

export class UpdateContractServiceDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 20 }) @IsOptional() @IsInt() @Min(1) @Max(20) quantity?: number;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) agreedUnitPrice?: number;
}

// ============================================================================ service catalogue

export const SERVICE_CODE = /^[A-Z][A-Z0-9_]{1,49}$/;

export class CreateServiceCatalogDto {
  @ApiProperty({ example: 'PARKING_MOTORBIKE' })
  @Transform(upper)
  @Matches(SERVICE_CODE, { message: 'code must be 2-50 upper-case letters, digits or _ and start with a letter' })
  code: string;

  @ApiProperty({ maxLength: 100, example: 'Gửi xe máy' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @ApiProperty({ enum: ServiceChargeUnit }) @IsEnum(ServiceChargeUnit) chargeUnit: ServiceChargeUnit;
  @ApiPropertyOptional({ enum: VehicleType, description: 'Required exactly for PER_VEHICLE_MONTH' }) @ValidateIf(present) @IsEnum(VehicleType) vehicleType?: VehicleType | null;
  @ApiProperty({ minimum: 0, example: 150000 }) @IsInt() @Min(0) @Max(MAX_VND) defaultUnitPrice: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isProratableOnCheckout?: boolean;
}

export class UpdateServiceCatalogDto {
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: ServiceChargeUnit }) @IsOptional() @IsEnum(ServiceChargeUnit) chargeUnit?: ServiceChargeUnit;
  @ApiPropertyOptional({ enum: VehicleType, nullable: true }) @ValidateIf((o) => o.vehicleType !== undefined && o.vehicleType !== null) @IsEnum(VehicleType) vehicleType?: VehicleType | null;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) defaultUnitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isProratableOnCheckout?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}

