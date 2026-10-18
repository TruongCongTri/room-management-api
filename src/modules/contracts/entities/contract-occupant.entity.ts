import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { OccupancyStatus, OccupantRole, ResidenceChannel, ResidencyStatus } from '../domain/occupancy.enums';
import { Contract } from './contract.entity';

/**
 * Ai ở trong phòng (tài liệu 03, mục 3.2 #8): một dòng cho mỗi người mỗi lần ở. Chuyển đi giữ dòng (MOVED_OUT) cho lịch sử
 * cư trú; chuyển về lại tạo dòng mới.
 *  - Kernel: đúng một người đứng tên ACTIVE / hợp đồng; một người chỉ ở một phòng tại một thời điểm; người đã chuyển đi
 *    không thể là người đứng tên; hợp đồng / hồ sơ cùng tòa nhà (FK tổng hợp).
 */
@Auditable({ resource: 'contract_occupants' })
@Entity('contract_occupants')
@Index('idx_occupants_contract_status', ['contractId', 'status'])
@Index('idx_occupants_bld_residency', ['buildingId', 'residencyStatus'])
@Index('idx_occupants_one_active_holder', ['contractId'], {
  unique: true,
  where: `"role" = 'PRIMARY_HOLDER' AND "status" = 'ACTIVE' AND "deleted_at" IS NULL`,
})
@Index('idx_occupants_tenant_one_active', ['tenantId'], { unique: true, where: `"status" = 'ACTIVE' AND "deleted_at" IS NULL` })
@Index('idx_occupants_residence_pending', ['buildingId', 'residencyStatus'], {
  where: `"residency_status" IN ('PENDING_DECLARATION', 'DEREGISTRATION_PENDING')`,
})
@Check('chk_occupants_move_out_consistent', `("status" = 'MOVED_OUT') = ("moved_out_at" IS NOT NULL)`)
@Check('chk_occupants_move_dates', `"moved_out_at" IS NULL OR "moved_out_at" >= "moved_in_at"`)
@Check('chk_occupants_holder_active', `"role" <> 'PRIMARY_HOLDER' OR "status" = 'ACTIVE'`)
@Check('chk_occupants_succession_order', `"succession_order" IS NULL OR "succession_order" >= 1`)
export class ContractOccupant extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_occupants_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_occupants_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_occupants_tenant_same_building' },
    { name: 'tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_occupants_tenant_same_building' },
  ])
  tenant?: Tenant;

  @Column({ type: 'enum', enum: OccupantRole, default: OccupantRole.CO_OCCUPANT })
  role: OccupantRole;

  @Column({ type: 'enum', enum: OccupancyStatus, default: OccupancyStatus.ACTIVE })
  status: OccupancyStatus;

  @Column({ type: 'date' })
  movedInAt: string;

  @Column({ type: 'date', nullable: true })
  movedOutAt?: string | null;

  /** Thứ tự kế nhiệm do các bên thỏa thuận (1 = ưu tiên nhất) */
  @Column({ type: 'smallint', nullable: true })
  successionOrder?: number | null;

  /** CT01 "Quan hệ với chủ hộ": "Bạn cùng phòng", "Vợ", "Con" */
  @Column({ type: 'varchar', length: 50, nullable: true })
  relationshipToHolder?: string | null;

  @Column({ type: 'enum', enum: ResidenceChannel, default: ResidenceChannel.CT01 })
  residenceChannel: ResidenceChannel;

  @Column({ type: 'enum', enum: ResidencyStatus, default: ResidencyStatus.PENDING_DECLARATION })
  residencyStatus: ResidencyStatus;

  @Column({ type: 'timestamptz', nullable: true })
  residenceSubmittedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  residenceRegisteredAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  residenceDeregisteredAt?: Date | null;

  /** Thời hạn tạm trú (Luật Cư trú 2020, Điều 27: tối đa 2 năm, gia hạn được) */
  @Column({ type: 'date', nullable: true })
  temporaryStayValidUntil?: string | null;

  /** Mã hồ sơ VNeID / công an của bước khai báo gần nhất */
  @Column({ type: 'varchar', length: 50, nullable: true })
  residenceReferenceNo?: string | null;

  /** CT01 gần nhất của người này (module 6) */
  @Column({ type: 'varchar', length: 255, nullable: true })
  ct01DocumentKey?: string | null;
}
