import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { AssetConditionGrade, RoomAsset } from '../../assets/entities/room-asset.entity';
import { Contract } from './contract.entity';

/**
 * Thiết bị / nội thất cho thuê theo hợp đồng (tài liệu 03, mục 3.2 #9 + 3.2b): phí thỏa thuận chốt lúc lập bản nháp,
 * tình trạng bàn giao ghi lúc kích hoạt. Đơn vị đang được thuê (nháp / hiệu lực) không thể chuyển hoặc gỡ khỏi phòng.
 */
@Auditable({ resource: 'contract_assets' })
@Entity('contract_assets')
@Index('idx_contract_assets_contract_room_asset', ['contractId', 'roomAssetId'], { unique: true, where: '"deleted_at" IS NULL' })
@Index('idx_contract_assets_room_asset', ['roomAssetId'])
@Check('chk_contract_assets_fee', `"agreed_monthly_fee" >= 0`)
export class ContractAsset extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contract_assets_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_assets_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'uuid' })
  roomAssetId: string;

  @ManyToOne(() => RoomAsset, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contract_assets_unit_same_building' },
    { name: 'room_asset_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_assets_unit_same_building' },
  ])
  roomAsset?: RoomAsset;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  agreedMonthlyFee: string;

  @Column({ type: 'enum', enum: AssetConditionGrade })
  handoverCondition: AssetConditionGrade;

  @Column({ type: 'enum', enum: AssetConditionGrade, nullable: true })
  checkoutCondition?: AssetConditionGrade | null;
}
