/** Truy vấn tìm phòng của website giới thiệu (tài liệu 04, /public/buildings/{slug}/rooms) */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';
import { AssetCategory } from '../../assets/entities/asset.entity';
import { MAX_VND } from './properties.dto';

export enum PublicAvailability {
  AVAILABLE = 'AVAILABLE',
  /** Đã đặt / đang có người ở / bảo trì - lý do không bao giờ được công bố */
  UNAVAILABLE = 'UNAVAILABLE',
}

export const PUBLIC_ROOM_SORT_FIELDS = ['monthlyRent', 'floor', 'roomNumber', 'areaSqm'] as const;
export const PUBLIC_MAX_PAGE_SIZE = 50;

export class PublicRoomQueryDto {
  @ApiPropertyOptional({ example: 'STUDIO', description: 'Room type code' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9_]{2,50}$/, { message: 'roomType must be a room type code' })
  roomType?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  floor?: number;

  @ApiPropertyOptional({ enum: PublicAvailability })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(PublicAvailability)
  availability?: PublicAvailability;

  @ApiPropertyOptional({ minimum: 0, description: 'VND per month' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  minPrice?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_VND)
  maxPrice?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999.99)
  minAreaSqm?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Rooms that fit at least this many people' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  occupants?: number;

  @ApiPropertyOptional({ enum: PUBLIC_ROOM_SORT_FIELDS, default: 'roomNumber' })
  @IsOptional()
  @IsIn(PUBLIC_ROOM_SORT_FIELDS)
  sortBy: (typeof PUBLIC_ROOM_SORT_FIELDS)[number] = 'roomNumber';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['ASC', 'DESC'])
  sortOrder: 'ASC' | 'DESC' = 'ASC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: PUBLIC_MAX_PAGE_SIZE, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_MAX_PAGE_SIZE)
  limit: number = 20;
}

export class PublicAssetQueryDto {
  @ApiPropertyOptional({ enum: AssetCategory })
  @IsOptional()
  @IsEnum(AssetCategory)
  category?: AssetCategory;
}
