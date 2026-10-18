/**
 * Sổ cái tiền cọc 1 tháng (tài liệu 02, mục 5.1 / 5.4; tài liệu 03, mục 3.2 #13). Chỉ ghi thêm: số dư sau mỗi dòng =
 * số dư dòng trước + amount; entry_no tăng dần theo hợp đồng (duy nhất ở DB). Luôn được gọi bên trong transaction và
 * dưới khóa dòng của hợp đồng.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { toNumber } from '../../properties/properties.helpers';
import { HolderTransferDepositHandling } from '../domain/occupancy.enums';
import { Contract } from '../entities/contract.entity';
import { ContractHolderTransfer } from '../entities/contract-holder-transfer.entity';
import { DepositLedger, DepositLedgerType } from '../entities/deposit-ledger.entity';
import { findContract } from './contract-helpers';

export interface LedgerEntryView {
  entryNo: number;
  transactionType: DepositLedgerType;
  amount: number;
  balanceAfter: number;
  counterpartyTenantId: string;
  counterpartyName: string;
  holderTransferId: string | null;
  notes: string | null;
  createdAt: Date;
}

interface AppendInput {
  type: DepositLedgerType;
  /** VND nguyên, có dấu: + thu vào, - hoàn / khấu trừ */
  amount: number;
  counterpartyTenantId: string;
  recordedById: string;
  holderTransferId?: string | null;
  notes?: string | null;
}

@Injectable()
export class DepositEscrowService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly outbox: OutboxService,
  ) {}

  ledger(contractId: string): Promise<LedgerEntryView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      const buildingId = this.context.getBuildingId()!;
      await findContract(manager, buildingId, contractId);
      const rows = await manager
        .getRepository(DepositLedger)
        .createQueryBuilder('l')
        .innerJoin('l.counterparty', 't')
        .addSelect(['t.id', 't.fullName'])
        .where('l.contract_id = :contractId AND l.building_id = :buildingId', { contractId, buildingId })
        .orderBy('l.entry_no', 'ASC')
        .getMany();
      return rows.map((l) => ({
        entryNo: l.entryNo,
        transactionType: l.transactionType,
        amount: toNumber(l.amount)!,
        balanceAfter: toNumber(l.balanceAfter)!,
        counterpartyTenantId: l.counterpartyTenantId,
        counterpartyName: l.counterparty!.fullName,
        holderTransferId: l.holderTransferId ?? null,
        notes: l.notes ?? null,
        createdAt: l.createdAt,
      }));
    });
  }

  async balance(manager: EntityManager, contractId: string): Promise<number> {
    const last = await manager.getRepository(DepositLedger).findOne({ where: { contractId }, order: { entryNo: 'DESC' } });
    return last ? toNumber(last.balanceAfter)! : 0;
  }

  /** Thu cọc khi kích hoạt (không ghi dòng nào cho tiền cọc 0) */
  async recordInitialCollection(manager: EntityManager, contract: Contract, recordedById: string): Promise<void> {
    const amount = toNumber(contract.depositAmount)!;
    if (amount <= 0) return;
    await this.append(manager, contract, { type: DepositLedgerType.INITIAL_COLLECTION, amount, counterpartyTenantId: contract.primaryTenantId, recordedById });
  }

  async recordTopUp(manager: EntityManager, contract: Contract, amount: number, recordedById: string, notes: string): Promise<void> {
    if (amount <= 0) return;
    await this.append(manager, contract, { type: DepositLedgerType.TOP_UP, amount, counterpartyTenantId: contract.primaryTenantId, recordedById, notes });
  }

  /**
   * Đổi người đứng tên (tài liệu 02, mục 5.4.2): CARRY_OVER = một dòng 0 đồng ghi nhận tiền cọc nay thuộc người mới;
   * REFUND_AND_RECOLLECT = hoàn toàn bộ số dư cho người cũ rồi thu đủ một tháng cọc từ người mới.
   */
  async recordHolderTransfer(manager: EntityManager, contract: Contract, transfer: ContractHolderTransfer, recordedById: string): Promise<void> {
    const base = { recordedById, holderTransferId: transfer.id, notes: transfer.addendumNo };
    if (transfer.depositHandling === HolderTransferDepositHandling.CARRY_OVER) {
      await this.append(manager, contract, { ...base, type: DepositLedgerType.HOLDER_TRANSFER_CARRY_OVER, amount: 0, counterpartyTenantId: transfer.toTenantId });
      return;
    }
    const balance = await this.balance(manager, contract.id);
    if (balance > 0) {
      await this.append(manager, contract, { ...base, type: DepositLedgerType.HOLDER_TRANSFER_REFUND, amount: -balance, counterpartyTenantId: transfer.fromTenantId });
    }
    const deposit = toNumber(contract.depositAmount)!;
    if (deposit > 0) {
      await this.append(manager, contract, { ...base, type: DepositLedgerType.HOLDER_TRANSFER_COLLECTION, amount: deposit, counterpartyTenantId: transfer.toTenantId });
    }
  }

  private async append(manager: EntityManager, contract: Contract, input: AppendInput): Promise<DepositLedger> {
    const repo = manager.getRepository(DepositLedger);
    const last = await repo.findOne({ where: { contractId: contract.id }, order: { entryNo: 'DESC' } });
    const balanceAfter = (last ? toNumber(last.balanceAfter)! : 0) + input.amount;
    const entry = await repo.save(
      repo.create({
        contractId: contract.id,
        entryNo: (last?.entryNo ?? 0) + 1,
        transactionType: input.type,
        amount: input.amount.toFixed(2),
        balanceAfter: balanceAfter.toFixed(2),
        counterpartyTenantId: input.counterpartyTenantId,
        holderTransferId: input.holderTransferId ?? null,
        recordedById: input.recordedById,
        notes: input.notes ?? null,
      }),
    );
    const eventType = input.amount > 0 ? DOMAIN_EVENTS.DEPOSIT.COLLECTED : input.amount < 0 ? DOMAIN_EVENTS.DEPOSIT.REFUNDED : null;
    if (eventType) {
      await this.outbox.createEventInTransaction(manager, {
        aggregateType: 'CONTRACT',
        aggregateId: contract.id,
        eventType,
        payload: { contractId: contract.id, entryNo: entry.entryNo, transactionType: input.type, amount: input.amount, balanceAfter, counterpartyTenantId: input.counterpartyTenantId },
      });
    }
    return entry;
  }
}
