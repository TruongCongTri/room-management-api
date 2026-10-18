/**
 * Vòng đời hợp đồng (tài liệu 02, mục 5.1 / 5.5 - quyết định D8): nháp → kích hoạt → gia hạn; hủy nháp.
 *  - Nháp & kích hoạt & hủy chạy dưới khóa LOCK_KEYS.roomContract(roomId) (dùng chung với đổi trạng thái phòng) + khóa
 *    dòng phòng / hợp đồng; partial unique index (một ACTIVE + một DRAFT mỗi phòng) chặn mọi cuộc đua còn lại.
 *  - Gia hạn ghi sổ cái tiền cọc → khóa LOCK_KEYS.contractOccupancy (= khóa trả phòng).
 *  - Hiệu ứng phụ qua outbox trong cùng transaction; cache phòng / phạm vi phòng của khách thuê xóa SAU COMMIT.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { OccupancySelfScopeService } from '../../../core/access-control/occupancy-self-scope';
import { PermissionCacheService } from '../../../core/access-control/permission-cache.service';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { DistributedLockService } from '../../../infrastructure/lock/services/distributed-lock.service';
import { LOCK_KEYS } from '../../../infrastructure/lock/constants/lock-keys.constant';
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { Building } from '../../properties/entities/building.entity';
import { Room, RoomStatus } from '../../properties/entities/room.entity';
import { ROOMS_TAG } from '../../properties/services/room-types.service';
import { assertSomethingToUpdate, isUniqueViolation, notFound, staleVersion, toNumber, vietnamToday } from '../../properties/properties.helpers';
import { AssetConditionGrade, RoomAsset } from '../../assets/entities/room-asset.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { OccupancyStatus, OccupantRole, ResidencyStatus, residenceChannelFor } from '../domain/occupancy.enums';
import { primaryHolderIneligibility } from '../domain/occupancy.policy';
import { addDays, checkContractTerms, checkPlannedPeople, depositTopUp, formatContractCode, isCalendarDate } from '../domain/contract.rules';
import { Contract, ContractStatus, DepositStatus, PlannedOccupant } from '../entities/contract.entity';
import { ContractOccupant } from '../entities/contract-occupant.entity';
import { ContractAsset } from '../entities/contract-asset.entity';
import { ContractRenewal } from '../entities/contract-renewal.entity';
import { CreateContractDto, ListContractsQueryDto, PlannedOccupantDto, RenewContractDto, UpdateDraftContractDto, VersionedActionDto } from '../dto/contracts.dto';
import { DepositEscrowService } from './deposit-escrow.service';
import { ContractExtrasService, ContractServiceView } from './contract-extras.service';
import { OccupantAccountsService } from './occupant-accounts.service';
import { activeOccupantCount, contractNotFound, findContract, invalid, lockContract, nextAddendumNo, notActive, notDraft, personRef, PersonRef } from './contract-helpers';

const ACTIVE_INDEX = 'idx_unique_active_contract_per_room';
const DRAFT_INDEX = 'idx_unique_draft_contract_per_room';
const ONE_ROOM_INDEX = 'idx_occupants_tenant_one_active';

export interface ContractSummaryView {
  id: string;
  contractCode: string;
  status: ContractStatus;
  roomId: string;
  roomNumber: string;
  primaryTenantName: string;
  startDate: string;
  endDate: string;
  monthlyRoomRent: number;
  activeOccupantCount: number;
}

export interface ContractView {
  id: string;
  contractCode: string;
  status: ContractStatus;
  room: { id: string; roomNumber: string; floor: number; maxOccupants: number };
  primaryHolder: Partial<PersonRef> & { tenantId: string; fullName: string };
  startDate: string;
  endDate: string;
  monthlyRoomRent: number;
  depositAmount: number;
  depositStatus: DepositStatus;
  depositBalance: number;
  paymentDueDay: number;
  pcccCommitmentSigned: boolean;
  registeredEvnQuotaHeadcount: number;
  activeOccupantCount: number;
  plannedCoOccupants: Array<PlannedOccupant & { fullName: string }> | null;
  rentedAssets: Array<{ contractAssetId: string; roomAssetId: string; name: string; serialNumber: string; agreedMonthlyFee: number; handoverCondition: AssetConditionGrade }>;
  services: ContractServiceView[];
  activatedAt: Date | null;
  cancelledAt: Date | null;
  version: number;
}

export interface RenewalView {
  renewalId: string;
  previousEndDate: string;
  newEndDate: string;
  effectiveDate: string;
  previousMonthlyRent: number;
  newMonthlyRent: number;
  depositTopUpAmount: number;
  addendumNo: string;
  notes: string | null;
  createdAt: Date;
}

/** Bản nháp đã kiểm tra: người, thiết bị, giá */
interface PreparedDraft {
  holder: Tenant;
  planned: PlannedOccupant[];
  units: RoomAsset[];
}

interface DraftInput {
  primaryTenantId: string;
  planned: PlannedOccupant[];
  startDate: string;
  endDate: string;
  paymentDueDay: number;
  rentedRoomAssetIds: string[];
}

@Injectable()
export class ContractsService {
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

  // ============================================================================ draft

  async create(dto: CreateContractDto): Promise<ContractView> {
    const input: DraftInput = {
      primaryTenantId: dto.primaryTenantId,
      planned: this.toPlanned(dto.coOccupants),
      startDate: dto.startDate,
      endDate: dto.endDate,
      paymentDueDay: dto.paymentDueDay ?? 5,
      rentedRoomAssetIds: dto.rentedRoomAssetIds ?? [],
    };
    this.assertDraftShape(input);
    const view = await this.withRoomLock(dto.roomId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const room = await this.lockRoom(manager, dto.roomId, 'roomId');
        if (room.currentContractId || (room.status !== RoomStatus.AVAILABLE && room.status !== RoomStatus.RESERVED)) {
          throw this.roomNotAvailable(room, 'ROOM_NOT_AVAILABLE');
        }
        if (await manager.getRepository(Contract).exists({ where: { roomId: room.id, status: ContractStatus.DRAFT } })) {
          throw this.roomNotAvailable(room, 'DRAFT_EXISTS');
        }
        const prepared = await this.prepareDraft(manager, room, input);
        const rent = dto.monthlyRoomRent ?? toNumber(room.priceOverride ?? room.roomType!.baseMonthlyRent)!;
        const repo = manager.getRepository(Contract);
        const contract = await repo.save(
          repo.create({
            contractCode: await this.nextContractCode(manager, room),
            roomId: room.id,
            primaryTenantId: prepared.holder.id,
            startDate: input.startDate,
            endDate: input.endDate,
            monthlyRoomRent: String(rent),
            depositAmount: String(dto.depositAmount ?? rent),
            depositStatus: DepositStatus.PENDING_COLLECTION,
            paymentDueDay: input.paymentDueDay,
            pcccCommitmentSigned: dto.pcccCommitmentSigned ?? false,
            status: ContractStatus.DRAFT,
            plannedCoOccupants: prepared.planned,
          }),
        );
        await this.replaceRentedUnits(manager, contract, prepared.units);
        await this.setRoomStatus(manager, room, RoomStatus.RESERVED);
        return this.loadView(manager, contract.id);
      }),
    ).catch((err) => {
      if (isUniqueViolation(err, DRAFT_INDEX)) throw this.roomNotAvailable(undefined, 'DRAFT_EXISTS');
      throw err;
    });
    await this.cache.invalidateTag(ROOMS_TAG);
    return view;
  }

  async updateDraft(id: string, dto: UpdateDraftContractDto): Promise<ContractView> {
    assertSomethingToUpdate(dto);
    const { roomId } = await this.rls.runInTenantContext((m) => findContract(m, this.buildingId(), id));
    return this.withRoomLock(roomId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const contract = await lockContract(manager, this.buildingId(), id);
        if (contract.status !== ContractStatus.DRAFT) throw notDraft(contract.status);
        if (dto.version !== undefined && dto.version !== contract.version) throw staleVersion();
        const input: DraftInput = {
          primaryTenantId: dto.primaryTenantId ?? contract.primaryTenantId,
          planned: dto.coOccupants !== undefined ? this.toPlanned(dto.coOccupants) : (contract.plannedCoOccupants ?? []),
          startDate: dto.startDate ?? contract.startDate,
          endDate: dto.endDate ?? contract.endDate,
          paymentDueDay: dto.paymentDueDay ?? contract.paymentDueDay,
          rentedRoomAssetIds:
            dto.rentedRoomAssetIds ?? (await manager.getRepository(ContractAsset).find({ where: { contractId: id } })).map((a) => a.roomAssetId),
        };
        this.assertDraftShape(input);
        const room = await this.lockRoom(manager, contract.roomId);
        const prepared = await this.prepareDraft(manager, room, input);

        contract.primaryTenantId = prepared.holder.id;
        contract.plannedCoOccupants = prepared.planned;
        contract.startDate = input.startDate;
        contract.endDate = input.endDate;
        contract.paymentDueDay = input.paymentDueDay;
        if (dto.monthlyRoomRent !== undefined) contract.monthlyRoomRent = String(dto.monthlyRoomRent);
        if (dto.depositAmount !== undefined) contract.depositAmount = String(dto.depositAmount);
        if (dto.pcccCommitmentSigned !== undefined) contract.pcccCommitmentSigned = dto.pcccCommitmentSigned;
        await manager.getRepository(Contract).save(contract);
        if (dto.rentedRoomAssetIds !== undefined) await this.replaceRentedUnits(manager, contract, prepared.units);
        await this.extras.syncDerivedServices(manager, contract);
        return this.loadView(manager, contract.id);
      }),
    );
  }

  async cancel(id: string, dto: VersionedActionDto): Promise<ContractView> {
    const { roomId } = await this.rls.runInTenantContext((m) => findContract(m, this.buildingId(), id));
    const view = await this.withRoomLock(roomId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const contract = await lockContract(manager, this.buildingId(), id);
        if (contract.status !== ContractStatus.DRAFT) throw notDraft(contract.status);
        if (dto.version !== undefined && dto.version !== contract.version) throw staleVersion();
        contract.status = ContractStatus.CANCELLED;
        contract.cancelledAt = new Date();
        contract.plannedCoOccupants = null;
        await manager.getRepository(Contract).save(contract);
        // Thiết bị được giải phóng (chuyển / gỡ được lại)
        const units = manager.getRepository(ContractAsset);
        await units.softRemove(await units.find({ where: { contractId: id } }));
        const room = await this.lockRoom(manager, contract.roomId);
        if (room.status === RoomStatus.RESERVED && !room.currentContractId) await this.setRoomStatus(manager, room, RoomStatus.AVAILABLE);
        return this.loadView(manager, contract.id);
      }),
    );
    await this.cache.invalidateTag(ROOMS_TAG);
    return view;
  }

  // ============================================================================ activation

  async activate(id: string, dto: VersionedActionDto, user: RequestUserContext): Promise<ContractView> {
    const buildingId = this.buildingId();
    const today = vietnamToday();
    const { roomId } = await this.rls.runInTenantContext((m) => findContract(m, buildingId, id));
    let linkedUsers: string[] = [];
    let view: ContractView;
    try {
      view = await this.withRoomLock(roomId, () =>
        this.rls.runInTenantContext(async (manager) => {
          const contract = await lockContract(manager, buildingId, id);
          if (contract.status !== ContractStatus.DRAFT) throw notDraft(contract.status);
          if (dto.version !== undefined && dto.version !== contract.version) throw staleVersion();
          if (!contract.pcccCommitmentSigned) {
            throw new UnprocessableEntityException({
              errorCode: SystemErrorCode.BIZ_PCCC_COMMITMENT_REQUIRED,
              message: 'The fire safety (PCCC) commitment must be signed before activation.',
              details: [{ field: 'pcccCommitmentSigned', issue: 'REQUIRED' }],
            });
          }
          if (contract.endDate < today) throw invalid([{ field: 'endDate', message: 'The contract term has already ended' }]);

          const room = await this.lockRoom(manager, contract.roomId);
          if (room.currentContractId) {
            throw new ConflictException({ errorCode: SystemErrorCode.BIZ_ROOM_HAS_ACTIVE_CONTRACT, message: 'The room already has an active contract.' });
          }
          if (room.status !== RoomStatus.AVAILABLE && room.status !== RoomStatus.RESERVED) throw this.roomNotAvailable(room, 'ROOM_NOT_AVAILABLE');

          const units = await manager.getRepository(ContractAsset).find({ where: { contractId: id } });
          const prepared = await this.prepareDraft(manager, room, {
            primaryTenantId: contract.primaryTenantId,
            planned: contract.plannedCoOccupants ?? [],
            startDate: contract.startDate,
            endDate: contract.endDate,
            paymentDueDay: contract.paymentDueDay,
            rentedRoomAssetIds: units.map((u) => u.roomAssetId),
          });
          const people = [prepared.holder.id, ...prepared.planned.map((p) => p.tenantId)];
          await this.assertNotLivingElsewhere(manager, people);

          // 1. Mọi người chuyển đến (người đứng tên trước), mỗi người một hồ sơ cư trú chờ khai báo
          const byId = new Map((await manager.getRepository(Tenant).find({ where: { buildingId, id: In(people) } })).map((t) => [t.id, t]));
          const occupants = manager.getRepository(ContractOccupant);
          const rows = [
            { tenantId: prepared.holder.id, movedInAt: contract.startDate, successionOrder: null, relationshipToHolder: null, role: OccupantRole.PRIMARY_HOLDER },
            ...prepared.planned.map((p) => ({ ...p, movedInAt: p.movedInAt ?? contract.startDate, role: OccupantRole.CO_OCCUPANT })),
          ];
          const saved: ContractOccupant[] = [];
          for (const row of rows) {
            saved.push(
              await occupants.save(
                occupants.create({
                  contractId: id,
                  tenantId: row.tenantId,
                  role: row.role,
                  status: OccupancyStatus.ACTIVE,
                  movedInAt: row.movedInAt!,
                  successionOrder: row.successionOrder ?? null,
                  relationshipToHolder: row.relationshipToHolder ?? null,
                  residenceChannel: residenceChannelFor(byId.get(row.tenantId)!),
                  residencyStatus: ResidencyStatus.PENDING_DECLARATION,
                }),
              ),
            );
          }

          // 2. Hợp đồng hiệu lực + tiền cọc HELD (sổ cái ghi người nộp = người đứng tên)
          contract.status = ContractStatus.ACTIVE;
          contract.activatedAt = new Date();
          contract.depositStatus = DepositStatus.HELD;
          contract.plannedCoOccupants = null;
          contract.registeredEvnQuotaHeadcount = 0;
          await manager.getRepository(Contract).save(contract);
          await this.deposits.recordInitialCollection(manager, contract, user.id);

          // 3. Biên bản bàn giao: tình trạng thiết bị tại thời điểm chuyển đến
          for (const rented of units) {
            const unit = prepared.units.find((u) => u.id === rented.roomAssetId)!;
            if (rented.handoverCondition !== unit.conditionGrade) {
              rented.handoverCondition = unit.conditionGrade;
              await manager.getRepository(ContractAsset).save(rented);
            }
          }

          // 4. Phòng có người ở
          room.currentContractId = id;
          await this.setRoomStatus(manager, room, RoomStatus.OCCUPIED);

          // 5. Tài khoản khách thuê + dịch vụ theo người
          linkedUsers = await this.accounts.provisionFor(manager, buildingId, people, today);
          await this.extras.syncDerivedServices(manager, contract);

          // 6. Sự kiện: hợp đồng, từng người chuyển đến + khai báo tạm trú (CT01 / người nước ngoài)
          await this.publish(manager, id, DOMAIN_EVENTS.CONTRACT.ACTIVATED, {
            contractId: id,
            contractCode: contract.contractCode,
            roomId: room.id,
            roomNumber: room.roomNumber,
            primaryTenantId: contract.primaryTenantId,
            occupantCount: saved.length,
          });
          for (const occupant of saved) {
            await this.publish(manager, id, DOMAIN_EVENTS.OCCUPANT.MOVED_IN, { occupantId: occupant.id, tenantId: occupant.tenantId, role: occupant.role });
            await this.publish(manager, id, DOMAIN_EVENTS.RESIDENCE.DECLARATION_REQUIRED, { occupantId: occupant.id, channel: occupant.residenceChannel });
          }
          return this.loadView(manager, id);
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_INDEX) || isUniqueViolation(err, 'uq_rooms_current_contract')) {
        throw new ConflictException({ errorCode: SystemErrorCode.BIZ_ROOM_HAS_ACTIVE_CONTRACT, message: 'The room already has an active contract.' });
      }
      if (isUniqueViolation(err, ONE_ROOM_INDEX)) throw this.livesElsewhere([]);
      throw err;
    }
    await this.afterOccupancyChange(linkedUsers);
    return view;
  }

  // ============================================================================ renewal

  async renew(id: string, dto: RenewContractDto, user: RequestUserContext): Promise<RenewalView> {
    const today = vietnamToday();
    if (!isCalendarDate(dto.newEndDate)) throw invalid([{ field: 'newEndDate', message: 'Not a valid calendar date' }]);
    return this.locks.runWithLock(LOCK_KEYS.contractOccupancy(id), () =>
      this.rls.runInTenantContext(async (manager) => {
        const contract = await lockContract(manager, this.buildingId(), id);
        if (contract.status !== ContractStatus.ACTIVE) throw notActive(contract.status);
        if (dto.version !== undefined && dto.version !== contract.version) throw staleVersion();
        if (dto.newEndDate <= contract.endDate) throw invalid([{ field: 'newEndDate', message: `Must be after the current end date ${contract.endDate}` }]);
        if (dto.newEndDate <= today) throw invalid([{ field: 'newEndDate', message: 'Must be after today' }]);

        const previousRent = toNumber(contract.monthlyRoomRent)!;
        const newRent = dto.newMonthlyRoomRent ?? previousRent;
        const topUp = dto.topUpDeposit ? depositTopUp(await this.deposits.balance(manager, id), newRent) : 0;
        const repo = manager.getRepository(ContractRenewal);
        const renewal = await repo.save(
          repo.create({
            contractId: id,
            previousEndDate: contract.endDate,
            newEndDate: dto.newEndDate,
            effectiveDate: addDays(contract.endDate, 1),
            previousMonthlyRent: String(previousRent),
            newMonthlyRent: String(newRent),
            depositTopUpAmount: String(topUp),
            addendumNo: await nextAddendumNo(manager, contract),
            approvedById: user.id,
            notes: dto.notes ?? null,
          }),
        );
        contract.endDate = dto.newEndDate;
        contract.monthlyRoomRent = String(newRent);
        if (dto.topUpDeposit && newRent > toNumber(contract.depositAmount)!) contract.depositAmount = String(newRent);
        await manager.getRepository(Contract).save(contract);
        await this.deposits.recordTopUp(manager, contract, topUp, user.id, renewal.addendumNo);
        await this.publish(manager, id, DOMAIN_EVENTS.CONTRACT.RENEWED, {
          contractId: id,
          renewalId: renewal.id,
          addendumNo: renewal.addendumNo,
          previousEndDate: renewal.previousEndDate,
          newEndDate: renewal.newEndDate,
          effectiveDate: renewal.effectiveDate,
          newMonthlyRent: newRent,
        });
        return this.renewalView(renewal);
      }),
    );
  }

  renewals(id: string): Promise<RenewalView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      await findContract(manager, this.buildingId(), id);
      const rows = await manager.getRepository(ContractRenewal).find({ where: { contractId: id }, order: { effectiveDate: 'ASC', createdAt: 'ASC' } });
      return rows.map((r) => this.renewalView(r));
    });
  }

  // ============================================================================ reads

  list(query: ListContractsQueryDto) {
    return this.rls.runInTenantContext(async (manager) => {
      const qb = manager
        .getRepository(Contract)
        .createQueryBuilder('c')
        .innerJoin('c.room', 'r')
        .innerJoin('c.primaryTenant', 't')
        .where('c.building_id = :b', { b: this.buildingId() });
      if (query.status) qb.andWhere('c.status = :status', { status: query.status });
      if (query.roomId) qb.andWhere('c.room_id = :roomId', { roomId: query.roomId });
      if (query.tenantId) {
        qb.andWhere(
          `(c.primary_tenant_id = :tenantId
            OR EXISTS (SELECT 1 FROM contract_occupants co WHERE co.contract_id = c.id AND co.tenant_id = :tenantId AND co.deleted_at IS NULL)
            OR c.planned_co_occupants @> jsonb_build_array(jsonb_build_object('tenantId', CAST(:tenantId AS text))))`,
          { tenantId: query.tenantId },
        );
      }
      if (query.q) {
        const like = `%${query.q.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb.andWhere(`(UPPER(c.contract_code) LIKE :like ESCAPE '\\' OR UPPER(r.room_number) LIKE :like ESCAPE '\\')`, { like });
      }
      if (query.endingBefore) qb.andWhere(`c.status = 'ACTIVE' AND c.end_date <= :endingBefore`, { endingBefore: query.endingBefore });
      const total = await qb.getCount();
      const rows = await qb
        .select([
          'c.id AS "id"',
          'c.contract_code AS "contractCode"',
          'c.status AS "status"',
          'c.room_id AS "roomId"',
          'r.room_number AS "roomNumber"',
          't.full_name AS "primaryTenantName"',
          `to_char(c.start_date, 'YYYY-MM-DD') AS "startDate"`,
          `to_char(c.end_date, 'YYYY-MM-DD') AS "endDate"`,
          'c.monthly_room_rent AS "monthlyRoomRent"',
          `(SELECT COUNT(*) FROM contract_occupants co WHERE co.contract_id = c.id AND co.status = 'ACTIVE' AND co.deleted_at IS NULL)::int AS "activeOccupantCount"`,
        ])
        .orderBy('c.start_date', 'DESC')
        .addOrderBy('c.contract_code', 'ASC')
        .offset((query.page - 1) * query.limit)
        .limit(query.limit)
        .getRawMany();
      const items: ContractSummaryView[] = rows.map((r) => ({ ...r, monthlyRoomRent: Number(r.monthlyRoomRent), activeOccupantCount: Number(r.activeOccupantCount) }));
      return { items, total, page: query.page, limit: query.limit };
    });
  }

  getById(id: string): Promise<ContractView> {
    return this.rls.runInTenantContext((manager) => this.loadView(manager, id));
  }

  /** Hợp đồng khách thuê đang ở (OCCUPANCY_SELF_SCOPE); không có số giấy tờ của người đứng tên */
  async getMine(user: RequestUserContext): Promise<ContractView> {
    const scope = await this.selfScope.resolve(user.id, this.buildingId());
    if (!scope) {
      if (!user.roles.includes(RentalRole.TENANT)) {
        throw new ForbiddenException({ errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE, message: 'Only tenants have a contract of their own.' });
      }
      throw new NotFoundException({ errorCode: SystemErrorCode.BIZ_NO_ACTIVE_ROOM, message: 'You do not currently live in a room of this building.' });
    }
    const view = await this.getById(scope.contractId);
    return { ...view, primaryHolder: { tenantId: view.primaryHolder.tenantId, fullName: view.primaryHolder.fullName, phone: view.primaryHolder.phone } };
  }

  // ============================================================================ internals

  private toPlanned(list: PlannedOccupantDto[] | undefined): PlannedOccupant[] {
    return (list ?? []).map((p) => ({
      tenantId: p.tenantId,
      movedInAt: p.movedInAt ?? null,
      successionOrder: p.successionOrder ?? null,
      relationshipToHolder: p.relationshipToHolder ?? null,
    }));
  }

  private assertDraftShape(input: DraftInput): void {
    const issues = checkContractTerms(input);
    if (!issues.length) issues.push(...checkPlannedPeople(input.primaryTenantId, input.planned, input));
    if (issues.length) throw invalid(issues);
  }

  /** Kiểm tra bản nháp hoàn chỉnh trên phòng đã khóa: người (cùng tòa), người đứng tên đủ điều kiện, sức chứa, thiết bị */
  private async prepareDraft(manager: EntityManager, room: Room, input: DraftInput): Promise<PreparedDraft> {
    const buildingId = this.buildingId();
    const ids = [input.primaryTenantId, ...input.planned.map((p) => p.tenantId)];
    const people = await manager.getRepository(Tenant).find({ where: { buildingId, id: In(ids) } });
    const holder = people.find((p) => p.id === input.primaryTenantId);
    if (!holder) throw notFound('Person', 'primaryTenantId');
    const missing = input.planned.findIndex((p) => !people.some((t) => t.id === p.tenantId));
    if (missing >= 0) throw notFound('Person', `coOccupants[${missing}].tenantId`);

    const reasons = primaryHolderIneligibility(
      {
        tenantId: holder.id,
        role: OccupantRole.PRIMARY_HOLDER,
        status: OccupancyStatus.ACTIVE,
        residencyStatus: ResidencyStatus.PENDING_DECLARATION,
        movedInAt: input.startDate,
        dateOfBirth: holder.dateOfBirth,
        idDocumentType: holder.idDocumentType,
        hasIdDocument: !!holder.idCardHash,
        hasPdplConsent: !!holder.pdplConsentAcceptedAt,
      },
      input.startDate,
    );
    if (reasons.length) {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE,
        message: 'The contract holder must be an adult on the start date, with an ID document and consent.',
        details: reasons.map((issue) => ({ field: 'primaryTenantId', issue })),
      });
    }
    if (1 + input.planned.length > room.maxOccupants) {
      throw new ConflictException({
        errorCode: SystemErrorCode.BIZ_OCCUPANT_LIMIT_EXCEEDED,
        message: `The room allows at most ${room.maxOccupants} occupant(s).`,
        details: [{ field: 'coOccupants', issue: 'CAPACITY', maxOccupants: room.maxOccupants, requested: 1 + input.planned.length }],
      });
    }

    const units = input.rentedRoomAssetIds.length
      ? await manager.getRepository(RoomAsset).find({ where: { buildingId, roomId: room.id, id: In(input.rentedRoomAssetIds) } })
      : [];
    const absent = input.rentedRoomAssetIds.find((u) => !units.some((x) => x.id === u));
    if (absent) throw notFound('Installed unit in this room', 'rentedRoomAssetIds');
    const broken = units.find((u) => u.conditionGrade === AssetConditionGrade.BROKEN);
    if (broken) throw invalid([{ field: 'rentedRoomAssetIds', message: `Unit ${broken.serialNumber} is BROKEN and cannot be rented` }]);
    return { holder, planned: input.planned, units };
  }

  private async replaceRentedUnits(manager: EntityManager, contract: Contract, units: RoomAsset[]): Promise<void> {
    const repo = manager.getRepository(ContractAsset);
    const current = await repo.find({ where: { contractId: contract.id } });
    const keep = new Set(units.map((u) => u.id));
    await repo.softRemove(current.filter((c) => !keep.has(c.roomAssetId)));
    for (const unit of units.filter((u) => !current.some((c) => c.roomAssetId === u.id))) {
      await repo.save(
        repo.create({ contractId: contract.id, roomAssetId: unit.id, agreedMonthlyFee: unit.customMonthlyFee, handoverCondition: unit.conditionGrade }),
      );
    }
  }

  private async assertNotLivingElsewhere(manager: EntityManager, tenantIds: string[]): Promise<void> {
    const elsewhere = await manager
      .getRepository(ContractOccupant)
      .find({ where: { tenantId: In(tenantIds), status: OccupancyStatus.ACTIVE }, select: { tenantId: true } });
    if (elsewhere.length) throw this.livesElsewhere(elsewhere.map((o) => o.tenantId));
  }

  private livesElsewhere(tenantIds: string[]) {
    return new ConflictException({
      errorCode: SystemErrorCode.BIZ_OCCUPANT_ALREADY_ACTIVE,
      message: 'Someone on this contract still lives in another room; move them out there first.',
      details: tenantIds.map((tenantId) => ({ field: 'tenantId', issue: 'LIVES_IN_ANOTHER_ROOM', tenantId })),
    });
  }

  /** Mã hợp đồng theo năm, tuần tự trong tòa nhà: khóa dòng tòa nhà để hai bản nháp đồng thời không lấy trùng số */
  private async nextContractCode(manager: EntityManager, room: Room): Promise<string> {
    await manager.getRepository(Building).findOne({ where: { id: room.buildingId }, lock: { mode: 'pessimistic_write' } });
    const year = Number(vietnamToday().slice(0, 4));
    const count = await manager
      .getRepository(Contract)
      .createQueryBuilder('c')
      .withDeleted()
      .where('c.building_id = :b AND c.contract_code LIKE :prefix', { b: room.buildingId, prefix: `HD-${year}/%` })
      .getCount();
    return formatContractCode(year, count + 1, room.roomNumber);
  }

  private async lockRoom(manager: EntityManager, roomId: string, field?: string): Promise<Room> {
    const room = await manager
      .getRepository(Room)
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.roomType', 'rt')
      .where('r.id = :roomId AND r.building_id = :b', { roomId, b: this.buildingId() })
      .setLock('pessimistic_write', undefined, ['r'])
      .getOne();
    if (!room) throw notFound('Room', field);
    return room;
  }

  private async setRoomStatus(manager: EntityManager, room: Room, status: RoomStatus): Promise<void> {
    const from = room.status;
    room.status = status;
    await manager.getRepository(Room).save(room);
    if (from !== status) {
      await this.outbox.createEventInTransaction(manager, {
        aggregateType: 'ROOM',
        aggregateId: room.id,
        eventType: DOMAIN_EVENTS.ROOM.STATUS_CHANGED,
        payload: { roomId: room.id, roomNumber: room.roomNumber, from, to: status },
      });
    }
  }

  private roomNotAvailable(room: Room | undefined, issue: 'ROOM_NOT_AVAILABLE' | 'DRAFT_EXISTS') {
    return new ConflictException({
      errorCode: SystemErrorCode.BIZ_ROOM_NOT_AVAILABLE,
      message: issue === 'DRAFT_EXISTS' ? 'The room already has a draft contract.' : `The room is ${room?.status} and cannot take a new contract.`,
      details: [{ field: 'roomId', issue, ...(room ? { status: room.status } : {}) }],
    });
  }

  private async loadView(manager: EntityManager, id: string): Promise<ContractView> {
    const buildingId = this.buildingId();
    const today = vietnamToday();
    const contract = await manager
      .getRepository(Contract)
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.room', 'r')
      .innerJoinAndSelect('c.primaryTenant', 't')
      .where('c.id = :id AND c.building_id = :b', { id, b: buildingId })
      .getOne();
    if (!contract) throw contractNotFound();

    const planned = contract.plannedCoOccupants ?? null;
    const names = planned?.length
      ? new Map((await manager.getRepository(Tenant).find({ where: { buildingId, id: In(planned.map((p) => p.tenantId)) } })).map((t) => [t.id, t.fullName]))
      : new Map<string, string>();
    const units = await manager
      .getRepository(ContractAsset)
      .createQueryBuilder('ca')
      .innerJoinAndSelect('ca.roomAsset', 'ra')
      .innerJoinAndSelect('ra.asset', 'a')
      .withDeleted()
      .where('ca.contract_id = :id AND ca.deleted_at IS NULL', { id })
      .orderBy('a.name', 'ASC')
      .addOrderBy('ra.serial_number', 'ASC')
      .getMany();
    const holder = personRef(contract.primaryTenant!, today);

    return {
      id: contract.id,
      contractCode: contract.contractCode,
      status: contract.status,
      room: { id: contract.room!.id, roomNumber: contract.room!.roomNumber, floor: contract.room!.floor, maxOccupants: contract.room!.maxOccupants },
      primaryHolder: { tenantId: holder.tenantId, fullName: holder.fullName, idCardMasked: holder.idCardMasked, phone: holder.phone },
      startDate: contract.startDate,
      endDate: contract.endDate,
      monthlyRoomRent: toNumber(contract.monthlyRoomRent)!,
      depositAmount: toNumber(contract.depositAmount)!,
      depositStatus: contract.depositStatus,
      depositBalance: await this.deposits.balance(manager, contract.id),
      paymentDueDay: contract.paymentDueDay,
      pcccCommitmentSigned: contract.pcccCommitmentSigned,
      registeredEvnQuotaHeadcount: contract.registeredEvnQuotaHeadcount,
      activeOccupantCount: await activeOccupantCount(manager, contract.id),
      plannedCoOccupants: planned ? planned.map((p) => ({ ...p, fullName: names.get(p.tenantId) ?? '' })) : null,
      rentedAssets: units.map((u) => ({
        contractAssetId: u.id,
        roomAssetId: u.roomAssetId,
        name: u.roomAsset!.asset!.name,
        serialNumber: u.roomAsset!.serialNumber,
        agreedMonthlyFee: toNumber(u.agreedMonthlyFee)!,
        handoverCondition: u.handoverCondition,
      })),
      services: await this.extras.loadServices(manager, contract.id),
      activatedAt: contract.activatedAt ?? null,
      cancelledAt: contract.cancelledAt ?? null,
      version: contract.version,
    };
  }

  private renewalView(r: ContractRenewal): RenewalView {
    return {
      renewalId: r.id,
      previousEndDate: r.previousEndDate,
      newEndDate: r.newEndDate,
      effectiveDate: r.effectiveDate,
      previousMonthlyRent: toNumber(r.previousMonthlyRent)!,
      newMonthlyRent: toNumber(r.newMonthlyRent)!,
      depositTopUpAmount: toNumber(r.depositTopUpAmount)!,
      addendumNo: r.addendumNo,
      notes: r.notes ?? null,
      createdAt: r.createdAt,
    };
  }

  private publish(manager: EntityManager, contractId: string, eventType: string, payload: Record<string, unknown>) {
    return this.outbox.createEventInTransaction(manager, { aggregateType: 'CONTRACT', aggregateId: contractId, eventType, payload });
  }

  private withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.runWithLock(LOCK_KEYS.roomContract(roomId), fn, { ttlMs: 15_000 });
  }

  /** SAU COMMIT: phạm vi phòng của khách thuê (chuyển đến / đi là có / mất quyền ngay) + cache phòng */
  private async afterOccupancyChange(userIds: string[]): Promise<void> {
    // Vai trò TENANT có thể vừa được thêm cho một tài khoản đã có (nhân viên cũng thuê phòng): nạp lại quyền SAU COMMIT
    await Promise.all([...new Set(userIds)].flatMap((u) => [this.selfScope.evict(u, this.buildingId()), this.permissionCache.invalidateUserPermissions(u)]));
    await this.cache.invalidateTag(ROOMS_TAG);
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
