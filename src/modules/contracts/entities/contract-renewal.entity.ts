import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { User } from '../../identity/entities/user.entity';
import { Contract } from './contract.entity';

/**
 * Gia hạn hợp đồng (tài liệu 03, mục 3.2b - quyết định D8): mỗi lần gia hạn một phụ lục (chung bộ đếm với đổi người
 * đứng tên). Giá mới áp dụng từ effective_date = ngày kết thúc cũ + 1 → hóa đơn (module 5) tính từng kỳ theo giá đang
 * hiệu lực.
 */
@Auditable({ resource: 'contract_renewals' })
@Entity('contract_renewals')
@Index('idx_renewals_contract_effective', ['contractId', 'effectiveDate'])
@Index('idx_renewals_bld_addendum_unique', ['buildingId', 'addendumNo'], { unique: true })
@Check(
  'chk_renewals_values',
  `"new_end_date" > "previous_end_date" AND "new_monthly_rent" > 0 AND "previous_monthly_rent" > 0 AND "deposit_top_up_amount" >= 0 AND "effective_date" = "previous_end_date" + 1`,
)
export class ContractRenewal extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_renewals_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_renewals_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'date' })
  previousEndDate: string;

  @Column({ type: 'date' })
  newEndDate: string;

  @Column({ type: 'date' })
  effectiveDate: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  previousMonthlyRent: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  newMonthlyRent: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  depositTopUpAmount: string;

  @Column({ type: 'varchar', length: 50 })
  addendumNo: string;

  @Column({ type: 'uuid' })
  approvedById: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'approved_by_id', foreignKeyConstraintName: 'fk_renewals_approved_by' })
  approvedBy?: User;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;
}
