/**
 * Website giới thiệu (module 1b, tài liệu 02 mục 3.1b, tài liệu 04 mục 1.5) - đọc ẨN DANH, chỉ dữ liệu đã công khai:
 *  - Tòa nhà theo slug (bảng toàn cục) → mọi truy vấn khác chạy TRONG phạm vi tòa nhà đó: transaction RLS + lọc building_id
 *    tường minh, cache `cache:{buildingId}:public:*` (tags public / rooms / catalogs / assets) nên mọi thay đổi của nhân viên
 *    xóa đúng các bản cache này.
 *  - Không bao giờ trả id nội bộ, người ở, hợp đồng, serial, giá trị thay thế, thông tin chủ nhà / thuế / ngân hàng;
 *    trạng thái phòng rút gọn còn AVAILABLE / UNAVAILABLE.
 *  - Tòa nhà không tồn tại và tòa nhà chưa công khai trả cùng một 404.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { REGEX_PATTERNS } from '../../../common/constants/regex.constant';
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';
import { AssetCategory } from '../../assets/entities/asset.entity';
import { Building, ElectricityBillingMode } from '../entities/building.entity';
import { PUBLIC_SLUG } from '../dto/properties.dto';
import { PublicAvailability, PublicRoomQueryDto } from '../dto/public-listing.dto';
import { runInBuildingScope } from '../building-scope';
import { notFound, toNumber } from '../properties.helpers';

export const PUBLIC_TAG = 'public';
/** Bản cache công khai bị xóa bởi: cập nhật tòa nhà (public), phòng (rooms), hạng phòng (catalogs), thiết bị (assets) */
const PUBLIC_TAGS = [PUBLIC_TAG, 'rooms', 'catalogs', 'assets'];
const PUBLIC_TTL_SEC = 300;
/** Tiền cọc theo quy định nhà (tài liệu 02, mục 5.1): 1 tháng tiền phòng */
export const DEPOSIT_MONTHS = 1;

/** Điều kiện phòng được công khai - dùng chung cho mọi truy vấn */
const PUBLISHED_ROOMS = `r.building_id = $1 AND r.deleted_at IS NULL AND r.is_publicly_listed`;
const AVAILABILITY_SQL = `CASE WHEN r.status = 'AVAILABLE' THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END`;
const RENT_SQL = `COALESCE(r.price_override, rt.base_monthly_rent)`;

export interface PublicBuildingSummary {
  slug: string;
  name: string;
  district: string;
  city: string;
  totalRooms: number;
  availableRooms: number;
  monthlyRentFrom: number | null;
  monthlyRentTo: number | null;
}

export interface PublicRoomType {
  code: string;
  name: string;
  baseMonthlyRent: number;
  standardAreaSqm: number;
  maxOccupants: number;
  totalRooms: number;
  availableRooms: number;
}

export interface PublicRoomListItem {
  roomNumber: string;
  floor: number;
  roomTypeCode: string;
  roomTypeName: string;
  areaSqm: number;
  maxOccupants: number;
  monthlyRent: number;
  availability: PublicAvailability;
}

const SORT_SQL: Record<PublicRoomQueryDto['sortBy'], string> = {
  monthlyRent: RENT_SQL,
  floor: 'r.floor',
  roomNumber: 'r.room_number',
  areaSqm: 'r.area_sqm',
};

@Injectable()
export class PublicListingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly cache: RedisCacheService,
  ) {}

  /** Danh sách tòa nhà công khai - ghép từ bản tóm tắt cache của TỪNG tòa (luôn mới theo tag của tòa đó) */
  async listBuildings(): Promise<PublicBuildingSummary[]> {
    const buildings = await this.dataSource.getRepository(Building).find({
      where: { isPubliclyListed: true },
      order: { name: 'ASC', publicSlug: 'ASC' },
    });
    const summaries: PublicBuildingSummary[] = [];
    for (const building of buildings) summaries.push(await this.inBuilding(building, 'summary', (m) => this.summary(m, building)));
    return summaries;
  }

  async getBuilding(slug: string) {
    const building = await this.resolvePublished(slug);
    return this.inBuilding(building, 'building', async (m) => {
      const summary = await this.summary(m, building);
      const floors: Array<{ floor: number }> = await m.query(
        `SELECT DISTINCT r.floor FROM rooms r WHERE ${PUBLISHED_ROOMS} ORDER BY r.floor`,
        [building.id],
      );
      return {
        slug: building.publicSlug!,
        name: building.name,
        description: building.publicDescription ?? null,
        addressLine: building.addressLine,
        ward: building.ward,
        district: building.district,
        city: building.city,
        totalRooms: summary.totalRooms,
        availableRooms: summary.availableRooms,
        floors: floors.map((f) => Number(f.floor)),
        roomTypes: await this.roomTypeRows(m, building.id),
        utilities: {
          electricityBillingMode: building.electricityBillingMode as ElectricityBillingMode,
          waterRatePerM3: toNumber(building.defaultWaterRatePerM3)!,
        },
        depositMonths: DEPOSIT_MONTHS,
      };
    });
  }

  async getRoomTypes(slug: string): Promise<PublicRoomType[]> {
    const building = await this.resolvePublished(slug);
    return this.inBuilding(building, 'room-types', (m) => this.roomTypeRows(m, building.id));
  }

  async getVacancies(slug: string) {
    const building = await this.resolvePublished(slug);
    return this.inBuilding(building, 'vacancies', async (m) =>
      (await this.roomTypeRows(m, building.id)).map((t) => ({
        roomTypeCode: t.code,
        roomTypeName: t.name,
        baseMonthlyRent: t.baseMonthlyRent,
        totalRooms: t.totalRooms,
        availableRooms: t.availableRooms,
      })),
    );
  }

  async getFloors(slug: string) {
    const building = await this.resolvePublished(slug);
    return this.inBuilding(building, 'floors', async (m) => {
      const rows: Array<{ floor: number; total: number; available: number; roomNumbers: string[] }> = await m.query(
        `SELECT r.floor,
                count(*)::int AS total,
                count(*) FILTER (WHERE r.status = 'AVAILABLE')::int AS available,
                array_agg(r.room_number ORDER BY r.room_number) AS "roomNumbers"
           FROM rooms r
          WHERE ${PUBLISHED_ROOMS}
          GROUP BY r.floor
          ORDER BY r.floor`,
        [building.id],
      );
      return rows.map((row) => ({ floor: Number(row.floor), totalRooms: row.total, availableRooms: row.available, roomNumbers: row.roomNumbers }));
    });
  }

  async searchRooms(slug: string, query: PublicRoomQueryDto) {
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
        message: 'Validation failed for the submitted payload.',
        details: [{ field: 'minPrice', message: 'minPrice cannot be greater than maxPrice' }],
      });
    }
    const building = await this.resolvePublished(slug);
    const key = `rooms:${createHash('sha1').update(JSON.stringify(query)).digest('hex')}`;
    return this.inBuilding(building, key, async (m) => {
      const where: string[] = [PUBLISHED_ROOMS];
      const params: unknown[] = [building.id];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (query.roomType) add('rt.code = ?', query.roomType);
      if (query.floor !== undefined) add('r.floor = ?', query.floor);
      if (query.availability === PublicAvailability.AVAILABLE) where.push(`r.status = 'AVAILABLE'`);
      if (query.availability === PublicAvailability.UNAVAILABLE) where.push(`r.status <> 'AVAILABLE'`);
      if (query.minPrice !== undefined) add(`${RENT_SQL} >= ?`, query.minPrice);
      if (query.maxPrice !== undefined) add(`${RENT_SQL} <= ?`, query.maxPrice);
      if (query.minAreaSqm !== undefined) add('r.area_sqm >= ?', query.minAreaSqm);
      if (query.occupants !== undefined) add('r.max_occupants >= ?', query.occupants);

      const from = `FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id AND rt.building_id = r.building_id WHERE ${where.join(' AND ')}`;
      const [{ total }] = await m.query(`SELECT count(*)::int AS total ${from}`, params);
      const rows = await m.query(
        `SELECT r.room_number AS "roomNumber", r.floor, rt.code AS "roomTypeCode", rt.name AS "roomTypeName",
                r.area_sqm AS "areaSqm", r.max_occupants AS "maxOccupants", ${RENT_SQL} AS "monthlyRent",
                ${AVAILABILITY_SQL} AS availability
           ${from}
          ORDER BY ${SORT_SQL[query.sortBy]} ${query.sortOrder === 'DESC' ? 'DESC' : 'ASC'}, r.room_number ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
        params,
      );
      return { items: rows.map((row: any) => this.roomItem(row)), total, page: query.page, limit: query.limit };
    });
  }

  async getRoom(slug: string, roomNumber: string) {
    const normalized = (roomNumber ?? '').trim().toUpperCase();
    const building = await this.resolvePublished(slug);
    if (!REGEX_PATTERNS.ROOM_NUMBER.test(normalized)) throw notFound('Room');
    return this.inBuilding(building, `room:${normalized}`, async (m) => {
      const [row] = await m.query(
        `SELECT r.id, r.room_number AS "roomNumber", r.floor, rt.code AS "roomTypeCode", rt.name AS "roomTypeName",
                r.area_sqm AS "areaSqm", r.max_occupants AS "maxOccupants", ${RENT_SQL} AS "monthlyRent",
                ${AVAILABILITY_SQL} AS availability
           FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id AND rt.building_id = r.building_id
          WHERE ${PUBLISHED_ROOMS} AND r.room_number = $2`,
        [building.id, normalized],
      );
      if (!row) throw notFound('Room');
      const equipment = await m.query(
        `SELECT a.name, a.category, ra.condition_grade AS "conditionGrade", ra.custom_monthly_fee AS "monthlyFee"
           FROM room_assets ra JOIN assets a ON a.id = ra.asset_id AND a.building_id = ra.building_id
          WHERE ra.building_id = $1 AND ra.room_id = $2 AND ra.deleted_at IS NULL
          ORDER BY a.category, a.name`,
        [building.id, row.id],
      );
      return {
        ...this.roomItem(row),
        buildingSlug: building.publicSlug!,
        equipment: equipment.map((e: any) => ({ name: e.name, category: e.category, conditionGrade: e.conditionGrade, monthlyFee: Number(e.monthlyFee) })),
        depositMonths: DEPOSIT_MONTHS,
      };
    });
  }

  async getAssets(slug: string, category?: AssetCategory) {
    const building = await this.resolvePublished(slug);
    return this.inBuilding(building, `assets:${category ?? 'ALL'}`, async (m) => {
      const rows = await m.query(
        `SELECT a.name, a.category, a.standard_monthly_rental_fee AS fee,
                count(DISTINCT r.id)::int AS "roomsEquipped"
           FROM assets a
           LEFT JOIN room_assets ra ON ra.asset_id = a.id AND ra.building_id = a.building_id AND ra.deleted_at IS NULL
           LEFT JOIN rooms r ON r.id = ra.room_id AND r.building_id = ra.building_id AND r.deleted_at IS NULL AND r.is_publicly_listed
          WHERE a.building_id = $1 AND a.deleted_at IS NULL ${category ? 'AND a.category = $2' : ''}
          GROUP BY a.id
          ORDER BY a.category, a.name`,
        category ? [building.id, category] : [building.id],
      );
      return rows.map((r: any) => ({ name: r.name, category: r.category, standardMonthlyRentalFee: Number(r.fee), roomsEquipped: r.roomsEquipped }));
    });
  }

  // ---------------------------------------------------------------------------

  /** Slug sai định dạng, không tồn tại hoặc chưa công khai → cùng một 404 (không dò được tòa nhà chưa công khai) */
  private async resolvePublished(slug: string): Promise<Building> {
    const normalized = (slug ?? '').trim().toLowerCase();
    const building = PUBLIC_SLUG.test(normalized)
      ? await this.dataSource.getRepository(Building).findOne({ where: { publicSlug: normalized, isPubliclyListed: true } })
      : null;
    if (!building) throw notFound('Building');
    return building;
  }

  /** Cache + RLS trong phạm vi của đúng tòa nhà công khai */
  private inBuilding<T>(building: Building, key: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return runInBuildingScope(this.context, building.id, () =>
      this.cache.getOrSet(`public:${key}`, () => this.rls.runInTenantContext(fn), { ttlSeconds: PUBLIC_TTL_SEC, tags: PUBLIC_TAGS }),
    );
  }

  private async summary(m: EntityManager, building: Building): Promise<PublicBuildingSummary> {
    const [row] = await m.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r.status = 'AVAILABLE')::int AS available,
              min(${RENT_SQL}) AS "rentFrom", max(${RENT_SQL}) AS "rentTo"
         FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id AND rt.building_id = r.building_id
        WHERE ${PUBLISHED_ROOMS}`,
      [building.id],
    );
    return {
      slug: building.publicSlug!,
      name: building.name,
      district: building.district,
      city: building.city,
      totalRooms: row.total,
      availableRooms: row.available,
      monthlyRentFrom: toNumber(row.rentFrom),
      monthlyRentTo: toNumber(row.rentTo),
    };
  }

  /** Hạng phòng có ít nhất một phòng công khai, kèm số phòng / phòng trống */
  private async roomTypeRows(m: EntityManager, buildingId: string): Promise<PublicRoomType[]> {
    const rows = await m.query(
      `SELECT rt.code, rt.name, rt.base_monthly_rent AS rent, rt.standard_area_sqm AS area, rt.default_max_occupants AS "maxOccupants",
              count(r.id)::int AS total, count(r.id) FILTER (WHERE r.status = 'AVAILABLE')::int AS available
         FROM room_types rt
         JOIN rooms r ON r.room_type_id = rt.id AND ${PUBLISHED_ROOMS}
        WHERE rt.building_id = $1 AND rt.deleted_at IS NULL
        GROUP BY rt.id
        ORDER BY rt.base_monthly_rent, rt.code`,
      [buildingId],
    );
    return rows.map((r: any) => ({
      code: r.code,
      name: r.name,
      baseMonthlyRent: Number(r.rent),
      standardAreaSqm: Number(r.area),
      maxOccupants: r.maxOccupants,
      totalRooms: r.total,
      availableRooms: r.available,
    }));
  }

  private roomItem(row: any): PublicRoomListItem {
    return {
      roomNumber: row.roomNumber,
      floor: Number(row.floor),
      roomTypeCode: row.roomTypeCode,
      roomTypeName: row.roomTypeName,
      areaSqm: Number(row.areaSqm),
      maxOccupants: row.maxOccupants,
      monthlyRent: Number(row.monthlyRent),
      availability: row.availability,
    };
  }
}
