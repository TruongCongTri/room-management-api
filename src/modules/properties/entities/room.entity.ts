import { Check, Column, Entity, Index, IndexOptions, JoinColumn, ManyToOne, OneToMany, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Building } from './building.entity';
import { RoomType } from './room-type.entity';
import { RoomAsset } from '../../assets/entities/room-asset.entity';

export enum RoomStatus {
  AVAILABLE = 'AVAILABLE',
  RESERVED = 'RESERVED',
  /** Chỉ do hợp đồng đặt (kích hoạt) và gỡ (trả phòng) - không đổi bằng tay */
  OCCUPIED = 'OCCUPIED',
  MAINTENANCE = 'MAINTENANCE',
}

/** Trạng thái quản lý được đặt bằng tay qua PATCH /properties/rooms/{id} */
export const MANUAL_ROOM_STATUSES = [RoomStatus.AVAILABLE, RoomStatus.RESERVED, RoomStatus.MAINTENANCE] as const;
export type ManualRoomStatus = (typeof MANUAL_ROOM_STATUSES)[number];

/**
 * Từng phòng trong 80 phòng (tài liệu 03, mục 3.1 #3). Index phục vụ Mandate #1 (không quét tuần tự):
 * lọc theo trạng thái / hạng phòng / tầng luôn bắt đầu bằng building_id.
 */
@Auditable({ resource: 'rooms' })
@Entity('rooms')
@Index('idx_rooms_bld_status_type', ['buildingId', 'status', 'roomTypeId'])
@Index('idx_rooms_bld_floor_status', ['buildingId', 'floor', 'status'])
@Index('idx_rooms_bld_number_unique', ['buildingId', 'roomNumber'], { unique: true })
// Covering index một phần (INCLUDE) do migration tạo - TypeORM không biểu diễn được INCLUDE nên không đồng bộ
// (runtime của TypeORM 1.x vẫn đọc `synchronize`, chỉ khai báo kiểu đã bỏ trường này)
@Index('idx_rooms_available_covering', ['buildingId', 'roomTypeId', 'floor'], { synchronize: false } as IndexOptions)
@Unique('uq_rooms_bld_id', ['buildingId', 'id'])
@Check('chk_rooms_floor', `"floor" BETWEEN 1 AND 30`)
@Check('chk_rooms_area', `"area_sqm" > 0`)
@Check('chk_rooms_max_occupants', `"max_occupants" BETWEEN 1 AND 20`)
@Check('chk_rooms_price_override', `"price_override" IS NULL OR "price_override" > 0`)
export class Room extends BuildingScopedEntity {
  @ManyToOne(() => Building, (b) => b.rooms, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'building_id', foreignKeyConstraintName: 'fk_rooms_building' })
  building?: Building;

  @Column({ type: 'varchar', length: 20 })
  roomNumber: string; // "P.302"

  @Column({ type: 'smallint' })
  floor: number;

  @Column({ type: 'numeric', precision: 6, scale: 2 })
  areaSqm: string;

  @Column({ type: 'smallint', default: 2 })
  maxOccupants: number;

  @Column({ type: 'uuid' })
  roomTypeId: string;

  /** FK tổng hợp (building_id, room_type_id) → room_types(building_id, id): không thể dùng hạng phòng của tòa khác */
  @ManyToOne(() => RoomType, (rt) => rt.rooms, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_rooms_room_type_same_building' },
    { name: 'room_type_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_rooms_room_type_same_building' },
  ])
  roomType?: RoomType;

  /** Giá riêng của phòng; null = giá chuẩn của hạng phòng */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  priceOverride?: string | null;

  @Column({ type: 'enum', enum: RoomStatus, default: RoomStatus.AVAILABLE })
  status: RoomStatus;

  /** Hợp đồng đang hiệu lực - FK tới contracts được thêm ở migration Contracts (module 3) */
  @Column({ type: 'uuid', nullable: true })
  @Index('uq_rooms_current_contract', { unique: true, where: '"current_contract_id" IS NOT NULL' })
  currentContractId?: string | null;

  /** false = ẩn phòng khỏi website giới thiệu (/public/*) */
  @Column({ type: 'boolean', default: true })
  isPubliclyListed: boolean;

  @OneToMany(() => RoomAsset, (ra) => ra.room)
  roomAssets?: RoomAsset[];
}
