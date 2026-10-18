import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { Contract } from './contract.entity';
import { ContractHolderTransfer } from './contract-holder-transfer.entity';

export enum DepositLedgerType {
  INITIAL_COLLECTION = 'INITIAL_COLLECTION',
  TOP_UP = 'TOP_UP',
  CHECKOUT_DEDUCTION = 'CHECKOUT_DEDUCTION',
  SURPLUS_REFUND = 'SURPLUS_REFUND',
  FORFEITURE = 'FORFEITURE',
  /** Số tiền 0: tiền cọc ở lại hợp đồng, từ nay thuộc về người đứng tên mới */
  HOLDER_TRANSFER_CARRY_OVER = 'HOLDER_TRANSFER_CARRY_OVER',
  /** Hoàn cho người đứng tên cũ */
  HOLDER_TRANSFER_REFUND = 'HOLDER_TRANSFER_REFUND',
  /** Thu từ người đứng tên mới */
  HOLDER_TRANSFER_COLLECTION = 'HOLDER_TRANSFER_COLLECTION',
}

/**
 * Sổ cái BẤT BIẾN của tiền cọc 1 tháng (tài liệu 03, mục 3.2 #13 + 3.2b). Mỗi dòng ghi rõ người nộp / nhận
 * (counterparty_tenant_id) vì tiền cọc có thể đổi chủ khi đổi người đứng tên.
 *  - entry_no 1, 2, 3… theo hợp đồng (duy nhất): sắp thứ tự các dòng ghi trong cùng transaction và chặn hai người ghi
 *    cùng tính ra một số dư.
 *  - Kernel: dấu của amount theo loại giao dịch, số dư không âm, trigger chặn UPDATE / DELETE / TRUNCATE.
 */
@Auditable({ resource: 'deposit_ledgers' })
@Entity('deposit_ledgers')
@Index('idx_deposit_ledgers_contract_created', ['contractId', 'createdAt'])
@Index('idx_deposit_ledgers_contract_entry_unique', ['contractId', 'entryNo'], { unique: true })
@Check('chk_deposit_ledgers_balance', `"balance_after" >= 0`)
@Check(
  'chk_deposit_ledgers_sign',
  `("transaction_type" IN ('INITIAL_COLLECTION', 'TOP_UP', 'HOLDER_TRANSFER_COLLECTION') AND "amount" > 0) OR ("transaction_type" IN ('CHECKOUT_DEDUCTION', 'SURPLUS_REFUND', 'FORFEITURE', 'HOLDER_TRANSFER_REFUND') AND "amount" < 0) OR ("transaction_type" = 'HOLDER_TRANSFER_CARRY_OVER' AND "amount" = 0)`,
)
@Check('chk_deposit_ledgers_transfer_ref', `("transaction_type"::text LIKE 'HOLDER_TRANSFER_%') = ("holder_transfer_id" IS NOT NULL)`)
export class DepositLedger extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_deposit_ledgers_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_deposit_ledgers_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'integer' })
  entryNo: number;

  @Column({ type: 'enum', enum: DepositLedgerType })
  transactionType: DepositLedgerType;

  /** + thu vào, - khấu trừ / hoàn trả */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  balanceAfter: string;

  @Column({ type: 'uuid' })
  counterpartyTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_deposit_ledgers_counterparty_same_building' },
    { name: 'counterparty_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_deposit_ledgers_counterparty_same_building' },
  ])
  counterparty?: Tenant;

  @Column({ type: 'uuid', nullable: true })
  holderTransferId?: string | null;

  @ManyToOne(() => ContractHolderTransfer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'holder_transfer_id', foreignKeyConstraintName: 'fk_deposit_ledgers_holder_transfer' })
  holderTransfer?: ContractHolderTransfer | null;

  @Column({ type: 'uuid' })
  recordedById: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes?: string | null;
}
