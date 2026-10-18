/**
 * Tòa nhà (bảng toàn cục): chủ nhà đăng ký, xem và cập nhật tòa nhà CỦA MÌNH (user_building_access - không tin token).
 *  - Tạo tòa nhà + cấp quyền truy cập cho người tạo trong CÙNG transaction.
 *  - Số phòng của từng tòa được đếm trong ngữ cảnh RLS của chính tòa đó (policy chỉ thấy một tòa nhà mỗi lần).
 *  - totalRoomsCapacity không được nhỏ hơn số phòng đã tạo.
 */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { runInBuildingScope } from '../building-scope';
import { PUBLIC_TAG } from './public-listing.service';
import { RLS_CURRENT_BUILDING_VAR } from '../../../core/multitenancy/tenancy.constants';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { UserBuildingAccess } from '../../identity/entities/user-building-access.entity';
import { Building, ElectricityBillingMode } from '../entities/building.entity';
import { CreateBuildingDto, UpdateBuildingDto } from '../dto/properties.dto';
import { alreadyExists, assertSomethingToUpdate, isUniqueViolation, notFound, staleVersion, toNumber } from '../properties.helpers';

export interface BuildingView {
  id: string;
  code: string;
  name: string;
  addressLine: string;
  ward: string;
  district: string;
  city: string;
  landlordTaxCode: string;
  landlordFullName: string;
  bankAccountNumber: string | null;
  bankBinCode: string | null;
  totalRoomsCapacity: number;
  roomCount: number;
  electricityBillingMode: ElectricityBillingMode;
  defaultWaterRatePerM3: number;
  isPubliclyListed: boolean;
  publicSlug: string | null;
  publicDescription: string | null;
  version: number;
}

@Injectable()
export class BuildingsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cache: RedisCacheService,
    private readonly context: RequestContextService,
  ) {}

  async list(actor: RequestUserContext): Promise<BuildingView[]> {
    const ids = await this.accessibleIds(actor.id);
    if (ids.length === 0) return [];
    return this.dataSource.transaction(async (manager) => {
      const buildings = await manager.getRepository(Building).find({ where: { id: In(ids) }, order: { code: 'ASC' } });
      const views: BuildingView[] = [];
      for (const building of buildings) views.push(this.view(building, await this.countRooms(manager, building.id)));
      return views;
    });
  }

  async create(actor: RequestUserContext, dto: CreateBuildingDto): Promise<BuildingView> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (await manager.getRepository(Building).exists({ where: { code: dto.code }, withDeleted: true })) {
          throw alreadyExists('code', dto.code);
        }
        const building = await manager.getRepository(Building).save(
          manager.getRepository(Building).create({
            ...dto,
            defaultWaterRatePerM3: dto.defaultWaterRatePerM3 !== undefined ? String(dto.defaultWaterRatePerM3) : undefined,
          }),
        );
        await manager.getRepository(UserBuildingAccess).insert({ userId: actor.id, buildingId: building.id, grantedBy: actor.id });
        return this.view(building, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'idx_buildings_code_unique')) throw alreadyExists('code', dto.code);
      throw err;
    }
  }

  async update(actor: RequestUserContext, id: string, dto: UpdateBuildingDto): Promise<BuildingView> {
    assertSomethingToUpdate(dto);
    if (!(await this.accessibleIds(actor.id)).includes(id)) throw notFound('Building');

    let view: BuildingView;
    try {
      view = await this.dataSource.transaction(async (manager) => {
      const building = await manager.getRepository(Building).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!building) throw notFound('Building');
      if (dto.version !== undefined && dto.version !== building.version) throw staleVersion();

      const roomCount = await this.countRooms(manager, id);
      if (dto.totalRoomsCapacity !== undefined && dto.totalRoomsCapacity < roomCount) {
        throw new ConflictException({
          errorCode: SystemErrorCode.BIZ_BUILDING_CAPACITY_EXCEEDED,
          message: `The building already has ${roomCount} rooms; capacity cannot be lower.`,
          details: [{ field: 'totalRoomsCapacity', issue: 'BELOW_ROOM_COUNT', roomCount }],
        });
      }

      const { version: _version, defaultWaterRatePerM3, ...changes } = dto;
      Object.assign(building, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
      if (defaultWaterRatePerM3 !== undefined) building.defaultWaterRatePerM3 = String(defaultWaterRatePerM3);
      // Công khai trên website giới thiệu cần slug (cũng được CHECK chk_buildings_listed_has_slug chặn ở DB)
      if (building.isPubliclyListed && !building.publicSlug) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: [{ field: 'publicSlug', message: 'A publicSlug is required to list the building publicly' }],
        });
      }
      if (dto.publicSlug && (await manager.getRepository(Building).exists({ where: { publicSlug: dto.publicSlug, id: Not(id) } }))) {
        throw alreadyExists('publicSlug', dto.publicSlug);
      }
      return this.view(await manager.getRepository(Building).save(building), roomCount);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'idx_buildings_public_slug_unique')) throw alreadyExists('publicSlug', dto.publicSlug!);
      throw err;
    }
    // Hồ sơ công khai (tên, địa chỉ, giá điện nước, trạng thái công khai) của ĐÚNG tòa nhà vừa sửa
    await runInBuildingScope(this.context, id, () => this.cache.invalidateTag(PUBLIC_TAG));
    return view;
  }

  /** Tên tòa nhà cho GET /auth/me (mọi vai trò) */
  async names(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource.getRepository(Building).find({ where: { id: In(ids) }, select: { id: true, name: true } });
    return new Map(rows.map((b) => [b.id, b.name]));
  }

  private async accessibleIds(userId: string): Promise<string[]> {
    const rows = await this.dataSource.getRepository(UserBuildingAccess).find({ where: { userId } });
    return rows.map((r) => r.buildingId);
  }

  /** Đếm phòng của MỘT tòa nhà trong ngữ cảnh RLS của chính tòa đó (set_config cục bộ trong transaction) */
  private async countRooms(manager: EntityManager, buildingId: string): Promise<number> {
    await manager.query('SELECT set_config($1, $2, true)', [RLS_CURRENT_BUILDING_VAR, buildingId]);
    const [{ count }] = await manager.query(
      `SELECT count(*)::int AS count FROM rooms WHERE building_id = $1 AND deleted_at IS NULL`,
      [buildingId],
    );
    return count;
  }

  private view(b: Building, roomCount: number): BuildingView {
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      addressLine: b.addressLine,
      ward: b.ward,
      district: b.district,
      city: b.city,
      landlordTaxCode: b.landlordTaxCode,
      landlordFullName: b.landlordFullName,
      bankAccountNumber: b.bankAccountNumber ?? null,
      bankBinCode: b.bankBinCode ?? null,
      totalRoomsCapacity: b.totalRoomsCapacity,
      roomCount,
      electricityBillingMode: b.electricityBillingMode,
      defaultWaterRatePerM3: toNumber(b.defaultWaterRatePerM3) ?? 0,
      isPubliclyListed: b.isPubliclyListed,
      publicSlug: b.publicSlug ?? null,
      publicDescription: b.publicDescription ?? null,
      version: b.version,
    };
  }
}
