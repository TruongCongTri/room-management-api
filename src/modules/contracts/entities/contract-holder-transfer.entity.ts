import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { User } from '../../identity/entities/user.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { HolderTransferDepositHandling } from '../domain/occupancy.enums';
import { Contract } from './contract.entity';

export enum HolderTransferReason {
  HOLDER_MOVED_OUT = 'HOLDER_MOVED_OUT',
  MUTUAL_AGREEMENT = 'MUTUAL_AGREEMENT',
}

export enum HolderSelection {
  DESIGNATED = 'DESIGNATED',
  AUTO_SUCCESSION = 'AUTO_SUCCESSION',
}

export type OutstandingBalanceAssumedBy = 'OUTGOING_HOLDER' | 'INCOMING_HOLDER';

/**
 * Lịch sử người đứng tên (tài liệu 03, mục 3.2 #8b). Đổi bên thuê = chuyển giao nghĩa vụ, cần bên cho thuê đồng ý
 * (BLDS 2015, Điều 370) → mỗi lần đổi có một phụ lục (số phụ lục duy nhất trong tòa nhà).
 */
@Auditable({ resource: 'contract_holder_transfers' })
@Entity('contract_holder_transfers')
@Index('idx_holder_transfers_contract_date', ['contractId', 'effectiveDate'])
@Index('idx_holder_transfers_bld_addendum_unique', ['buildingId', 'addendumNo'], { unique: true })
@Check('chk_holder_transfer_distinct', `"from_tenant_id" <> "to_tenant_id"`)
@Check('chk_holder_transfer_outstanding', `"outstanding_balance" >= 0`)
@Check('chk_holder_transfer_assumed_by', `"outstanding_balance_assumed_by" IN ('OUTGOING_HOLDER', 'INCOMING_HOLDER')`)
export class ContractHolderTransfer extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_holder_transfers_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_holder_transfers_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'uuid' })
  fromTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_holder_transfers_from_same_building' },
    { name: 'from_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_holder_transfers_from_same_building' },
  ])
  fromTenant?: Tenant;

  @Column({ type: 'uuid' })
  toTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_holder_transfers_to_same_building' },
    { name: 'to_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_holder_transfers_to_same_building' },
  ])
  toTenant?: Tenant;

  @Column({ type: 'date' })
  effectiveDate: string;

  @Column({ type: 'enum', enum: HolderTransferReason })
  reason: HolderTransferReason;

  @Column({ type: 'enum', enum: HolderSelection })
  selection: HolderSelection;

  @Column({ type: 'enum', enum: HolderTransferDepositHandling })
  depositHandling: HolderTransferDepositHandling;

  /** Hóa đơn chưa thanh toán tại ngày chuyển (module 5) và ai tiếp nhận - ghi trong phụ lục */
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  outstandingBalance: string;

  @Column({ type: 'varchar', length: 20 })
  outstandingBalanceAssumedBy: OutstandingBalanceAssumedBy;

  /** "PL-2026/007-P302-01" */
  @Column({ type: 'varchar', length: 50 })
  addendumNo: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addendumPdfKey?: string | null;

  @Column({ type: 'uuid' })
  approvedById: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'approved_by_id', foreignKeyConstraintName: 'fk_holder_transfers_approved_by' })
  approvedBy?: User;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;
}
