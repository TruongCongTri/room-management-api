import { Check, Column, Entity, Index, OneToMany, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { RoomAsset } from './room-asset.entity';

export enum AssetCategory {
  /** Máy lạnh, tủ lạnh, máy giặt, lò vi sóng */
  APPLIANCE = 'APPLIANCE',
  /** Giường, nệm, tủ quần áo, sofa, bàn làm việc */
  FURNITURE = 'FURNITURE',
}

/** Danh mục thiết bị / nội thất cho thuê (tài liệu 03, mục 3.1 #4) */
@Auditable({ resource: 'assets' })
@Entity('assets')
@Index('idx_assets_bld_code_unique', ['buildingId', 'code'], { unique: true })
@Unique('uq_assets_bld_id', ['buildingId', 'id'])
@Check('chk_assets_values', `"standard_monthly_rental_fee" >= 0 AND "replacement_value" >= 0`)
export class Asset extends BuildingScopedEntity {
  @Column({ type: 'varchar', length: 50 })
  code: string; // "AC_DAIKIN_1_5HP"

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'enum', enum: AssetCategory })
  category: AssetCategory;

  /** Phí thuê mặc định / tháng (VND) cho đơn vị lắp mới */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  standardMonthlyRentalFee: string;

  /** Giá trị thay thế - căn cứ bồi thường hư hỏng khi trả phòng */
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  replacementValue: string;

  @OneToMany(() => RoomAsset, (ra) => ra.asset)
  roomInstallations?: RoomAsset[];
}
