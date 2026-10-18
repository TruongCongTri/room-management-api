/**
 * Danh mục thiết bị / nội thất và các đơn vị có số serial lắp trong phòng (tài liệu 02, mục 3.1; tài liệu 04, tag Assets).
 *  - Mọi truy vấn lọc building_id của tòa nhà hiệu lực (lớp 1) trong transaction RLS (lớp 2); FK tổng hợp ở DB (lớp 3)
 *    bảo đảm phòng / danh mục của đơn vị thuộc CÙNG tòa nhà.
 *  - Serial duy nhất trong các đơn vị CÒN lắp (xóa mềm khi thanh lý → serial dùng lại được).
 *  - Website giới thiệu cache danh mục và thiết bị của từng phòng (tag `assets`) → mọi thay đổi danh mục / đơn vị xóa tag
 *    `assets` SAU COMMIT (write()). Chi tiết phòng của nhân viên không cache.
 *  - Module 3: đơn vị đang được thuê theo hợp đồng hiệu lực (contract_assets) sẽ không được chuyển / gỡ.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { Room } from '../../properties/entities/room.entity';
import {
  alreadyExists,
  assertSomethingToUpdate,
  isUniqueViolation,
  notFound,
  staleVersion,
  toNumber,
  vietnamToday,
} from '../../properties/properties.helpers';
import { Asset, AssetCategory } from '../entities/asset.entity';
import { AssetConditionGrade, RoomAsset } from '../entities/room-asset.entity';
import { AssignRoomAssetDto, CreateAssetDto, UpdateAssetDto, UpdateRoomAssetDto } from '../dto/assets.dto';

export interface AssetView {
  id: string;
  code: string;
  name: string;
  category: AssetCategory;
  standardMonthlyRentalFee: number;
  replacementValue: number;
  installedUnits: number;
  version: number;
}

export interface RoomAssetView {
  id: string;
  roomId: string;
  roomNumber: string;
  assetId: string;
  assetName: string;
  category: AssetCategory;
  serialNumber: string;
  conditionGrade: AssetConditionGrade;
  customMonthlyFee: number;
  installedDate: string;
  version: number;
}

const SERIAL_INDEX = 'idx_room_assets_bld_serial_unique';
export const ASSETS_TAG = 'assets';

@Injectable()
export class AssetsService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly cache: RedisCacheService,
  ) {}

  /** Transaction ghi trong RLS, rồi xóa cache công khai chứa thiết bị SAU COMMIT (không nạp lại dữ liệu cũ) */
  private async write<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const result = await this.rls.runInTenantContext(fn);
    await this.cache.invalidateTag(ASSETS_TAG);
    return result;
  }

  // ---------------------------------------------------------------- catalogue

  /** Danh mục + số đơn vị đang lắp: một truy vấn LEFT JOIN … GROUP BY (không N+1) */
  list(category?: AssetCategory): Promise<AssetView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      const qb = manager
        .createQueryBuilder(Asset, 'a')
        .leftJoin(RoomAsset, 'ra', 'ra.asset_id = a.id AND ra.building_id = a.building_id AND ra.deleted_at IS NULL')
        .select('a')
        .addSelect('COUNT(ra.id)::int', 'installedUnits')
        .where('a.building_id = :buildingId', { buildingId: this.buildingId() })
        .groupBy('a.id')
        .orderBy('a.category', 'ASC')
        .addOrderBy('a.name', 'ASC');
      if (category) qb.andWhere('a.category = :category', { category });
      const { entities, raw } = await qb.getRawAndEntities();
      return entities.map((asset, i) => this.assetView(asset, Number(raw[i].installedUnits)));
    });
  }

  async create(dto: CreateAssetDto): Promise<AssetView> {
    try {
      return await this.write(async (manager) => {
        const repo = manager.getRepository(Asset);
        if (await repo.exists({ where: { buildingId: this.buildingId(), code: dto.code } })) throw alreadyExists('code', dto.code);
        const asset = await repo.save(
          repo.create({
            code: dto.code,
            name: dto.name,
            category: dto.category,
            standardMonthlyRentalFee: String(dto.standardMonthlyRentalFee),
            replacementValue: String(dto.replacementValue ?? 0),
          }),
        );
        return this.assetView(asset, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'idx_assets_bld_code_unique')) throw alreadyExists('code', dto.code);
      throw err;
    }
  }

  async update(id: string, dto: UpdateAssetDto): Promise<AssetView> {
    assertSomethingToUpdate(dto);
    return this.write(async (manager) => {
      const repo = manager.getRepository(Asset);
      const asset = await repo.findOne({ where: { id, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
      if (!asset) throw notFound('Asset');
      if (dto.version !== undefined && dto.version !== asset.version) throw staleVersion();
      if (dto.name !== undefined) asset.name = dto.name;
      if (dto.standardMonthlyRentalFee !== undefined) asset.standardMonthlyRentalFee = String(dto.standardMonthlyRentalFee);
      if (dto.replacementValue !== undefined) asset.replacementValue = String(dto.replacementValue);
      const saved = await repo.save(asset);
      const installed = await manager.getRepository(RoomAsset).count({ where: { assetId: id, buildingId: this.buildingId() } });
      return this.assetView(saved, installed);
    });
  }

  // ---------------------------------------------------------------- installed units

  async assign(dto: AssignRoomAssetDto): Promise<RoomAssetView> {
    const installedDate = dto.installedDate ?? vietnamToday();
    if (installedDate > vietnamToday()) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
        message: 'Validation failed for the submitted payload.',
        details: [{ field: 'installedDate', message: 'installedDate cannot be in the future' }],
      });
    }
    try {
      return await this.write(async (manager) => {
        await this.findRoom(manager, dto.roomId);
        const asset = await manager.getRepository(Asset).findOne({ where: { id: dto.assetId, buildingId: this.buildingId() } });
        if (!asset) throw notFound('Asset', 'assetId');
        const repo = manager.getRepository(RoomAsset);
        if (await repo.exists({ where: { buildingId: this.buildingId(), serialNumber: dto.serialNumber, deletedAt: IsNull() } })) {
          throw alreadyExists('serialNumber', dto.serialNumber);
        }
        const unit = await repo.save(
          repo.create({
            roomId: dto.roomId,
            assetId: asset.id,
            serialNumber: dto.serialNumber,
            conditionGrade: dto.conditionGrade ?? AssetConditionGrade.GRADE_A_NEW,
            customMonthlyFee: String(dto.customMonthlyFee ?? toNumber(asset.standardMonthlyRentalFee)),
            installedDate,
          }),
        );
        return this.loadUnit(manager, unit.id);
      });
    } catch (err) {
      if (isUniqueViolation(err, SERIAL_INDEX)) throw alreadyExists('serialNumber', dto.serialNumber);
      throw err;
    }
  }

  async updateUnit(id: string, dto: UpdateRoomAssetDto): Promise<RoomAssetView> {
    assertSomethingToUpdate(dto);
    return this.write(async (manager) => {
      const repo = manager.getRepository(RoomAsset);
      const unit = await repo.findOne({ where: { id, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
      if (!unit) throw notFound('Installed unit');
      if (dto.version !== undefined && dto.version !== unit.version) throw staleVersion();
      if (dto.roomId !== undefined && dto.roomId !== unit.roomId) unit.roomId = (await this.findRoom(manager, dto.roomId)).id;
      if (dto.conditionGrade !== undefined) unit.conditionGrade = dto.conditionGrade;
      if (dto.customMonthlyFee !== undefined) unit.customMonthlyFee = String(dto.customMonthlyFee);
      await repo.save(unit);
      return this.loadUnit(manager, unit.id);
    });
  }

  async removeUnit(id: string): Promise<void> {
    await this.write(async (manager) => {
      const repo = manager.getRepository(RoomAsset);
      const unit = await repo.findOne({ where: { id, buildingId: this.buildingId() } });
      if (!unit) throw notFound('Installed unit');
      await repo.softRemove(unit);
    });
  }

  // ----------------------------------------------------------------

  private async findRoom(manager: EntityManager, roomId: string): Promise<Room> {
    const room = await manager.getRepository(Room).findOne({ where: { id: roomId, buildingId: this.buildingId() } });
    if (!room) throw notFound('Room', 'roomId');
    return room;
  }

  private async loadUnit(manager: EntityManager, id: string): Promise<RoomAssetView> {
    const unit = await manager
      .createQueryBuilder(RoomAsset, 'ra')
      .innerJoinAndSelect('ra.room', 'r')
      .innerJoinAndSelect('ra.asset', 'a')
      .where('ra.id = :id AND ra.building_id = :buildingId', { id, buildingId: this.buildingId() })
      .getOneOrFail();
    return {
      id: unit.id,
      roomId: unit.roomId,
      roomNumber: unit.room!.roomNumber,
      assetId: unit.assetId,
      assetName: unit.asset!.name,
      category: unit.asset!.category,
      serialNumber: unit.serialNumber,
      conditionGrade: unit.conditionGrade,
      customMonthlyFee: toNumber(unit.customMonthlyFee)!,
      installedDate: unit.installedDate,
      version: unit.version,
    };
  }

  private assetView(a: Asset, installedUnits: number): AssetView {
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      category: a.category,
      standardMonthlyRentalFee: toNumber(a.standardMonthlyRentalFee)!,
      replacementValue: toNumber(a.replacementValue)!,
      installedUnits,
      version: a.version,
    };
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
