/**
 * Phòng nhiều người ở & người đứng tên (tài liệu 02, mục 5.4): người ở chuyển đến / đi, trạng thái cư trú từng người,
 * chuyển quyền đứng tên. Mọi thay đổi người ở chạy dưới LOCK_KEYS.contractOccupancy (= khóa trả phòng) + khóa dòng
 * hợp đồng; quy tắc thuần ở domain/occupancy.policy.ts và domain/contract.rules.ts.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { OccupancySelfScopeService } from '../../../core/access-control/occupancy-self-scope';
import { PermissionCacheService } from '../../../core/access-control/permission-cache.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { DistributedLockService } from '../../../infrastructure/lock/services/distributed-lock.service';
import { LOCK_KEYS } from '../../../infrastructure/lock/constants/lock-keys.constant';
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { Room } from '../../properties/entities/room.entity';
import { ROOMS_TAG } from '../../properties/services/room-types.service';
import { isUniqueViolation, notFound, toNumber, vietnamToday } from '../../properties/properties.helpers';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { isMinorOn, maskIdNumber } from '../../tenants/domain/tenant-profile.rules';
import { HolderTransferDepositHandling, IdDocumentType, OccupancyStatus, OccupantRole, ResidenceChannel, ResidencyStatus, residenceChannelFor } from '../domain/occupancy.enums';
import { assertCanAddOccupant, selectNextPrimaryHolder } from '../domain/occupancy.policy';
import { assertResidencyTransition, checkTemporaryStayValidUntil, isCalendarDate, residencyOnMoveOut } from '../domain/contract.rules';
import { Contract, ContractStatus } from '../entities/contract.entity';
import { ContractOccupant } from '../entities/contract-occupant.entity';
import { ContractHolderTransfer, HolderSelection, HolderTransferReason } from '../entities/contract-holder-transfer.entity';
import { AddOccupantDto, MoveOutOccupantDto, TransferPrimaryHolderDto, UpdateResidencyStatusDto } from '../dto/contracts.dto';
import { DepositEscrowService } from './deposit-escrow.service';
import { ContractExtrasService } from './contract-extras.service';
import { OccupantAccountsService } from './occupant-accounts.service';
import { findContract, invalid, loadSnapshots, lockContract, nextAddendumNo, notActive, recomputeEvnHeadcount } from './contract-helpers';

const ONE_ROOM_INDEX = 'idx_occupants_tenant_one_active';

export interface OccupantView {
  occupantId: string;
  tenantId: string;
  fullName: string;
  idDocumentType: IdDocumentType;
  idCardMasked: string;
  role: OccupantRole;
  status: OccupancyStatus;
  movedInAt: string;
  movedOutAt: string | null;
  successionOrder: number | null;
  relationshipToHolder: string | null;
  isMinor: boolean;
  residenceChannel: ResidenceChannel;
  residencyStatus: ResidencyStatus;
  temporaryStayValidUntil: string | null;
  residenceReferenceNo: string | null;
}

export interface HolderTransferView {
  transferId: string;
  contractId: string;
  fromTenantId: string;
  fromTenantName: string;
  toTenantId: string;
  toTenantName: string;
  newHolderIdCardMasked: string;
  effectiveDate: string;
  reason: HolderTransferReason;
  selection: HolderSelection;
  depositHandling: HolderTransferDepositHandling;
  outstandingBalance: number;
  outstandingBalanceAssumedBy: string;
  addendumNo: string;
  addendumDownloadUrl: string | null;
  createdAt: Date;
}

@Injectable()
export class ContractOccupancyService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly locks: DistributedLockService,
    private readonly outbox: OutboxService,
    private readonly cache: RedisCacheService,
    private readonly selfScope: OccupancySelfScopeService,
    private readonly permissionCache: PermissionCacheService,
    private readonly deposits: DepositEscrowService,
    private readonly extras: ContractExtrasService,
    private readonly accounts: OccupantAccountsService,
  ) {}

  /** Người đứng tên trước, người đang ở trước người đã chuyển đi, rồi theo ngày chuyển đến */
  list(contractId: string, status: 'ACTIVE' | 'ALL'): Promise<OccupantView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      await findContract(manager, this.buildingId(), contractId);
      const qb = this.occupantQuery(manager).where('co.contract_id = :contractId AND co.building_id = :b', { contractId, b: this.buildingId() });
      if (status === 'ACTIVE') qb.andWhere(`co.status = 'ACTIVE'`);
      const rows = await qb
        .orderBy(`CASE WHEN co.role = 'PRIMARY_HOLDER' THEN 0 ELSE 1 END`, 'ASC')
        .addOrderBy(`CASE WHEN co.status = 'ACTIVE' THEN 0 ELSE 1 END`, 'ASC')
        .addOrderBy('co.moved_in_at', 'ASC')
        .addOrderBy('co.id', 'ASC')
        .getMany();
      const today = vietnamToday();
      return rows.map((o) => this.view(o, today));
    });
  }

  async add(contractId: string, dto: AddOccupantDto): Promise<OccupantView> {
    const today = vietnamToday();
    let linked: string[] = [];
    let view: OccupantView;
    try {
      view = await this.withOccupancyLock(contractId, () =>
        this.rls.runInTenantContext(async (manager) => {
          const contract = await this.lockActive(manager, contractId);
          this.assertMoveDate('movedInAt', dto.movedInAt, contract.startDate, today);
          const room = await manager.getRepository(Room).findOneOrFail({ where: { id: contract.roomId, buildingId: this.buildingId() } });
          const person = await manager.getRepository(Tenant).findOne({ where: { id: dto.tenantId, buildingId: this.buildingId() } });
          if (!person) throw notFound('Person', 'tenantId');

          assertCanAddOccupant(
            await loadSnapshots(manager, contractId),
            { tenantId: person.id, hasIdDocument: !!person.idCardHash, hasPdplConsent: !!person.pdplConsentAcceptedAt },
            room.maxOccupants,
          );
          if (await manager.getRepository(ContractOccupant).exists({ where: { tenantId: person.id, status: OccupancyStatus.ACTIVE } })) {
            throw this.livesElsewhere();
          }

          const repo = manager.getRepository(ContractOccupant);
          const occupant = await repo.save(
            repo.create({
              contractId,
              tenantId: person.id,
              role: OccupantRole.CO_OCCUPANT,
              status: OccupancyStatus.ACTIVE,
              movedInAt: dto.movedInAt,
              successionOrder: dto.successionOrder ?? null,
              relationshipToHolder: dto.relationshipToHolder ?? null,
              residenceChannel: residenceChannelFor(person),
              residencyStatus: ResidencyStatus.PENDING_DECLARATION,
            }),
          );
          linked = await this.accounts.provisionFor(manager, this.buildingId(), [person.id], today);
          await this.extras.syncDerivedServices(manager, contract);
          await this.publish(manager, contractId, DOMAIN_EVENTS.OCCUPANT.MOVED_IN, { occupantId: occupant.id, tenantId: person.id, role: occupant.role });
          await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DECLARATION_REQUIRED, { occupantId: occupant.id, channel: occupant.residenceChannel });
          return this.loadOne(manager, contractId, occupant.id);
        }),
      );
    } catch (err) {
      // Hai lần chuyển đến song song của cùng một người vượt qua kiểm tra trước → unique index một phần chặn
      if (isUniqueViolation(err, ONE_ROOM_INDEX)) throw this.livesElsewhere();
      throw err;
    }
    await this.after(linked);
    return view;
  }

  async moveOut(contractId: string, occupantId: string, dto: MoveOutOccupantDto): Promise<OccupantView> {
    const today = vietnamToday();
    let users: string[] = [];
    const view = await this.withOccupancyLock(contractId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const contract = await this.lockActive(manager, contractId);
        const occupant = await this.findOccupant(manager, contractId, occupantId);
        if (occupant.status !== OccupancyStatus.ACTIVE) throw this.notActiveOccupant();
        if (occupant.role === OccupantRole.PRIMARY_HOLDER) {
          throw new ConflictException({
            errorCode: SystemErrorCode.BIZ_PRIMARY_HOLDER_USE_TRANSFER,
            message: 'The contract holder moves out through POST /contracts/{id}/primary-holder/transfer, or the room is checked out.',
            details: [{ field: 'occupantId', issue: 'PRIMARY_HOLDER' }],
          });
        }
        this.assertMoveDate('movedOutAt', dto.movedOutAt, occupant.movedInAt, today);

        const residency = residencyOnMoveOut(occupant.residencyStatus);
        occupant.status = OccupancyStatus.MOVED_OUT;
        occupant.movedOutAt = dto.movedOutAt;
        occupant.residencyStatus = residency;
        if (residency === ResidencyStatus.DEREGISTERED) occupant.residenceDeregisteredAt = new Date();
        await manager.getRepository(ContractOccupant).save(occupant);

        await this.extras.deactivateVehiclesOf(manager, contract, [occupant.tenantId], dto.movedOutAt);
        await this.extras.syncDerivedServices(manager, contract);
        await recomputeEvnHeadcount(manager, contractId);
        await this.publish(manager, contractId, DOMAIN_EVENTS.OCCUPANT.MOVED_OUT, { occupantId, tenantId: occupant.tenantId, movedOutAt: dto.movedOutAt, notes: dto.notes ?? null });
        if (residency === ResidencyStatus.DEREGISTRATION_PENDING) {
          await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DEREGISTRATION_REQUIRED, { occupantId, tenantId: occupant.tenantId });
        }
        users = await this.accounts.linkedUserIds(manager, this.buildingId(), [occupant.tenantId]);
        return this.loadOne(manager, contractId, occupantId);
      }),
    );
    await this.after(users);
    return view;
  }

  /** PENDING_DECLARATION → SUBMITTED → REGISTERED; DEREGISTRATION_PENDING → DEREGISTERED - định mức EVN tính lại */
  async updateResidency(contractId: string, occupantId: string, dto: UpdateResidencyStatusDto): Promise<OccupantView> {
    const today = vietnamToday();
    return this.rls.runInTenantContext(async (manager) => {
      await lockContract(manager, this.buildingId(), contractId);
      const occupant = await this.findOccupant(manager, contractId, occupantId);
      const from = occupant.residencyStatus;
      assertResidencyTransition(occupant.status, from, dto.residencyStatus);
      if (dto.residencyStatus === ResidencyStatus.REGISTERED) {
        const issue = checkTemporaryStayValidUntil(dto.temporaryStayValidUntil, today);
        if (issue) throw invalid([issue]);
        occupant.temporaryStayValidUntil = dto.temporaryStayValidUntil!;
        occupant.residenceRegisteredAt = new Date();
      } else if (dto.temporaryStayValidUntil !== undefined && dto.temporaryStayValidUntil !== null) {
        throw invalid([{ field: 'temporaryStayValidUntil', message: 'Only set together with REGISTERED' }]);
      }
      if (dto.residencyStatus === ResidencyStatus.SUBMITTED) occupant.residenceSubmittedAt = new Date();
      if (dto.residencyStatus === ResidencyStatus.DEREGISTERED) occupant.residenceDeregisteredAt = new Date();
      if (dto.referenceNo !== undefined) occupant.residenceReferenceNo = dto.referenceNo;
      occupant.residencyStatus = dto.residencyStatus;
      await manager.getRepository(ContractOccupant).save(occupant);
      const headcount = await recomputeEvnHeadcount(manager, contractId);
      await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.STATUS_CHANGED, {
        occupantId,
        tenantId: occupant.tenantId,
        from,
        to: dto.residencyStatus,
        registeredEvnQuotaHeadcount: headcount,
      });
      return this.loadOne(manager, contractId, occupantId);
    });
  }

  /** Người đứng tên chuyển đi (hoặc nhường quyền) - tài liệu 02, mục 5.4.2 */
  async transferPrimaryHolder(contractId: string, dto: TransferPrimaryHolderDto, user: RequestUserContext): Promise<HolderTransferView> {
    const today = vietnamToday();
    let users: string[] = [];
    const view = await this.withOccupancyLock(contractId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const contract = await this.lockActive(manager, contractId);
        const repo = manager.getRepository(ContractOccupant);
        const outgoing = await repo.findOne({
          where: { contractId, tenantId: contract.primaryTenantId, role: OccupantRole.PRIMARY_HOLDER, status: OccupancyStatus.ACTIVE },
        });
        if (!outgoing) throw this.notActiveOccupant();
        this.assertMoveDate('effectiveDate', dto.effectiveDate, outgoing.movedInAt, today);

        // Chính sách thuần: điều kiện (18+, giấy tờ, đồng ý), thứ tự kế nhiệm, người cuối cùng → trả phòng
        const successor = selectNextPrimaryHolder(await loadSnapshots(manager, contractId), contract.primaryTenantId, dto.effectiveDate, dto.newPrimaryTenantId ?? undefined);
        const stays = dto.outgoingHolderStays === true;

        // 1. Người cũ rời vai trò TRƯỚC (index một phần: chỉ một người đứng tên ACTIVE)
        outgoing.role = OccupantRole.CO_OCCUPANT;
        if (!stays) {
          outgoing.status = OccupancyStatus.MOVED_OUT;
          outgoing.movedOutAt = dto.effectiveDate;
          outgoing.residencyStatus = residencyOnMoveOut(outgoing.residencyStatus);
          if (outgoing.residencyStatus === ResidencyStatus.DEREGISTERED) outgoing.residenceDeregisteredAt = new Date();
        }
        await repo.save(outgoing);
        // 2. Người kế nhiệm đứng tên - CCCD của hợp đồng đổi tại đây
        const incoming = await repo.findOneOrFail({ where: { contractId, tenantId: successor.tenantId, status: OccupancyStatus.ACTIVE } });
        incoming.role = OccupantRole.PRIMARY_HOLDER;
        await repo.save(incoming);
        const fromTenantId = contract.primaryTenantId;
        contract.primaryTenantId = successor.tenantId;
        await manager.getRepository(Contract).save(contract);

        // 3. Lịch sử + phụ lục + tiền cọc (hóa đơn chưa thanh toán: module 5, hiện là 0)
        const transfers = manager.getRepository(ContractHolderTransfer);
        const transfer = await transfers.save(
          transfers.create({
            contractId,
            fromTenantId,
            toTenantId: successor.tenantId,
            effectiveDate: dto.effectiveDate,
            reason: stays ? HolderTransferReason.MUTUAL_AGREEMENT : HolderTransferReason.HOLDER_MOVED_OUT,
            selection: dto.newPrimaryTenantId ? HolderSelection.DESIGNATED : HolderSelection.AUTO_SUCCESSION,
            depositHandling: dto.depositHandling ?? HolderTransferDepositHandling.CARRY_OVER,
            outstandingBalance: '0.00',
            outstandingBalanceAssumedBy: dto.outstandingBalanceAssumedBy ?? 'OUTGOING_HOLDER',
            addendumNo: await nextAddendumNo(manager, contract),
            approvedById: user.id,
            notes: dto.notes ?? null,
          }),
        );
        await this.deposits.recordHolderTransfer(manager, contract, transfer, user.id);

        // 4. Xe của người cũ, dịch vụ theo người / xe, định mức EVN
        if (!stays) await this.extras.deactivateVehiclesOf(manager, contract, [fromTenantId], dto.effectiveDate);
        await this.extras.syncDerivedServices(manager, contract);
        await recomputeEvnHeadcount(manager, contractId);

        // 5. Phụ lục PDF, thông báo, đăng ký lại hộ (đổi chủ hộ - Luật Cư trú 2020, Điều 26)
        await this.publish(manager, contractId, DOMAIN_EVENTS.CONTRACT.PRIMARY_HOLDER_CHANGED, {
          transferId: transfer.id,
          addendumNo: transfer.addendumNo,
          fromTenantId,
          toTenantId: successor.tenantId,
        });
        if (!stays && outgoing.residencyStatus === ResidencyStatus.DEREGISTRATION_PENDING) {
          await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DEREGISTRATION_REQUIRED, { occupantId: outgoing.id, tenantId: fromTenantId });
        }
        await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DECLARATION_REQUIRED, { reason: 'HOUSEHOLD_HEAD_CHANGED', newHeadTenantId: successor.tenantId });
        users = await this.accounts.linkedUserIds(manager, this.buildingId(), [fromTenantId, successor.tenantId]);
        return this.loadTransfer(manager, transfer.id);
      }),
    );
    await this.after(users);
    return view;
  }

  history(contractId: string): Promise<HolderTransferView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      await findContract(manager, this.buildingId(), contractId);
      const ids = await manager
        .getRepository(ContractHolderTransfer)
        .find({ where: { contractId, buildingId: this.buildingId() }, order: { effectiveDate: 'ASC', createdAt: 'ASC' }, select: { id: true } });
      const views: HolderTransferView[] = [];
      for (const { id } of ids) views.push(await this.loadTransfer(manager, id));
      return views;
    });
  }

  // ----------------------------------------------------------------------------

  private async lockActive(manager: EntityManager, contractId: string): Promise<Contract> {
    const contract = await lockContract(manager, this.buildingId(), contractId);
    if (contract.status !== ContractStatus.ACTIVE) throw notActive(contract.status);
    return contract;
  }

  /** Ngày chuyển đến / đi / hiệu lực: ngày hợp lệ, không trước mốc (bắt đầu hợp đồng / ngày chuyển đến), không sau hôm nay */
  private assertMoveDate(field: string, value: string, notBefore: string, today: string): void {
    if (!isCalendarDate(value)) throw invalid([{ field, message: 'Not a valid calendar date' }]);
    if (value < notBefore) throw invalid([{ field, message: `Cannot be before ${notBefore}` }]);
    if (value > today) throw invalid([{ field, message: 'Cannot be in the future' }]);
  }

  private async findOccupant(manager: EntityManager, contractId: string, occupantId: string): Promise<ContractOccupant> {
    const occupant = await manager.getRepository(ContractOccupant).findOne({ where: { id: occupantId, contractId, buildingId: this.buildingId() } });
    if (!occupant) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Occupant not found on this contract.' });
    return occupant;
  }

  private occupantQuery(manager: EntityManager) {
    return manager
      .getRepository(ContractOccupant)
      .createQueryBuilder('co')
      .innerJoin('co.tenant', 't')
      .addSelect(['t.id', 't.fullName', 't.idDocumentType', 't.idCardLast4', 't.dateOfBirth']);
  }

  private async loadOne(manager: EntityManager, contractId: string, occupantId: string): Promise<OccupantView> {
    const o = await this.occupantQuery(manager).where('co.id = :occupantId AND co.contract_id = :contractId', { occupantId, contractId }).getOneOrFail();
    return this.view(o, vietnamToday());
  }

  private view(o: ContractOccupant, today: string): OccupantView {
    return {
      occupantId: o.id,
      tenantId: o.tenantId,
      fullName: o.tenant!.fullName,
      idDocumentType: o.tenant!.idDocumentType,
      idCardMasked: maskIdNumber(o.tenant!.idCardLast4),
      role: o.role,
      status: o.status,
      movedInAt: o.movedInAt,
      movedOutAt: o.movedOutAt ?? null,
      successionOrder: o.successionOrder ?? null,
      relationshipToHolder: o.relationshipToHolder ?? null,
      isMinor: isMinorOn(o.tenant!.dateOfBirth, today),
      residenceChannel: o.residenceChannel,
      residencyStatus: o.residencyStatus,
      temporaryStayValidUntil: o.temporaryStayValidUntil ?? null,
      residenceReferenceNo: o.residenceReferenceNo ?? null,
    };
  }

  private async loadTransfer(manager: EntityManager, id: string): Promise<HolderTransferView> {
    const t = await manager
      .getRepository(ContractHolderTransfer)
      .createQueryBuilder('h')
      .innerJoin('h.fromTenant', 'f')
      .innerJoin('h.toTenant', 'n')
      .addSelect(['f.id', 'f.fullName', 'n.id', 'n.fullName', 'n.idCardLast4'])
      .where('h.id = :id', { id })
      .getOneOrFail();
    return {
      transferId: t.id,
      contractId: t.contractId,
      fromTenantId: t.fromTenantId,
      fromTenantName: t.fromTenant!.fullName,
      toTenantId: t.toTenantId,
      toTenantName: t.toTenant!.fullName,
      newHolderIdCardMasked: maskIdNumber(t.toTenant!.idCardLast4),
      effectiveDate: t.effectiveDate,
      reason: t.reason,
      selection: t.selection,
      depositHandling: t.depositHandling,
      outstandingBalance: toNumber(t.outstandingBalance)!,
      outstandingBalanceAssumedBy: t.outstandingBalanceAssumedBy,
      addendumNo: t.addendumNo,
      addendumDownloadUrl: null, // PDF phụ lục: module 6
      createdAt: t.createdAt,
    };
  }

  private notActiveOccupant() {
    return new ConflictException({ errorCode: SystemErrorCode.BIZ_OCCUPANT_NOT_ACTIVE, message: 'This person no longer lives in the room.' });
  }

  private livesElsewhere() {
    return new ConflictException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_ALREADY_ACTIVE,
      message: 'This person still lives in another room; move them out there first.',
      details: [{ field: 'tenantId', issue: 'LIVES_IN_ANOTHER_ROOM' }],
    });
  }

  private publish(manager: EntityManager, contractId: string, eventType: string, payload: Record<string, unknown>) {
    return this.outbox.createEventInTransaction(manager, { aggregateType: 'CONTRACT', aggregateId: contractId, eventType, payload });
  }

  private withOccupancyLock<T>(contractId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.runWithLock(LOCK_KEYS.contractOccupancy(contractId), fn, { ttlMs: 15_000 });
  }

  private async after(userIds: string[]): Promise<void> {
    // Vai trò TENANT có thể vừa được thêm cho một tài khoản đã có (nhân viên cũng thuê phòng): nạp lại quyền SAU COMMIT
    await Promise.all([...new Set(userIds)].flatMap((u) => [this.selfScope.evict(u, this.buildingId()), this.permissionCache.invalidateUserPermissions(u)]));
    await this.cache.invalidateTag(ROOMS_TAG);
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
