import { Check, Column, Entity, Index, OneToMany, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Room } from './room.entity';

/** Hạng phòng (STUDIO, 1BR_DELUXE, DUPLEX) và giá thuê chuẩn - tài liệu 03, mục 3.1 #2 */
@Auditable({ resource: 'room_types' })
@Entity('room_types')
@Index('idx_room_types_bld_code_unique', ['buildingId', 'code'], { unique: true })
// Đích của FK tổng hợp (building_id, room_type_id) từ rooms: phòng chỉ dùng được hạng phòng CÙNG tòa nhà
@Unique('uq_room_types_bld_id', ['buildingId', 'id'])
@Check('chk_room_types_values', `"base_monthly_rent" > 0 AND "standard_area_sqm" > 0 AND "default_max_occupants" BETWEEN 1 AND 20`)
export class RoomType extends BuildingScopedEntity {
  @Column({ type: 'varchar', length: 50 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** VND / tháng */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  baseMonthlyRent: string;

  @Column({ type: 'numeric', precision: 6, scale: 2 })
  standardAreaSqm: string;

  @Column({ type: 'smallint', default: 2 })
  defaultMaxOccupants: number;

  @OneToMany(() => Room, (room) => room.roomType)
  rooms?: Room[];
}
