/** DTO của /users - tài khoản nhân viên do chủ nhà quản lý (tài liệu 04) */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { UserStatus } from '../entities/user.entity';
import { STAFF_ROLES, StaffRole } from '../identity.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateUserDto {
  @ApiProperty({ example: '0912345678' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ maxLength: 150, example: 'Trần Thị B' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  fullName: string;

  @ApiProperty({ enum: STAFF_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STAFF_ROLES.length)
  @IsIn(STAFF_ROLES, { each: true })
  roles: StaffRole[];

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  buildingIds: string[];
}

export class UpdateUserDto {
  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional({ enum: STAFF_ROLES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STAFF_ROLES.length)
  @IsIn(STAFF_ROLES, { each: true })
  roles?: StaffRole[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  buildingIds?: string[];

  @ApiPropertyOptional({ enum: [UserStatus.ACTIVE, UserStatus.DISABLED] })
  @IsOptional()
  @IsIn([UserStatus.ACTIVE, UserStatus.DISABLED])
  status?: UserStatus.ACTIVE | UserStatus.DISABLED;

  @ApiPropertyOptional({ description: 'Optimistic lock (users.version)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class ListUsersQueryDto {
  @ApiPropertyOptional({ enum: RentalRole })
  @IsOptional()
  @IsEnum(RentalRole)
  role?: RentalRole;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

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
