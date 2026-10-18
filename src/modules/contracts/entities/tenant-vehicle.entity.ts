import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { Contract } from './contract.entity';
import { VehicleType } from './service-catalog.entity';

/**
 * Xe của người ở (tài liệu 03, mục 3.2 #12 + 3.2b): mỗi xe thuộc MỘT người ở; người đó chuyển đi → xe ngừng hoạt động
 * và gói gửi xe giảm trong cùng transaction. Biển số / thẻ xe duy nhất trong các xe đang hoạt động của tòa nhà.
 */
@Auditable({ resource: 'tenant_vehicles' })
@Entity('tenant_vehicles')
@Index('idx_tenant_vehicles_contract', ['contractId'])
@Index('idx_vehicles_bld_active_plate_unique', ['buildingId', 'licensePlate'], {
  unique: true,
  where: '"is_active" AND "license_plate" IS NOT NULL AND "deleted_at" IS NULL',
})
@Index('idx_vehicles_bld_active_card_unique', ['buildingId', 'parkingCardCode'], {
  unique: true,
  where: '"is_active" AND "parking_card_code" IS NOT NULL AND "deleted_at" IS NULL',
})
@Check('chk_vehicles_active', `"is_active" = ("deactivated_at" IS NULL)`)
@Check('chk_vehicles_plate', `"vehicle_type" = 'BICYCLE' OR "license_plate" IS NOT NULL`)
export class TenantVehicle extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_vehicles_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_vehicles_contract_same_building' },
  ])
  contract?: Contract;

  /** Người ở sử dụng xe */
  @Column({ type: 'uuid' })
  ownerTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_vehicles_owner_same_building' },
    { name: 'owner_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_vehicles_owner_same_building' },
  ])
  owner?: Tenant;

  @Column({ type: 'enum', enum: VehicleType })
  vehicleType: VehicleType;

  /** "59-G2 123.45" (chuẩn hóa: chữ hoa, một khoảng trắng); xe đạp không có biển số */
  @Column({ type: 'varchar', length: 30, nullable: true })
  licensePlate?: string | null;

  @Column({ type: 'varchar', length: 100 })
  brandModel: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  parkingCardCode?: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'date', nullable: true })
  deactivatedAt?: string | null;
}
