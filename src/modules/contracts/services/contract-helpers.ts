/**
 * Truy vấn & lỗi dùng chung của ContractsModule. Mọi hàm nhận EntityManager của transaction RLS hiện tại và lọc
 * building_id tường minh (lớp cô lập thứ nhất; RLS là lớp thứ hai).
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { isMinorOn, maskIdNumber } from '../../tenants/domain/tenant-profile.rules';
import { OccupancyStatus } from '../domain/occupancy.enums';
import { countEvnQuotaHeadcount, OccupantSnapshot } from '../domain/occupancy.policy';
import { formatAddendumNo, TermIssue } from '../domain/contract.rules';
import { Contract, ContractStatus } from '../entities/contract.entity';
import { ContractOccupant } from '../entities/contract-occupant.entity';
import { ContractHolderTransfer } from '../entities/contract-holder-transfer.entity';
import { ContractRenewal } from '../entities/contract-renewal.entity';

export const contractNotFound = () =>
  new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Contract not found in this building.' });

export const notDraft = (status: ContractStatus) =>
  new ConflictException({
    errorCode: SystemErrorCode.BIZ_CONTRACT_NOT_DRAFT,
    message: `The contract is ${status}; only a draft can be changed this way.`,
    details: [{ field: 'status', issue: 'NOT_DRAFT', status }],
  });

export const notActive = (status: ContractStatus) =>
  new ConflictException({
    errorCode: SystemErrorCode.BIZ_CONTRACT_NOT_ACTIVE,
    message: `The contract is ${status}; this needs an active contract.`,
    details: [{ field: 'status', issue: 'NOT_ACTIVE', status }],
  });

export const invalid = (issues: TermIssue[]) =>
  new BadRequestException({ errorCode: SystemErrorCode.REQ_VALIDATION_ERROR, message: 'Validation failed for the submitted payload.', details: issues });

/** Hợp đồng của tòa nhà hiệu lực, khóa dòng (FOR UPDATE) để tuần tự hóa mọi thay đổi trên cùng hợp đồng */
export async function lockContract(manager: EntityManager, buildingId: string, id: string): Promise<Contract> {
  const contract = await manager.getRepository(Contract).findOne({ where: { id, buildingId }, lock: { mode: 'pessimistic_write' } });
  if (!contract) throw contractNotFound();
  return contract;
}

export async function findContract(manager: EntityManager, buildingId: string, id: string): Promise<Contract> {
  const contract = await manager.getRepository(Contract).findOne({ where: { id, buildingId } });
  if (!contract) throw contractNotFound();
  return contract;
}

/** Ảnh chụp người ở (kể cả đã chuyển đi) cho chính sách thuần occupancy.policy */
export async function loadSnapshots(manager: EntityManager, contractId: string): Promise<OccupantSnapshot[]> {
  const rows = await manager
    .getRepository(ContractOccupant)
    .createQueryBuilder('co')
    .innerJoin('co.tenant', 't')
    .select([
      'co.tenant_id AS "tenantId"',
      'co.role AS "role"',
      'co.status AS "status"',
      'co.residency_status AS "residencyStatus"',
      `to_char(co.moved_in_at, 'YYYY-MM-DD') AS "movedInAt"`,
      'co.succession_order AS "successionOrder"',
      `to_char(t.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth"`,
      't.id_document_type AS "idDocumentType"',
      't.id_card_hash IS NOT NULL AS "hasIdDocument"',
      't.pdpl_consent_accepted_at IS NOT NULL AS "hasPdplConsent"',
    ])
    .where('co.contract_id = :contractId', { contractId })
    .getRawMany();
  return rows.map((r) => ({ ...r, successionOrder: r.successionOrder === null ? null : Number(r.successionOrder) }));
}

/** Định mức điện EVN: TÍNH LẠI từ người đang ở có cư trú REGISTERED (không bao giờ cộng dồn) */
export async function recomputeEvnHeadcount(manager: EntityManager, contractId: string): Promise<number> {
  const headcount = countEvnQuotaHeadcount(await loadSnapshots(manager, contractId));
  const repo = manager.getRepository(Contract);
  const contract = await repo.findOneOrFail({ where: { id: contractId } });
  if (contract.registeredEvnQuotaHeadcount !== headcount) {
    contract.registeredEvnQuotaHeadcount = headcount; // save(): audit ghi 0 → 1 trên đúng hợp đồng
    await repo.save(contract);
  }
  return headcount;
}

export async function activeOccupantCount(manager: EntityManager, contractId: string): Promise<number> {
  return manager.getRepository(ContractOccupant).count({ where: { contractId, status: OccupancyStatus.ACTIVE } });
}

/** Số phụ lục kế tiếp - đổi người đứng tên và gia hạn dùng chung bộ đếm (gọi dưới khóa hợp đồng) */
export async function nextAddendumNo(manager: EntityManager, contract: Contract): Promise<string> {
  const [transfers, renewals] = await Promise.all([
    manager.getRepository(ContractHolderTransfer).count({ where: { contractId: contract.id }, withDeleted: true }),
    manager.getRepository(ContractRenewal).count({ where: { contractId: contract.id }, withDeleted: true }),
  ]);
  return formatAddendumNo(contract.contractCode, transfers + renewals + 1);
}

export interface PersonRef {
  tenantId: string;
  fullName: string;
  idCardMasked: string;
  phone: string | null;
  isMinor: boolean;
}

export function personRef(t: Tenant, today: string): PersonRef {
  return {
    tenantId: t.id,
    fullName: t.fullName,
    idCardMasked: maskIdNumber(t.idCardLast4),
    phone: t.phone ?? null,
    isMinor: isMinorOn(t.dateOfBirth, today),
  };
}
