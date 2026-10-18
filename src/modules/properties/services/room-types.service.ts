/**
 * Hạng phòng & giá chuẩn của tòa nhà hiệu lực. Danh sách được cache `cache:{buildingId}:catalogs:pricing` (24 giờ,
 * tài liệu 03 Mandate #4) và bị xóa qua tag `catalogs`; đổi giá còn xóa tag `rooms` (danh sách / chi tiết phòng hiển thị giá).
 */
import { Injectable } from '@nestjs/common';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { RoomType } from '../entities/room-type.entity';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from '../dto/properties.dto';
import { alreadyExists, assertSomethingToUpdate, isUniqueViolation, notFound, staleVersion, toNumber } from '../properties.helpers';

export const ROOM_TYPES_CACHE_KEY = 'catalogs:pricing';
export const CATALOGS_TAG = 'catalogs';
export const ROOMS_TAG = 'rooms';

export interface RoomTypeView {
  id: string;
  code: string;
  name: string;
  baseMonthlyRent: number;
  standardAreaSqm: number;
  defaultMaxOccupants: number;
  version: number;
}

@Injectable()
export class RoomTypesService {
  constructor(
    private readonly rls: RlsService,
    private readonly cache: RedisCacheService,
    private readonly context: RequestContextService,
  ) {}

  list(): Promise<RoomTypeView[]> {
    return this.cache.getOrSet(
      ROOM_TYPES_CACHE_KEY,
      () =>
        this.rls.runInTenantContext(async (manager) => {
          const rows = await manager.getRepository(RoomType).find({
            where: { buildingId: this.buildingId() },
            order: { baseMonthlyRent: 'ASC', code: 'ASC' },
          });
          return rows.map((rt) => this.view(rt));
        }),
      { ttlSeconds: 86_400, tags: [CATALOGS_TAG] },
    );
  }

  async create(dto: CreateRoomTypeDto): Promise<RoomTypeView> {
    try {
      const created = await this.rls.runInTenantContext(async (manager) => {
        const repo = manager.getRepository(RoomType);
        if (await repo.exists({ where: { buildingId: this.buildingId(), code: dto.code } })) throw alreadyExists('code', dto.code);
        return repo.save(
          repo.create({
            code: dto.code,
            name: dto.name,
            baseMonthlyRent: String(dto.baseMonthlyRent),
            standardAreaSqm: String(dto.standardAreaSqm),
            defaultMaxOccupants: dto.defaultMaxOccupants ?? 2,
          }),
        );
      });
      await this.cache.invalidateTag(CATALOGS_TAG);
      return this.view(created);
    } catch (err) {
      if (isUniqueViolation(err, 'idx_room_types_bld_code_unique')) throw alreadyExists('code', dto.code);
      throw err;
    }
  }

  async update(id: string, dto: UpdateRoomTypeDto): Promise<RoomTypeView> {
    assertSomethingToUpdate(dto);
    const updated = await this.rls.runInTenantContext(async (manager) => {
      const repo = manager.getRepository(RoomType);
      const roomType = await repo.findOne({ where: { id, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
      if (!roomType) throw notFound('Room type');
      if (dto.version !== undefined && dto.version !== roomType.version) throw staleVersion();
      if (dto.name !== undefined) roomType.name = dto.name;
      if (dto.baseMonthlyRent !== undefined) roomType.baseMonthlyRent = String(dto.baseMonthlyRent);
      if (dto.standardAreaSqm !== undefined) roomType.standardAreaSqm = String(dto.standardAreaSqm);
      if (dto.defaultMaxOccupants !== undefined) roomType.defaultMaxOccupants = dto.defaultMaxOccupants;
      return repo.save(roomType);
    });
    // Sau COMMIT: request đọc song song không thể nạp lại giá cũ vào cache
    await Promise.all([this.cache.invalidateTag(CATALOGS_TAG), this.cache.invalidateTag(ROOMS_TAG)]);
    return this.view(updated);
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }

  private view(rt: RoomType): RoomTypeView {
    return {
      id: rt.id,
      code: rt.code,
      name: rt.name,
      baseMonthlyRent: toNumber(rt.baseMonthlyRent)!,
      standardAreaSqm: toNumber(rt.standardAreaSqm)!,
      defaultMaxOccupants: rt.defaultMaxOccupants,
      version: rt.version,
    };
  }
}
