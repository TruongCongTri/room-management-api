import { Check, Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Room } from '../../properties/entities/room.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

export enum ContractStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  /** Bản nháp bị hủy trước khi có hiệu lực */
  CANCELLED = 'CANCELLED',
  TERMINATED = 'TERMINATED',
  EXPIRED = 'EXPIRED',
}

export enum DepositStatus {
  PENDING_COLLECTION = 'PENDING_COLLECTION',
  HELD = 'HELD',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  FULLY_REFUNDED = 'FULLY_REFUNDED',
  FORFEITED = 'FORFEITED',
}

/** Người sẽ chuyển đến cùng người đứng tên khi kích hoạt (chỉ lưu trên bản nháp) */
export interface PlannedOccupant {
  tenantId: string;
  /** YYYY-MM-DD; null = ngày bắt đầu hợp đồng */
  movedInAt: string | null;
  successionOrder: number | null;
  relationshipToHolder: string | null;
}

/**
 * Hợp đồng thuê MỘT phòng (tài liệu 03, mục 3.2 #7 + 3.2b): tiền thuê theo phòng, 1 tháng tiền cọc, con trỏ tới
 * người đứng tên hiện tại. Bản nháp giữ danh sách người dự kiến ở cùng; kích hoạt mới tạo contract_occupants.
 *  - Kernel: mỗi phòng tối đa một hợp đồng ACTIVE và một DRAFT; phòng / người đứng tên cùng tòa nhà (FK tổng hợp);
 *    primary_tenant_id luôn bằng người đứng tên ACTIVE (trigger hoãn tới COMMIT, chỉ với hợp đồng ACTIVE).
 */
@Auditable({ resource: 'contracts' })
@Entity('contracts')
@Index('idx_contracts_bld_status_room', ['buildingId', 'status', 'roomId'])
@Index('idx_contracts_primary_tenant', ['primaryTenantId'])
@Index('idx_contracts_dates', ['buildingId', 'startDate', 'endDate'])
@Index('idx_contracts_bld_code_unique', ['buildingId', 'contractCode'], { unique: true })
@Index('idx_unique_active_contract_per_room', ['roomId'], { unique: true, where: `"status" = 'ACTIVE' AND "deleted_at" IS NULL` })
@Index('idx_unique_draft_contract_per_room', ['roomId'], { unique: true, where: `"status" = 'DRAFT' AND "deleted_at" IS NULL` })
@Unique('uq_contracts_bld_id', ['buildingId', 'id'])
@Check('chk_contracts_valid_dates', `"end_date" > "start_date"`)
@Check('chk_contracts_positive_rent', `"monthly_room_rent" > 0 AND "deposit_amount" >= 0`)
@Check('chk_contracts_quota_headcount', `"registered_evn_quota_headcount" >= 0`)
@Check('chk_contracts_payment_due_day', `"payment_due_day" BETWEEN 1 AND 28`)
@Check('chk_contracts_plan_only_draft', `"status" = 'DRAFT' OR "planned_co_occupants" IS NULL`)
@Check('chk_contracts_activated', `("activated_at" IS NULL) = ("status" IN ('DRAFT', 'CANCELLED'))`)
@Check('chk_contracts_cancelled', `("cancelled_at" IS NOT NULL) = ("status" = 'CANCELLED')`)
@Check('chk_contracts_active_deposit', `"status" <> 'ACTIVE' OR "deposit_status" <> 'PENDING_COLLECTION'`)
export class Contract extends BuildingScopedEntity {
  /** "HD-2026/007-P302" - duy nhất trong tòa nhà */
  @Column({ type: 'varchar', length: 50 })
  contractCode: string;

  @Column({ type: 'uuid' })
  roomId: string;

  @ManyToOne(() => Room, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contracts_room_same_building' },
    { name: 'room_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contracts_room_same_building' },
  ])
  room?: Room;

  /** Người đứng tên hiện tại - luôn bằng người ở PRIMARY_HOLDER đang ACTIVE (kiểm tra lúc COMMIT) */
  @Column({ type: 'uuid' })
  primaryTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contracts_holder_same_building' },
    { name: 'primary_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contracts_holder_same_building' },
  ])
  primaryTenant?: Tenant;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  /** Ngày trả phòng thực tế (module 5) */
  @Column({ type: 'date', nullable: true })
  actualCheckoutDate?: string | null;

  /** Theo phòng, không theo người; giá của kỳ hiện tại (lịch sử ở contract_renewals) */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monthlyRoomRent: string;

  /** Tiền đặt cọc tiêu chuẩn 1 tháng */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  depositAmount: string;

  @Column({ type: 'enum', enum: DepositStatus, default: DepositStatus.PENDING_COLLECTION })
  depositStatus: DepositStatus;

  @Column({ type: 'smallint', default: 5 })
  paymentDueDay: number;

  /** Tính lại (không cộng dồn) từ người ở có cư trú REGISTERED (TT 09/2023/TT-BCT) */
  @Column({ type: 'smallint', default: 0 })
  registeredEvnQuotaHeadcount: number;

  @Column({ type: 'boolean', default: false })
  pcccCommitmentSigned: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  signedContractPdfS3Key?: string | null;

  @Column({ type: 'enum', enum: ContractStatus, default: ContractStatus.DRAFT })
  status: ContractStatus;

  /** Chỉ bản nháp: người dự kiến ở cùng (xóa khi kích hoạt) */
  @Column({ type: 'jsonb', nullable: true })
  plannedCoOccupants?: PlannedOccupant[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;
}
