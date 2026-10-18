import { Check, Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Room } from '../../properties/entities/room.entity';
import { Asset } from './asset.entity';

export enum AssetConditionGrade {
  /** 95% - 100% */
  GRADE_A_NEW = 'GRADE_A_NEW',
  /** 80% - 94% */
  GRADE_B_GOOD = 'GRADE_B_GOOD',
  /** Dùng được, trầy xước bề ngoài */
  GRADE_C_FAIR = 'GRADE_C_FAIR',
  BROKEN = 'BROKEN',
}

/**
 * Đơn vị vật lý có số serial lắp trong một phòng (tài liệu 03, mục 3.1 #5).
 * FK tổng hợp với building_id: đơn vị không thể nằm ở phòng / thuộc danh mục của tòa nhà khác.
 * Xóa mềm khi thanh lý; serial chỉ duy nhất trong các đơn vị CÒN lắp đặt.
 */
@Auditable({ resource: 'room_assets' })
@Entity('room_assets')
@Index('idx_room_assets_room_id', ['roomId'])
@Index('idx_room_assets_bld_serial_unique', ['buildingId', 'serialNumber'], { unique: true, where: '"deleted_at" IS NULL' })
@Check('chk_room_assets_fee', `"custom_monthly_fee" >= 0`)
@Unique('uq_room_assets_bld_id', ['buildingId', 'id'])
export class RoomAsset extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  roomId: string;

  @ManyToOne(() => Room, (r) => r.roomAssets, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_room_assets_room_same_building' },
    { name: 'room_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_room_assets_room_same_building' },
  ])
  room?: Room;

  @Column({ type: 'uuid' })
  assetId: string;

  @ManyToOne(() => Asset, (a) => a.roomInstallations, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_room_assets_asset_same_building' },
    { name: 'asset_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_room_assets_asset_same_building' },
  ])
  asset?: Asset;

  /** Serial nhà sản xuất / tem QR */
  @Column({ type: 'varchar', length: 100 })
  serialNumber: string;

  @Column({ type: 'enum', enum: AssetConditionGrade, default: AssetConditionGrade.GRADE_A_NEW })
  conditionGrade: AssetConditionGrade;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  customMonthlyFee: string;

  @Column({ type: 'date' })
  installedDate: string;
}
