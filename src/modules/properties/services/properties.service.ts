/**
 * Danh bạ 80 phòng của tòa nhà hiệu lực (tài liệu 02, mục 3.2) theo 4 Mandate:
 *  #1 mọi truy vấn lọc building_id TRƯỚC (khớp idx_rooms_bld_status_type / idx_rooms_bld_floor_status /
 *     idx_rooms_available_covering) - đồng thời là lớp cô lập thứ nhất, RLS là lớp thứ hai;
 *  #2 chi tiết phòng = MỘT truy vấn join (hạng phòng + thiết bị); #3 danh sách chỉ 6 trường;
 *  #4 thống kê phòng trống cache XFetch `rooms:vacancies:summary`, xóa qua tag `rooms`.
 *
 * Quản lý phòng (D5): tạo phòng không vượt sức chứa (khóa dòng tòa nhà khi đếm), đổi giá / trạng thái dưới khóa
 * LOCK_KEYS.roomContract (dùng chung với kích hoạt hợp đồng) + optimistic version; đổi trạng thái phát
 * `room.status_changed` qua outbox (cùng transaction).
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { OccupancySelfScopeService } from '../../../core/access-control/occupancy-self-scope';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { DistributedLockService } from '../../../infrastructure/lock/services/distributed-lock.service';
import { LOCK_KEYS } from '../../../infrastructure/lock/constants/lock-keys.constant';
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { Building } from '../entities/building.entity';
import { RoomType } from '../entities/room-type.entity';
import { Room, RoomStatus } from '../entities/room.entity';
import { CreateRoomDto, QueryRoomsDto, UpdateRoomDto } from '../dto/properties.dto';
import { alreadyExists, assertSomethingToUpdate, isUniqueViolation, notFound, staleVersion, toNumber } from '../properties.helpers';
import { ROOMS_TAG } from './room-types.service';

export const VACANCY_CACHE_KEY = 'rooms:vacancies:summary';

export interface RoomListItem {
  id: string;
  roomNumber: string;
  floor: number;
  status: RoomStatus;
  roomTypeName: string;
  effectivePrice: number;
}

export interface RoomDetail {
  id: string;
  roomNumber: string;
  floor: number;
  areaSqm: number;
  maxOccupants: number;
  status: RoomStatus;
  roomTypeId: string;
  roomTypeName: string;
  priceOverride: number | null;
  effectiveRent: number;
  /** Hợp đồng hiệu lực của phòng (quyết định D3, hoàn chỉnh ở module 3) */
  activeContract: ActiveContractSummary | null;
  isPubliclyListed: boolean;
  rentedAssets: Array<{
    roomAssetId: string;
    name: string;
    category: string;
    serialNumber: string;
    conditionGrade: string;
    monthlyFee: number;
  }>;
  version: number;
}

export interface ActiveContractSummary {
  id: string;
  contractCode: string;
  primaryTenantName: string;
  primaryTenantPhone: string | null;
  occupantCount: number;
  monthlyRoomRent: number;
  depositHeld: number;
  startDate: string;
  endDate: string;
}

export interface VacancySummaryItem {
  roomTypeId: string;
  roomTypeName: string;
  basePrice: number;
  totalRooms: number;
  availableRooms: number;
  occupiedRooms: number;
  maintenanceRooms: number;
  occupancyPercentage: number;
}

const SORT_COLUMNS: Record<QueryRoomsDto['sortBy'], string> = {
  roomNumber: 'r.room_number',
  floor: 'r.floor',
  effectivePrice: 'COALESCE(r.price_override, rt.base_monthly_rent)',
};

@Injectable()
export class PropertiesService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly cache: RedisCacheService,
    private readonly locks: DistributedLockService,
    private readonly outbox: OutboxService,
    private readonly selfScope: OccupancySelfScopeService,
  ) {}

  /** Mandate #1-#3: một truy vấn INNER JOIN, 6 trường, phân trang ổn định (tie-breaker số phòng, id) */
  listRooms(query: QueryRoomsDto) {
    return this.rls.runInTenantContext(async (manager) => {
      const qb = manager
        .createQueryBuilder(Room, 'r')
        .innerJoin('r.roomType', 'rt')
        .where('r.building_id = :buildingId', { buildingId: this.buildingId() });
      if (query.status) qb.andWhere('r.status = :status', { status: query.status });
      if (query.roomTypeId) qb.andWhere('r.room_type_id = :roomTypeId', { roomTypeId: query.roomTypeId });
      if (query.floor !== undefined) qb.andWhere('r.floor = :floor', { floor: query.floor });

      const total = await qb.getCount();
      const rows = await qb
        .select([
          'r.id AS "id"',
          'r.room_number AS "roomNumber"',
          'r.floor AS "floor"',
          'r.status AS "status"',
          'rt.name AS "roomTypeName"',
          'COALESCE(r.price_override, rt.base_monthly_rent) AS "effectivePrice"',
        ])
        .orderBy(SORT_COLUMNS[query.sortBy], query.sortOrder)
        // Thứ tự ổn định giữa các trang khi giá / tầng bằng nhau
        .addOrderBy('r.room_number', 'ASC')
        .addOrderBy('r.id', 'ASC')
        .offset((query.page - 1) * query.limit)
        .limit(query.limit)
        .getRawMany();

      const items: RoomListItem[] = rows.map((row) => ({
        id: row.id,
        roomNumber: row.roomNumber,
        floor: Number(row.floor),
        status: row.status,
        roomTypeName: row.roomTypeName,
        effectivePrice: Number(row.effectivePrice),
      }));
      return { items, total, page: query.page, limit: query.limit };
    });
  }

  /** Mandate #2: phòng + hạng phòng + thiết bị đang lắp trong MỘT truy vấn */
  getRoomDetail(roomId: string): Promise<RoomDetail> {
    return this.rls.runInTenantContext((manager) => this.loadDetail(manager, roomId));
  }

  /**
   * Phòng của khách thuê đang đăng nhập (OCCUPANCY_SELF_SCOPE). Nhân viên không phải khách thuê → 403
   * (dùng /{id}); khách thuê không ở phòng nào của tòa nhà này → 404 BIZ_NO_ACTIVE_ROOM.
   */
  async getMyRoom(user: RequestUserContext): Promise<RoomDetail> {
    const scope = await this.selfScope.resolve(user.id, this.buildingId());
    if (!scope) {
      if (!user.roles.includes(RentalRole.TENANT)) {
        throw new ForbiddenException({
          errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
          message: 'Only tenants have a room of their own; staff open rooms by id.',
        });
      }
      throw new NotFoundException({
        errorCode: SystemErrorCode.BIZ_NO_ACTIVE_ROOM,
        message: 'You do not currently live in a room of this building.',
      });
    }
    return this.getRoomDetail(scope.roomId);
  }

  /** Mandate #1 + #4: một GROUP BY trên idx_rooms_bld_status_type, cache XFetch + single-flight */
  getVacancySummary(): Promise<VacancySummaryItem[]> {
    return this.cache.getOrSet(
      VACANCY_CACHE_KEY,
      () =>
        this.rls.runInTenantContext(async (manager) => {
          const rows = await manager
            .createQueryBuilder(RoomType, 'rt')
            .leftJoin(Room, 'r', 'r.room_type_id = rt.id AND r.building_id = rt.building_id AND r.deleted_at IS NULL')
            .select([
              'rt.id AS "roomTypeId"',
              'rt.name AS "roomTypeName"',
              'rt.base_monthly_rent AS "basePrice"',
              'COUNT(r.id) AS "totalRooms"',
              `COUNT(r.id) FILTER (WHERE r.status = '${RoomStatus.AVAILABLE}') AS "availableRooms"`,
              `COUNT(r.id) FILTER (WHERE r.status = '${RoomStatus.OCCUPIED}') AS "occupiedRooms"`,
              `COUNT(r.id) FILTER (WHERE r.status = '${RoomStatus.MAINTENANCE}') AS "maintenanceRooms"`,
            ])
            .where('rt.building_id = :buildingId', { buildingId: this.buildingId() })
            .groupBy('rt.id')
            .orderBy('rt.base_monthly_rent', 'ASC')
            .addOrderBy('rt.code', 'ASC')
            .getRawMany();

          return rows.map((row) => {
            const total = Number(row.totalRooms);
            const occupied = Number(row.occupiedRooms);
            return {
              roomTypeId: row.roomTypeId,
              roomTypeName: row.roomTypeName,
              basePrice: Number(row.basePrice),
              totalRooms: total,
              availableRooms: Number(row.availableRooms),
              occupiedRooms: occupied,
              maintenanceRooms: Number(row.maintenanceRooms),
              occupancyPercentage: total > 0 ? Number(((occupied / total) * 100).toFixed(2)) : 0,
            };
          });
        }),
      { ttlSeconds: 3600, tags: [ROOMS_TAG] },
    );
  }

  async createRoom(dto: CreateRoomDto): Promise<RoomDetail> {
    const buildingId = this.buildingId();
    let detail: RoomDetail;
    try {
      detail = await this.rls.runInTenantContext(async (manager) => {
        // Khóa dòng tòa nhà: hai request tạo phòng đồng thời không thể cùng lấy chỗ trống cuối cùng
        const building = await manager.getRepository(Building).findOne({ where: { id: buildingId }, lock: { mode: 'pessimistic_write' } });
        if (!building) throw notFound('Building');
        const roomCount = await manager.getRepository(Room).count({ where: { buildingId } });
        if (roomCount >= building.totalRoomsCapacity) {
          throw new ConflictException({
            errorCode: SystemErrorCode.BIZ_BUILDING_CAPACITY_EXCEEDED,
            message: `The building already has its maximum of ${building.totalRoomsCapacity} rooms.`,
            details: [{ field: 'roomNumber', issue: 'CAPACITY_REACHED', capacity: building.totalRoomsCapacity }],
          });
        }

        const roomType = await this.findRoomType(manager, dto.roomTypeId);
        const repo = manager.getRepository(Room);
        if (await repo.exists({ where: { buildingId, roomNumber: dto.roomNumber }, withDeleted: true })) {
          throw alreadyExists('roomNumber', dto.roomNumber);
        }
        const room = await repo.save(
          repo.create({
            roomNumber: dto.roomNumber,
            floor: dto.floor,
            areaSqm: String(dto.areaSqm),
            roomTypeId: roomType.id,
            maxOccupants: dto.maxOccupants ?? roomType.defaultMaxOccupants,
            priceOverride: dto.priceOverride != null ? String(dto.priceOverride) : null,
            status: RoomStatus.AVAILABLE,
          }),
        );
        return this.loadDetail(manager, room.id);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'idx_rooms_bld_number_unique')) throw alreadyExists('roomNumber', dto.roomNumber);
      throw err;
    }
    await this.cache.invalidateTag(ROOMS_TAG);
    return detail;
  }

  async updateRoom(roomId: string, dto: UpdateRoomDto): Promise<RoomDetail> {
    assertSomethingToUpdate(dto);
    let detail: RoomDetail;
    try {
      // Cùng khóa với kích hoạt hợp đồng: không đổi trạng thái giữa lúc phòng đang được cho thuê
      detail = await this.locks.runWithLock(LOCK_KEYS.roomContract(roomId), () =>
        this.rls.runInTenantContext(async (manager) => {
          const repo = manager.getRepository(Room);
          const room = await repo.findOne({ where: { id: roomId, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
          if (!room) throw notFound('Room');
          if (dto.version !== undefined && dto.version !== room.version) throw staleVersion();

          const previousStatus = room.status;
          const draftPeople = await this.draftPeople(manager, room.id);
          if (dto.status !== undefined && dto.status !== room.status) {
            if (room.status === RoomStatus.OCCUPIED || room.currentContractId) {
              throw new ConflictException({
                errorCode: SystemErrorCode.BIZ_ROOM_STATUS_TRANSITION_INVALID,
                message: 'An occupied room changes status only through its contract (checkout).',
                details: [{ field: 'status', issue: 'ROOM_OCCUPIED', from: room.status, to: dto.status }],
              });
            }
            if (draftPeople !== null) {
              throw new ConflictException({
                errorCode: SystemErrorCode.BIZ_ROOM_STATUS_TRANSITION_INVALID,
                message: 'The room is reserved by a draft contract; activate or cancel the draft.',
                details: [{ field: 'status', issue: 'ROOM_RESERVED_BY_DRAFT', from: room.status, to: dto.status }],
              });
            }
            room.status = dto.status;
          }
          if (dto.maxOccupants !== undefined && dto.maxOccupants < room.maxOccupants) {
            // Không hạ sức chứa xuống dưới số người đang ở / dự kiến ở (tài liệu 02, mục 5.5.2)
            const people = Math.max(draftPeople ?? 0, await this.activeOccupants(manager, room));
            if (dto.maxOccupants < people) {
              throw new ConflictException({
                errorCode: SystemErrorCode.BIZ_OCCUPANT_LIMIT_EXCEEDED,
                message: `${people} people live (or will live) in this room.`,
                details: [{ field: 'maxOccupants', issue: 'BELOW_CURRENT_OCCUPANTS', occupants: people }],
              });
            }
          }
          if (dto.roomTypeId !== undefined) room.roomTypeId = (await this.findRoomType(manager, dto.roomTypeId)).id;
          if (dto.roomNumber !== undefined && dto.roomNumber !== room.roomNumber) {
            if (await repo.exists({ where: { buildingId: room.buildingId, roomNumber: dto.roomNumber }, withDeleted: true })) {
              throw alreadyExists('roomNumber', dto.roomNumber);
            }
            room.roomNumber = dto.roomNumber;
          }
          if (dto.floor !== undefined) room.floor = dto.floor;
          if (dto.areaSqm !== undefined) room.areaSqm = String(dto.areaSqm);
          if (dto.maxOccupants !== undefined) room.maxOccupants = dto.maxOccupants;
          if (dto.priceOverride !== undefined) room.priceOverride = dto.priceOverride === null ? null : String(dto.priceOverride);
          if (dto.isPubliclyListed !== undefined) room.isPubliclyListed = dto.isPubliclyListed;
          await repo.save(room);

          if (room.status !== previousStatus) {
            await this.outbox.createEventInTransaction(manager, {
              aggregateType: 'ROOM',
              aggregateId: room.id,
              eventType: DOMAIN_EVENTS.ROOM.STATUS_CHANGED,
              payload: { roomId: room.id, roomNumber: room.roomNumber, from: previousStatus, to: room.status },
            });
          }
          return this.loadDetail(manager, room.id);
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err, 'idx_rooms_bld_number_unique')) throw alreadyExists('roomNumber', dto.roomNumber!);
      throw err;
    }
    await this.cache.invalidateTag(ROOMS_TAG);
    return detail;
  }

  // ---------------------------------------------------------------------------

  /** Số người của bản nháp đang giữ phòng (người đứng tên + dự kiến), null = không có bản nháp */
  private async draftPeople(manager: EntityManager, roomId: string): Promise<number | null> {
    const rows: Array<{ people: number }> = await manager.query(
      `SELECT 1 + jsonb_array_length(COALESCE(planned_co_occupants, '[]'::jsonb)) AS people FROM contracts
        WHERE room_id = $1 AND building_id = $2 AND status = 'DRAFT' AND deleted_at IS NULL`,
      [roomId, this.buildingId()],
    );
    return rows.length ? Number(rows[0].people) : null;
  }

  private async activeOccupants(manager: EntityManager, room: Room): Promise<number> {
    if (!room.currentContractId) return 0;
    const [row]: Array<{ n: number }> = await manager.query(
      `SELECT COUNT(*)::int AS n FROM contract_occupants WHERE contract_id = $1 AND building_id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [room.currentContractId, this.buildingId()],
    );
    return Number(row.n);
  }

  private async findRoomType(manager: EntityManager, roomTypeId: string): Promise<RoomType> {
    const roomType = await manager.getRepository(RoomType).findOne({ where: { id: roomTypeId, buildingId: this.buildingId() } });
    if (!roomType) throw notFound('Room type', 'roomTypeId');
    return roomType;
  }

  /** Mandate #2 + D3: phòng, hạng phòng, thiết bị, hợp đồng hiệu lực, người đứng tên, số người ở, tiền cọc - MỘT truy vấn */
  private async loadDetail(manager: EntityManager, roomId: string): Promise<RoomDetail> {
    const { entities, raw } = await manager
      .createQueryBuilder(Room, 'r')
      .innerJoinAndSelect('r.roomType', 'rt')
      .leftJoinAndSelect('r.roomAssets', 'ra', 'ra.deleted_at IS NULL')
      .leftJoinAndSelect('ra.asset', 'a')
      .leftJoinAndSelect('r.currentContract', 'c', `c.status = 'ACTIVE'`)
      .leftJoin('c.primaryTenant', 'pt')
      .addSelect(['pt.id', 'pt.fullName', 'pt.phone'])
      .addSelect(
        `(SELECT COUNT(*) FROM contract_occupants co WHERE co.contract_id = c.id AND co.status = 'ACTIVE' AND co.deleted_at IS NULL)::int`,
        'active_occupant_count',
      )
      .addSelect(`COALESCE((SELECT l.balance_after FROM deposit_ledgers l WHERE l.contract_id = c.id ORDER BY l.entry_no DESC LIMIT 1), 0)`, 'deposit_held')
      .where('r.id = :roomId AND r.building_id = :buildingId', { roomId, buildingId: this.buildingId() })
      .orderBy('a.category', 'ASC')
      .addOrderBy('a.name', 'ASC')
      .addOrderBy('ra.serial_number', 'ASC')
      .getRawAndEntities();
    const room = entities[0];
    if (!room) throw notFound('Room');
    const contract = room.currentContract;

    return {
      id: room.id,
      roomNumber: room.roomNumber,
      floor: room.floor,
      areaSqm: toNumber(room.areaSqm)!,
      maxOccupants: room.maxOccupants,
      status: room.status,
      roomTypeId: room.roomTypeId,
      roomTypeName: room.roomType!.name,
      priceOverride: toNumber(room.priceOverride),
      effectiveRent: toNumber(room.priceOverride ?? room.roomType!.baseMonthlyRent)!,
      activeContract: contract
        ? {
            id: contract.id,
            contractCode: contract.contractCode,
            primaryTenantName: contract.primaryTenant!.fullName,
            primaryTenantPhone: contract.primaryTenant!.phone ?? null,
            occupantCount: Number(raw[0].active_occupant_count),
            monthlyRoomRent: toNumber(contract.monthlyRoomRent)!,
            depositHeld: Number(raw[0].deposit_held),
            startDate: contract.startDate,
            endDate: contract.endDate,
          }
        : null,
      isPubliclyListed: room.isPubliclyListed,
      rentedAssets: (room.roomAssets ?? []).map((ra) => ({
        roomAssetId: ra.id,
        name: ra.asset!.name,
        category: ra.asset!.category,
        serialNumber: ra.serialNumber,
        conditionGrade: ra.conditionGrade,
        monthlyFee: toNumber(ra.customMonthlyFee)!,
      })),
      version: room.version,
    };
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
