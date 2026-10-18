/**
 * Module 1 - Properties & Assets qua HTTP trên PostgreSQL + Redis THẬT, ứng dụng chạy bằng role app_user
 * (RLS có hiệu lực thật). Dữ liệu mẫu dựng bằng kết nối owner riêng.
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e -- properties
 */
import './disable-outbox-poller';
import './properties-e2e-env';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/core/config/app-config.service';
import { REDIS_CLIENT } from '../src/core/redis/redis.constants';
import { runSeeds } from '../src/core/database/seed-runner';
import { JwtTokenService } from '../src/core/security/jwt/jwt-token.service';
import { OCCUPANCY_SELF_SCOPE, OccupancySelfScope, OccupancySelfScopeService } from '../src/core/access-control/occupancy-self-scope';
import { FeatureFlagService } from '../src/core/feature-flag/feature-flag.service';

/** Số điện thoại duy nhất (E.164 15 chữ số, tăng dần): test DB giữ dữ liệu giữa các lần chạy nên không dùng số ngẫu nhiên ngắn */
let phoneCounter = 0;
const uniquePhone = () => `+${Date.now()}${String(phoneCounter++ % 100).padStart(2, '0')}`;

const unique = () => randomUUID().slice(0, 8).toUpperCase();

describe('Properties & Assets (HTTP, real PostgreSQL as app_user + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let owner: DataSource; // superuser postgres: dữ liệu mẫu & kiểm tra ràng buộc kernel
  let appDs: DataSource; // app_user: kết nối của chính ứng dụng
  let redis: Redis;
  let tokens: JwtTokenService;
  const residences = new Map<string, OccupancySelfScope>();

  // ---------------------------------------------------------------- fixtures
  const createUser = async (roles: string[], buildingIds: string[]) => {
    const [{ id }] = await owner.query(
      `INSERT INTO users (phone_e164, full_name, status, password_hash)
       VALUES ($2, $1, 'ACTIVE', 'x') RETURNING id`,
      [`e2e ${roles.join('+')}`, uniquePhone()],
    );
    for (const role of roles) await owner.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
    for (const b of buildingIds) await owner.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, b]);
    const token = await tokens.signAccessToken({ sub: id, buildingId: buildingIds[0], buildingIds, roles });
    return { id, token, auth: { Authorization: `Bearer ${token}` } };
  };

  const createBuildingRow = async (capacity = 80) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name, total_rooms_capacity)
       VALUES ($1, $2, 'E2E building', '1 Đường A', 'P1', 'Q1', '0312345678', 'Chủ nhà', $3)`,
      [id, `E2E-${unique()}`, capacity],
    );
    return id;
  };

  /** Một tòa nhà đầy đủ: chủ nhà, quản lý, kế toán, bảo vệ, khách thuê; 2 hạng phòng */
  const createWorld = async (capacity = 80) => {
    const buildingId = await createBuildingRow(capacity);
    const [landlord, pm, accountant, guard, tenant] = await Promise.all([
      createUser(['LANDLORD'], [buildingId]),
      createUser(['PROPERTY_MANAGER'], [buildingId]),
      createUser(['ACCOUNTANT'], [buildingId]),
      createUser(['GUARD'], [buildingId]),
      createUser(['TENANT'], [buildingId]),
    ]);
    const h = (user: { auth: Record<string, string> }) => ({ ...user.auth, 'X-Building-ID': buildingId });
    const studio = (
      await http.post('/api/v1/properties/room-types').set(h(pm)).set('Idempotency-Key', randomUUID())
        .send({ code: 'studio', name: 'Studio', baseMonthlyRent: 6_500_000, standardAreaSqm: 28.5, defaultMaxOccupants: 2 })
        .expect(201)
    ).body.data;
    const duplex = (
      await http.post('/api/v1/properties/room-types').set(h(pm)).set('Idempotency-Key', randomUUID())
        .send({ code: 'DUPLEX', name: 'Duplex', baseMonthlyRent: 12_000_000, standardAreaSqm: 55, defaultMaxOccupants: 4 })
        .expect(201)
    ).body.data;
    return { buildingId, landlord, pm, accountant, guard, tenant, h, studio, duplex };
  };

  type World = Awaited<ReturnType<typeof createWorld>>;

  const createRoom = (w: World, body: Record<string, unknown>) =>
    http.post('/api/v1/properties/rooms').set(w.h(w.pm)).set('Idempotency-Key', randomUUID()).send(body);

  const roomIn = async (w: World, roomNumber: string, extra: Record<string, unknown> = {}) =>
    (await createRoom(w, { roomNumber, floor: 1, areaSqm: 30, roomTypeId: w.studio.id, ...extra }).expect(201)).body.data;

  const createAsset = async (w: World, body: Record<string, unknown> = {}) =>
    (
      await http.post('/api/v1/assets').set(w.h(w.pm)).set('Idempotency-Key', randomUUID())
        .send({ code: `AC_${unique()}`, name: 'Máy lạnh Daikin 1.5 HP', category: 'APPLIANCE', standardMonthlyRentalFee: 300_000, replacementValue: 9_500_000, ...body })
        .expect(201)
    ).body.data;

  const install = (w: World, body: Record<string, unknown>) =>
    http.post('/api/v1/assets/room-assignments').set(w.h(w.pm)).set('Idempotency-Key', randomUUID()).send(body);

  beforeAll(async () => {
    const fakeResolver = { resolve: async (userId: string, buildingId: string) => residences.get(`${buildingId}:${userId}`) ?? null };
    // Thay resolver thật của ContractsModule: ai đang ở phòng nào do test quyết định (kiểm tra riêng RoomAccessGuard).
    // Luồng thật (hợp đồng → người ở → phòng) được kiểm tra trong contracts.e2e-spec.ts.
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OCCUPANCY_SELF_SCOPE)
      .useValue(fakeResolver)
      .compile();
    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
    appDs = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    tokens = app.get(JwtTokenService);

    const db = app.get(AppConfigService).database.master;
    owner = new DataSource({ type: 'postgres', host: db.host, port: db.port, database: db.database, username: 'postgres', password: 'postgres' });
    await owner.initialize();
    expect(await runSeeds()).toBe(0);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('should really run as a role that is subject to RLS', async () => {
    const [{ current_user, rolsuper, rolbypassrls }] = await appDs.query(
      `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect({ current_user, rolsuper, rolbypassrls }).toEqual({ current_user: 'app_user', rolsuper: false, rolbypassrls: false });
  });

  // ===========================================================================
  // Buildings
  // ===========================================================================
  describe('Buildings (landlord)', () => {
    const newBuilding = (code: string) => ({
      code,
      name: 'Tòa nhà Sunrise',
      addressLine: '12 Nguyễn Thị Thập',
      ward: 'Phường Tân Phú',
      district: 'Quận 7',
      landlordTaxCode: '0312345678',
      landlordFullName: 'Nguyễn Văn Chủ',
      bankAccountNumber: '0071000123456',
      bankBinCode: '970436',
    });

    it('should register a building, grant the creator access, and refuse a duplicate code', async () => {
      const home = await createBuildingRow();
      const landlord = await createUser(['LANDLORD'], [home]);
      const code = `bld-${unique()}`;
      const res = await http.post('/api/v1/properties/buildings').set(landlord.auth).set('Idempotency-Key', randomUUID()).send(newBuilding(code)).expect(201);
      expect(res.body.data).toMatchObject({ code: code.toUpperCase(), totalRoomsCapacity: 80, roomCount: 0, electricityBillingMode: 'EVN_TIERED_QUOTA', defaultWaterRatePerM3: 25000, city: 'Thành phố Hồ Chí Minh' });

      const access = await owner.query(`SELECT 1 FROM user_building_access WHERE user_id = $1 AND building_id = $2`, [landlord.id, res.body.data.id]);
      expect(access).toHaveLength(1);

      const dup = await http.post('/api/v1/properties/buildings').set(landlord.auth).set('Idempotency-Key', randomUUID()).send(newBuilding(code.toLowerCase())).expect(409);
      expect(dup.body).toMatchObject({ errorCode: 'RES_ALREADY_EXISTS', details: [{ field: 'code' }] });
    });

    it('should be reserved to landlords and validate the payload', async () => {
      const w = await createWorld();
      await http.post('/api/v1/properties/buildings').set(w.pm.auth).set('Idempotency-Key', randomUUID()).send(newBuilding(`B-${unique()}`)).expect(403);
      await http.get('/api/v1/properties/buildings').set(w.accountant.auth).expect(403);
      await http.post('/api/v1/properties/buildings').set(w.landlord.auth).set('Idempotency-Key', randomUUID()).send({ ...newBuilding(`B-${unique()}`), landlordTaxCode: '123' }).expect(400);
      await http.post('/api/v1/properties/buildings').set(w.landlord.auth).send(newBuilding(`B-${unique()}`)).expect(400); // Idempotency-Key
    });

    it("should list only the landlord's buildings, each with its room count counted under its own RLS context", async () => {
      const a = await createWorld();
      const b = await createWorld();
      await roomIn(a, 'A-1');
      await roomIn(a, 'A-2');
      await roomIn(b, 'B-1');
      const landlord = await createUser(['LANDLORD'], [a.buildingId, b.buildingId]);
      const list = (await http.get('/api/v1/properties/buildings').set(landlord.auth).expect(200)).body.data;
      const counts = Object.fromEntries(list.map((x: any) => [x.id, x.roomCount]));
      expect(counts).toEqual({ [a.buildingId]: 2, [b.buildingId]: 1 });
      // Chủ nhà của tòa a không thấy tòa b
      expect((await http.get('/api/v1/properties/buildings').set(a.landlord.auth).expect(200)).body.data.map((x: any) => x.id)).toEqual([a.buildingId]);
    });

    it('should not lower the capacity below the rooms already created, and guard other landlords and stale versions', async () => {
      const w = await createWorld();
      await roomIn(w, 'P.101');
      await roomIn(w, 'P.102');
      const patch = (body: object, auth = w.landlord.auth) => http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(auth).send(body);

      const below = await patch({ totalRoomsCapacity: 1 }).expect(409);
      expect(below.body).toMatchObject({ errorCode: 'BIZ_BUILDING_CAPACITY_EXCEEDED', details: [{ roomCount: 2 }] });
      const ok = (await patch({ totalRoomsCapacity: 2, bankAccountNumber: null, version: 1 }).expect(200)).body.data;
      expect(ok).toMatchObject({ totalRoomsCapacity: 2, bankAccountNumber: null, version: 2 });
      expect((await patch({ name: 'Stale', version: 1 }).expect(409)).body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');

      const stranger = await createUser(['LANDLORD'], [await createBuildingRow()]);
      await patch({ name: 'Hijack' }, stranger.auth).expect(404);
      await patch({}).expect(400);
      await patch({ code: 'NEW' }).expect(400);
    });

    it('should show building names in /auth/me', async () => {
      const w = await createWorld();
      const me = (await http.get('/api/v1/auth/me').set(w.pm.auth).expect(200)).body.data;
      expect(me.buildings).toEqual([{ id: w.buildingId, name: 'E2E building' }]);
    });
  });

  // ===========================================================================
  // Room types
  // ===========================================================================
  describe('Room types', () => {
    it('should normalise codes, refuse duplicates and validate prices', async () => {
      const w = await createWorld();
      expect(w.studio).toMatchObject({ code: 'STUDIO', baseMonthlyRent: 6500000, standardAreaSqm: 28.5, defaultMaxOccupants: 2, version: 1 });
      const post = (body: object) => http.post('/api/v1/properties/room-types').set(w.h(w.pm)).set('Idempotency-Key', randomUUID()).send(body);
      expect((await post({ code: 'Studio', name: 'Again', baseMonthlyRent: 1, standardAreaSqm: 10 }).expect(409)).body.errorCode).toBe('RES_ALREADY_EXISTS');
      await post({ code: 'X1', name: 'Free', baseMonthlyRent: 0, standardAreaSqm: 10 }).expect(400);
      await post({ code: 'X2', name: 'Cents', baseMonthlyRent: 6_500_000.5, standardAreaSqm: 10 }).expect(400);
    });

    it('should serve the list from cache and evict it when a room type changes', async () => {
      const w = await createWorld();
      const list = () => http.get('/api/v1/properties/room-types').set(w.h(w.guard)).expect(200);
      expect((await list()).body.data.map((t: any) => t.code)).toEqual(['STUDIO', 'DUPLEX']);

      // Sửa thẳng trong DB (bỏ qua API) → danh sách vẫn là bản cache
      await owner.query(`UPDATE room_types SET name = 'Changed behind the API' WHERE id = $1`, [w.studio.id]);
      expect((await list()).body.data[0].name).toBe('Studio');

      await http.patch(`/api/v1/properties/room-types/${w.duplex.id}`).set(w.h(w.pm)).send({ baseMonthlyRent: 13_000_000 }).expect(200);
      const fresh = (await list()).body.data;
      expect(fresh[0].name).toBe('Changed behind the API');
      expect(fresh[1].baseMonthlyRent).toBe(13000000);
    });

    it('should move rooms without a price override to the new base rent, and leave overridden rooms alone', async () => {
      const w = await createWorld();
      const plain = await roomIn(w, 'P.201');
      const special = await roomIn(w, 'P.202', { priceOverride: 7_000_000 });
      await http.patch(`/api/v1/properties/room-types/${w.studio.id}`).set(w.h(w.pm)).send({ baseMonthlyRent: 6_800_000, version: 1 }).expect(200);
      const rooms = (await http.get('/api/v1/properties/rooms').set(w.h(w.pm)).expect(200)).body.data;
      expect(Object.fromEntries(rooms.map((r: any) => [r.id, r.effectivePrice]))).toEqual({ [plain.id]: 6800000, [special.id]: 7000000 });
      await http.patch(`/api/v1/properties/room-types/${w.studio.id}`).set(w.h(w.pm)).send({ name: 'x', version: 1 }).expect(409);
    });
  });

  // ===========================================================================
  // Rooms
  // ===========================================================================
  describe('Rooms', () => {
    it('should create a room with defaults from its room type', async () => {
      const w = await createWorld();
      const room = await roomIn(w, ' p.302 ', { floor: 3, areaSqm: 32.5, roomTypeId: w.duplex.id });
      expect(room).toMatchObject({
        roomNumber: 'P.302',
        floor: 3,
        areaSqm: 32.5,
        maxOccupants: 4,
        status: 'AVAILABLE',
        roomTypeId: w.duplex.id,
        roomTypeName: 'Duplex',
        priceOverride: null,
        effectiveRent: 12000000,
        activeContract: null,
        rentedAssets: [],
        version: 1,
      });
      expect((await createRoom(w, { roomNumber: 'P.302', floor: 3, areaSqm: 30, roomTypeId: w.studio.id }).expect(409)).body.details).toEqual([
        { field: 'roomNumber', issue: 'ALREADY_EXISTS' },
      ]);
    });

    it('should never exceed the building capacity, even with simultaneous requests for the last slot', async () => {
      const w = await createWorld(3);
      await roomIn(w, 'R1');
      await roomIn(w, 'R2');
      const results = await Promise.all(
        ['R3', 'R4', 'R5'].map((n) => createRoom(w, { roomNumber: n, floor: 1, areaSqm: 20, roomTypeId: w.studio.id })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.errorCode === 'BIZ_BUILDING_CAPACITY_EXCEEDED')).toBe(true);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM rooms WHERE building_id = $1`, [w.buildingId]);
      expect(n).toBe(3);
    });

    it("should refuse another building's room type (404 in the API, composite FK in the database)", async () => {
      const a = await createWorld();
      const b = await createWorld();
      const res = await createRoom(a, { roomNumber: 'X1', floor: 1, areaSqm: 20, roomTypeId: b.studio.id }).expect(404);
      expect(res.body.details).toEqual([{ field: 'roomTypeId', issue: 'NOT_FOUND' }]);
      await expect(
        owner.query(`INSERT INTO rooms (building_id, room_number, floor, area_sqm, room_type_id) VALUES ($1, 'RAW', 1, 20, $2)`, [a.buildingId, b.studio.id]),
      ).rejects.toThrow(/fk_rooms_room_type_same_building/);
    });

    it('should enforce physical limits in the database even for raw SQL', async () => {
      const w = await createWorld();
      for (const [sql, constraint] of [
        [`INSERT INTO rooms (building_id, room_number, floor, area_sqm, room_type_id) VALUES ($1, 'F31', 31, 20, $2)`, 'chk_rooms_floor'],
        [`INSERT INTO rooms (building_id, room_number, floor, area_sqm, room_type_id) VALUES ($1, 'A0', 1, 0, $2)`, 'chk_rooms_area'],
        [`INSERT INTO rooms (building_id, room_number, floor, area_sqm, room_type_id, price_override) VALUES ($1, 'P0', 1, 20, $2, 0)`, 'chk_rooms_price_override'],
      ]) {
        await expect(owner.query(sql, [w.buildingId, w.studio.id])).rejects.toThrow(new RegExp(constraint));
      }
    });

    it('should list rooms with filters, sorting and pagination, projecting exactly 6 fields', async () => {
      const w = await createWorld();
      await roomIn(w, 'P.101', { floor: 1 });
      await roomIn(w, 'P.201', { floor: 2, roomTypeId: w.duplex.id });
      await roomIn(w, 'P.202', { floor: 2, priceOverride: 9_000_000 });
      const maintenance = await roomIn(w, 'P.301', { floor: 3 });
      await http.patch(`/api/v1/properties/rooms/${maintenance.id}`).set(w.h(w.pm)).send({ status: 'MAINTENANCE' }).expect(200);

      const list = (query: object) => http.get('/api/v1/properties/rooms').query(query).set(w.h(w.guard));
      const byPrice = (await list({ sortBy: 'effectivePrice', sortOrder: 'DESC' }).expect(200)).body;
      expect(byPrice.data.map((r: any) => r.roomNumber)).toEqual(['P.201', 'P.202', 'P.101', 'P.301']);
      expect(Object.keys(byPrice.data[0]).sort()).toEqual(['effectivePrice', 'floor', 'id', 'roomNumber', 'roomTypeName', 'status']);

      expect((await list({ floor: 2 }).expect(200)).body.data.map((r: any) => r.roomNumber)).toEqual(['P.201', 'P.202']);
      expect((await list({ status: 'MAINTENANCE' }).expect(200)).body.data.map((r: any) => r.roomNumber)).toEqual(['P.301']);
      expect((await list({ roomTypeId: w.duplex.id }).expect(200)).body.data).toHaveLength(1);

      const page2 = (await list({ limit: 3, page: 2 }).expect(200)).body;
      expect(page2.data.map((r: any) => r.roomNumber)).toEqual(['P.301']);
      expect(page2.meta.pagination).toMatchObject({ page: 2, limit: 3, totalItems: 4, totalPages: 2, hasNextPage: false, hasPreviousPage: true });

      await list({ floor: 31 }).expect(400);
      await list({ sortBy: 'tenant' }).expect(400);
      await list({ status: 'EMPTY' }).expect(400);
    });

    it('should use the building indexes for the room directory (no sequential scan needed)', async () => {
      const w = await createWorld();
      await owner.query('BEGIN');
      try {
        await owner.query('SET LOCAL enable_seqscan = off');
        const plan = (
          await owner.query(
            `EXPLAIN SELECT id, room_number, price_override FROM rooms WHERE building_id = $1 AND status = 'AVAILABLE' AND room_type_id = $2 AND deleted_at IS NULL`,
            [w.buildingId, w.studio.id],
          )
        ).map((r: any) => r['QUERY PLAN']).join('\n');
        expect(plan).toMatch(/Index (Only )?Scan using idx_rooms_(available_covering|bld_status_type)/);
        expect(plan).not.toMatch(/Seq Scan/);
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('should isolate buildings: wrong header refused, other building ids invisible, nothing visible without a context', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const roomB = await roomIn(b, 'B-SECRET');

      await http.get('/api/v1/properties/rooms').set({ ...a.pm.auth, 'X-Building-ID': b.buildingId }).expect(403);
      await http.get(`/api/v1/properties/rooms/${roomB.id}`).set(a.h(a.pm)).expect(404);
      await http.patch(`/api/v1/properties/rooms/${roomB.id}`).set(a.h(a.pm)).send({ status: 'MAINTENANCE' }).expect(404);
      expect((await http.get('/api/v1/properties/rooms').query({ limit: 100 }).set(a.h(a.pm)).expect(200)).body.data.map((r: any) => r.id)).not.toContain(roomB.id);

      // app_user không có ngữ cảnh tòa nhà → RLS trả về 0 dòng (fail-closed)
      const [{ n }] = await appDs.query(`SELECT count(*)::int AS n FROM rooms`);
      expect(n).toBe(0);
    });

    it('should change status, publish room.status_changed in the same transaction, and refuse OCCUPIED rooms', async () => {
      const w = await createWorld();
      const room = await roomIn(w, 'P.401');
      const patch = (body: object) => http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm)).send(body);

      const updated = (await patch({ status: 'MAINTENANCE', version: 1 }).expect(200)).body.data;
      expect(updated).toMatchObject({ status: 'MAINTENANCE', version: 2 });
      const events = await owner.query(`SELECT event_type, payload, status FROM outbox_events WHERE aggregate_id = $1`, [room.id]);
      expect(events).toEqual([
        { event_type: 'room.status_changed', payload: { roomId: room.id, roomNumber: 'P.401', from: 'AVAILABLE', to: 'MAINTENANCE' }, status: 'PENDING' },
      ]);

      // Không có thay đổi trạng thái → không có sự kiện
      await patch({ priceOverride: 7_500_000 }).expect(200);
      expect(await owner.query(`SELECT 1 FROM outbox_events WHERE aggregate_id = $1`, [room.id])).toHaveLength(1);

      await patch({ status: 'OCCUPIED' }).expect(400);
      await owner.query(`UPDATE rooms SET status = 'OCCUPIED' WHERE id = $1`, [room.id]); // như sau kích hoạt hợp đồng (module 3)
      const refused = await patch({ status: 'AVAILABLE' }).expect(409);
      expect(refused.body).toMatchObject({ errorCode: 'BIZ_ROOM_STATUS_TRANSITION_INVALID', details: [{ from: 'OCCUPIED', to: 'AVAILABLE' }] });
      // Giá vẫn đổi được khi phòng đang có người thuê (hợp đồng giữ giá đã thỏa thuận)
      await patch({ priceOverride: null }).expect(200);
    });

    it('should validate updates: price reset, room number clash, stale version, empty body, other room types', async () => {
      const w = await createWorld();
      const room = await roomIn(w, 'P.501', { priceOverride: 9_999_000 });
      await roomIn(w, 'P.502');
      const patch = (body: object) => http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm)).send(body);

      expect((await patch({ priceOverride: null }).expect(200)).body.data).toMatchObject({ priceOverride: null, effectiveRent: 6500000 });
      expect((await patch({ roomNumber: 'p.502' }).expect(409)).body.errorCode).toBe('RES_ALREADY_EXISTS');
      expect((await patch({ floor: 6, version: 1 }).expect(409)).body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');
      await patch({ version: 2 }).expect(400);
      await patch({}).expect(400);
      expect((await patch({ roomTypeId: randomUUID() }).expect(404)).body.details[0].field).toBe('roomTypeId');
      expect((await patch({ roomTypeId: w.duplex.id, maxOccupants: 3 }).expect(200)).body.data).toMatchObject({ roomTypeName: 'Duplex', maxOccupants: 3, effectiveRent: 12000000 });
    });

    it('should refuse a status change while the room contract lock is held (contract activation in progress)', async () => {
      const w = await createWorld();
      const room = await roomIn(w, 'P.601');
      await redis.set(`lock:${w.buildingId}:room:contract:${room.id}`, 'activation-in-progress', 'PX', 30_000);
      const res = await http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm)).send({ status: 'RESERVED' });
      expect(res.status).toBe(409);
      expect(res.body.errorCode).toBe('RES_LOCKED');
      expect((await owner.query(`SELECT status FROM rooms WHERE id = $1`, [room.id]))[0].status).toBe('AVAILABLE');
    });

    it('should enforce the permission matrix on rooms', async () => {
      const w = await createWorld();
      const room = await roomIn(w, 'P.701');
      await http.get('/api/v1/properties/rooms').set(w.h(w.accountant)).expect(200);
      await http.get('/api/v1/properties/rooms').set(w.h(w.tenant)).expect(403);
      await createRoom({ ...w, pm: w.guard } as World, { roomNumber: 'G1', floor: 1, areaSqm: 20, roomTypeId: w.studio.id }).expect(403);
      await http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.accountant)).send({ status: 'RESERVED' }).expect(403);
      await http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.landlord)).send({ status: 'RESERVED' }).expect(200);
    });
  });

  // ===========================================================================
  // Vacancy summary (XFetch cache + tag eviction)
  // ===========================================================================
  describe('Vacancy summary', () => {
    it('should aggregate per room type (including types without rooms) and refresh after a room change', async () => {
      const w = await createWorld();
      await roomIn(w, 'V1');
      await roomIn(w, 'V2');
      const v3 = await roomIn(w, 'V3');
      const summary = async () => (await http.get('/api/v1/properties/rooms/vacancies/summary').set(w.h(w.accountant)).expect(200)).body.data;

      expect(await summary()).toEqual([
        { roomTypeId: w.studio.id, roomTypeName: 'Studio', basePrice: 6500000, totalRooms: 3, availableRooms: 3, occupiedRooms: 0, maintenanceRooms: 0, occupancyPercentage: 0 },
        { roomTypeId: w.duplex.id, roomTypeName: 'Duplex', basePrice: 12000000, totalRooms: 0, availableRooms: 0, occupiedRooms: 0, maintenanceRooms: 0, occupancyPercentage: 0 },
      ]);
      expect(await redis.exists(`cache:${w.buildingId}:${'rooms:vacancies:summary'}`)).toBe(1);

      // Hợp đồng (module 3) chuyển phòng sang OCCUPIED và xóa tag; ở đây mô phỏng bằng SQL + một thay đổi qua API
      await owner.query(`UPDATE rooms SET status = 'OCCUPIED' WHERE id = $1`, [v3.id]);
      expect((await summary())[0].occupiedRooms).toBe(0); // vẫn là bản cache
      const v1 = (await http.get('/api/v1/properties/rooms').query({ limit: 1 }).set(w.h(w.pm))).body.data[0];
      await http.patch(`/api/v1/properties/rooms/${v1.id}`).set(w.h(w.pm)).send({ status: 'MAINTENANCE' }).expect(200);
      expect((await summary())[0]).toMatchObject({ availableRooms: 1, occupiedRooms: 1, maintenanceRooms: 1, occupancyPercentage: 33.33 });
    });

    it('should keep each building in its own cache entry', async () => {
      const a = await createWorld();
      const b = await createWorld();
      await roomIn(a, 'A1');
      expect((await http.get('/api/v1/properties/rooms/vacancies/summary').set(a.h(a.pm))).body.data[0].totalRooms).toBe(1);
      expect((await http.get('/api/v1/properties/rooms/vacancies/summary').set(b.h(b.pm))).body.data[0].totalRooms).toBe(0);
    });
  });

  // ===========================================================================
  // Tenant room access (OCCUPANCY_SELF_SCOPE)
  // ===========================================================================
  describe('A tenant sees only the room they live in', () => {
    it('should open the own room by /mine and by id, refuse any other room, and lose access on move-out', async () => {
      const w = await createWorld();
      const mine = await roomIn(w, 'T-1');
      const other = await roomIn(w, 'T-2');
      const asTenant = w.h(w.tenant);

      expect((await http.get('/api/v1/properties/rooms/mine').set(asTenant).expect(404)).body.errorCode).toBe('BIZ_NO_ACTIVE_ROOM');
      await http.get(`/api/v1/properties/rooms/${mine.id}`).set(asTenant).expect(403);

      // Chuyển đến: kết quả "không ở đâu" vẫn trong cache cho tới khi ContractsModule xóa (occupant.moved_in)
      residences.set(`${w.buildingId}:${w.tenant.id}`, { tenantId: 't', contractId: 'c', roomId: mine.id, occupantRole: 'PRIMARY_HOLDER' });
      await http.get('/api/v1/properties/rooms/mine').set(asTenant).expect(404);
      await app.get(OccupancySelfScopeService).evict(w.tenant.id, w.buildingId);
      expect((await http.get('/api/v1/properties/rooms/mine').set(asTenant).expect(200)).body.data.id).toBe(mine.id);
      await http.get(`/api/v1/properties/rooms/${mine.id}`).set(asTenant).expect(200);
      expect((await http.get(`/api/v1/properties/rooms/${other.id}`).set(asTenant).expect(403)).body.errorCode).toBe('AUTH_FORBIDDEN_RESOURCE');
      await http.get('/api/v1/properties/rooms').set(asTenant).expect(403);
      await http.get('/api/v1/properties/rooms/vacancies/summary').set(asTenant).expect(403);

      // Chuyển đi: ContractsModule xóa cache self-scope → mất quyền ngay
      residences.delete(`${w.buildingId}:${w.tenant.id}`);
      await http.get(`/api/v1/properties/rooms/${mine.id}`).set(asTenant).expect(200); // còn trong cache 300 s
      await app.get(OccupancySelfScopeService).evict(w.tenant.id, w.buildingId);
      await http.get(`/api/v1/properties/rooms/${mine.id}`).set(asTenant).expect(403);
    });

    it('should tell staff to use the room id instead of /mine', async () => {
      const w = await createWorld();
      await http.get('/api/v1/properties/rooms/mine').set(w.h(w.pm)).expect(403);
    });
  });

  // ===========================================================================
  // Assets
  // ===========================================================================
  describe('Appliance catalogue and installed units', () => {
    it('should keep a catalogue per building with installed-unit counts and category filter', async () => {
      const w = await createWorld();
      const ac = await createAsset(w);
      await createAsset(w, { code: 'SOFA_BED', name: 'Sofa giường', category: 'FURNITURE', standardMonthlyRentalFee: 150_000 });
      const room = await roomIn(w, 'P.101');
      await install(w, { roomId: room.id, assetId: ac.id, serialNumber: `DK-${unique()}` }).expect(201);
      await install(w, { roomId: room.id, assetId: ac.id, serialNumber: `DK-${unique()}` }).expect(201);

      const all = (await http.get('/api/v1/assets').set(w.h(w.accountant)).expect(200)).body.data;
      expect(all.map((a: any) => [a.code, a.installedUnits])).toEqual([[ac.code, 2], ['SOFA_BED', 0]]);
      expect((await http.get('/api/v1/assets').query({ category: 'FURNITURE' }).set(w.h(w.pm)).expect(200)).body.data).toHaveLength(1);
      expect((await http.post('/api/v1/assets').set(w.h(w.pm)).set('Idempotency-Key', randomUUID()).send({ code: ac.code.toLowerCase(), name: 'dup', category: 'APPLIANCE', standardMonthlyRentalFee: 1 }).expect(409)).body.errorCode).toBe('RES_ALREADY_EXISTS');
      // Danh mục của tòa khác không lộ
      const other = await createWorld();
      expect((await http.get('/api/v1/assets').set(other.h(other.pm)).expect(200)).body.data).toEqual([]);
    });

    it('should install a unit with catalogue defaults and show it in room detail', async () => {
      const w = await createWorld();
      const ac = await createAsset(w);
      const room = await roomIn(w, 'P.102');
      const serial = `dk-${unique()}`;
      const unit = (await install(w, { roomId: room.id, assetId: ac.id, serialNumber: serial }).expect(201)).body.data;
      const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
      expect(unit).toMatchObject({ roomNumber: 'P.102', assetName: ac.name, category: 'APPLIANCE', serialNumber: serial.toUpperCase(), conditionGrade: 'GRADE_A_NEW', customMonthlyFee: 300000, installedDate: today });

      const detail = (await http.get(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm)).expect(200)).body.data;
      expect(detail.rentedAssets).toEqual([{ roomAssetId: unit.id, name: ac.name, category: 'APPLIANCE', serialNumber: serial.toUpperCase(), conditionGrade: 'GRADE_A_NEW', monthlyFee: 300000 }]);

      // Đổi phí chuẩn của danh mục không đổi phí của đơn vị đã lắp
      await http.patch(`/api/v1/assets/${ac.id}`).set(w.h(w.pm)).send({ standardMonthlyRentalFee: 350_000 }).expect(200);
      expect((await http.get(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm))).body.data.rentedAssets[0].monthlyFee).toBe(300000);
    });

    it('should refuse duplicate serials among installed units but allow re-installing a removed one', async () => {
      const w = await createWorld();
      const ac = await createAsset(w);
      const room = await roomIn(w, 'P.103');
      const serial = `SN-${unique()}`;
      const first = (await install(w, { roomId: room.id, assetId: ac.id, serialNumber: serial }).expect(201)).body.data;
      expect((await install(w, { roomId: room.id, assetId: ac.id, serialNumber: serial.toLowerCase() }).expect(409)).body.details).toEqual([
        { field: 'serialNumber', issue: 'ALREADY_EXISTS' },
      ]);

      await http.delete(`/api/v1/assets/room-assignments/${first.id}`).set(w.h(w.pm)).expect(204);
      expect((await http.get(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm))).body.data.rentedAssets).toEqual([]);
      const [row] = await owner.query(`SELECT deleted_at FROM room_assets WHERE id = $1`, [first.id]);
      expect(row.deleted_at).not.toBeNull(); // lịch sử được giữ
      await install(w, { roomId: room.id, assetId: ac.id, serialNumber: serial }).expect(201);
      await http.delete(`/api/v1/assets/room-assignments/${first.id}`).set(w.h(w.pm)).expect(404);
    });

    it('should validate installations: other building, future date, fee, wrong ids', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const acA = await createAsset(a);
      const acB = await createAsset(b);
      const roomA = await roomIn(a, 'P.104');
      const roomB = await roomIn(b, 'P.104');

      expect((await install(a, { roomId: roomB.id, assetId: acA.id, serialNumber: `X-${unique()}` }).expect(404)).body.details[0].field).toBe('roomId');
      expect((await install(a, { roomId: roomA.id, assetId: acB.id, serialNumber: `X-${unique()}` }).expect(404)).body.details[0].field).toBe('assetId');
      const tomorrow = new Date(Date.now() + 31 * 3600_000).toISOString().slice(0, 10);
      expect((await install(a, { roomId: roomA.id, assetId: acA.id, serialNumber: `X-${unique()}`, installedDate: tomorrow }).expect(400)).body.details[0].field).toBe('installedDate');
      await install(a, { roomId: roomA.id, assetId: acA.id, serialNumber: `X-${unique()}`, customMonthlyFee: -5 }).expect(400);

      // Kernel: đơn vị không thể nằm ở phòng của tòa khác, phí âm bị chặn
      await expect(
        owner.query(`INSERT INTO room_assets (building_id, room_id, asset_id, serial_number, custom_monthly_fee, installed_date) VALUES ($1, $2, $3, 'RAW-1', 0, now())`, [a.buildingId, roomB.id, acA.id]),
      ).rejects.toThrow(/fk_room_assets_room_same_building/);
      await expect(
        owner.query(`INSERT INTO room_assets (building_id, room_id, asset_id, serial_number, custom_monthly_fee, installed_date) VALUES ($1, $2, $3, 'RAW-2', -1, now())`, [a.buildingId, roomA.id, acA.id]),
      ).rejects.toThrow(/chk_room_assets_fee/);
    });

    it('should re-grade, re-price and move a unit to another room, with optimistic locking', async () => {
      const w = await createWorld();
      const ac = await createAsset(w);
      const from = await roomIn(w, 'P.105');
      const to = await roomIn(w, 'P.106');
      const unit = (await install(w, { roomId: from.id, assetId: ac.id, serialNumber: `MV-${unique()}`, conditionGrade: 'GRADE_B_GOOD', customMonthlyFee: 280_000 }).expect(201)).body.data;
      const patch = (body: object) => http.patch(`/api/v1/assets/room-assignments/${unit.id}`).set(w.h(w.pm)).send(body);

      const moved = (await patch({ roomId: to.id, conditionGrade: 'BROKEN', customMonthlyFee: 0, version: 1 }).expect(200)).body.data;
      expect(moved).toMatchObject({ roomId: to.id, roomNumber: 'P.106', conditionGrade: 'BROKEN', customMonthlyFee: 0, version: 2 });
      expect((await http.get(`/api/v1/properties/rooms/${from.id}`).set(w.h(w.pm))).body.data.rentedAssets).toEqual([]);
      expect((await http.get(`/api/v1/properties/rooms/${to.id}`).set(w.h(w.pm))).body.data.rentedAssets).toHaveLength(1);
      expect((await patch({ conditionGrade: 'GRADE_C_FAIR', version: 1 }).expect(409)).body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');
      expect((await patch({ roomId: randomUUID() }).expect(404)).body.details[0].field).toBe('roomId');
      await patch({}).expect(400);
    });

    it('should enforce the permission matrix on assets', async () => {
      const w = await createWorld();
      await http.get('/api/v1/assets').set(w.h(w.accountant)).expect(200);
      await http.post('/api/v1/assets').set(w.h(w.accountant)).set('Idempotency-Key', randomUUID()).send({ code: 'X_1', name: 'x', category: 'APPLIANCE', standardMonthlyRentalFee: 1 }).expect(403);
      await http.get('/api/v1/assets').set(w.h(w.guard)).expect(403);
      await http.get('/api/v1/assets').set(w.h(w.tenant)).expect(403);
      await http.post('/api/v1/assets').set(w.h(w.landlord)).set('Idempotency-Key', randomUUID()).send({ code: 'X_2', name: 'x', category: 'APPLIANCE', standardMonthlyRentalFee: 1 }).expect(201);
    });
  });

  // ===========================================================================
  // Public listing (module 1b): anonymous portfolio website
  // ===========================================================================
  describe('Public listing (anonymous portfolio website)', () => {
    const pub = (path: string) => http.get(`/api/v1/public/buildings${path}`); // KHÔNG có token, KHÔNG có X-Building-ID

    /** Tòa nhà công khai: 5 phòng (1 bảo trì, 1 đã đặt, 1 bị ẩn), máy lạnh lắp ở P.101 */
    const publishedWorld = async () => {
      const w = await createWorld();
      const slug = `e2e-${unique().toLowerCase()}`;
      const p101 = await roomIn(w, 'P.101', { floor: 1 });
      const p102 = await roomIn(w, 'P.102', { floor: 1, priceOverride: 7_000_000 });
      const p201 = await roomIn(w, 'P.201', { floor: 2, roomTypeId: w.duplex.id, areaSqm: 55 });
      const p202 = await roomIn(w, 'P.202', { floor: 2 });
      const staffRoom = await roomIn(w, 'P.203', { floor: 2 });
      await http.patch(`/api/v1/properties/rooms/${p201.id}`).set(w.h(w.pm)).send({ status: 'MAINTENANCE' }).expect(200);
      await http.patch(`/api/v1/properties/rooms/${p202.id}`).set(w.h(w.pm)).send({ status: 'RESERVED' }).expect(200);
      await http.patch(`/api/v1/properties/rooms/${staffRoom.id}`).set(w.h(w.pm)).send({ isPubliclyListed: false }).expect(200);
      const ac = await createAsset(w);
      const serial = `PUB-${unique()}`;
      await install(w, { roomId: p101.id, assetId: ac.id, serialNumber: serial, conditionGrade: 'GRADE_B_GOOD', customMonthlyFee: 250_000 }).expect(201);
      await http
        .patch(`/api/v1/properties/buildings/${w.buildingId}`)
        .set(w.landlord.auth)
        .send({ isPubliclyListed: true, publicSlug: slug, publicDescription: 'Gần đại học' })
        .expect(200);
      return { ...w, slug, p101, p102, p201, p202, staffRoom, ac, serial };
    };

    it('should not publish without a slug, refuse bad or taken slugs, and the database enforces the same', async () => {
      const w = await createWorld();
      const patch = (body: object) => http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(w.landlord.auth).send(body);
      expect((await patch({ isPubliclyListed: true }).expect(400)).body.details[0].field).toBe('publicSlug');
      await patch({ publicSlug: 'Bad Slug!' }).expect(400);
      const taken = await publishedWorld();
      expect((await patch({ publicSlug: taken.slug }).expect(409)).body.errorCode).toBe('RES_ALREADY_EXISTS');
      await http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(w.pm.auth).send({ isPubliclyListed: true, publicSlug: 'x-y-z' }).expect(403);
      await expect(owner.query(`UPDATE buildings SET is_publicly_listed = true, public_slug = NULL WHERE id = $1`, [w.buildingId])).rejects.toThrow(/chk_buildings_listed_has_slug/);
      await expect(owner.query(`UPDATE buildings SET public_slug = 'NOT OK' WHERE id = $1`, [w.buildingId])).rejects.toThrow(/chk_buildings_public_slug/);
    });

    it('should answer an unpublished building exactly like an unknown one, on every public route', async () => {
      const w = await createWorld();
      const hidden = `hidden-${unique().toLowerCase()}`;
      await http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(w.landlord.auth).send({ publicSlug: hidden }).expect(200);
      for (const suffix of ['', '/room-types', '/floors', '/rooms', '/rooms/P.101', '/vacancies', '/assets']) {
        const a = await pub(`/${hidden}${suffix}`).expect(404);
        const b = await pub(`/no-such-building${suffix}`).expect(404);
        expect(a.body.errorCode).toBe('RES_NOT_FOUND');
        expect(a.body.message).toBe(b.body.message);
      }
      expect((await pub('').expect(200)).body.data.map((x: any) => x.slug)).not.toContain(hidden);
    });

    it('should list and describe a published building without any private data', async () => {
      const w = await publishedWorld();
      const list = (await pub('').expect(200)).body.data;
      expect(list.find((b: any) => b.slug === w.slug)).toEqual({
        slug: w.slug,
        name: 'E2E building',
        district: 'Q1',
        city: 'Thành phố Hồ Chí Minh',
        totalRooms: 4,
        availableRooms: 2,
        monthlyRentFrom: 6500000,
        monthlyRentTo: 12000000,
      });
      const profile = (await pub(`/${w.slug}`).expect(200)).body.data;
      expect(profile).toMatchObject({
        slug: w.slug,
        description: 'Gần đại học',
        totalRooms: 4,
        availableRooms: 2,
        floors: [1, 2],
        utilities: { electricityBillingMode: 'EVN_TIERED_QUOTA', waterRatePerM3: 25000 },
        depositMonths: 1,
      });
      const everything = JSON.stringify([
        list,
        profile,
        (await pub(`/${w.slug}/rooms?limit=50`)).body,
        (await pub(`/${w.slug}/rooms/P.101`)).body,
        (await pub(`/${w.slug}/floors`)).body,
        (await pub(`/${w.slug}/assets`)).body,
        (await pub(`/${w.slug}/vacancies`)).body,
      ]);
      for (const secret of [w.buildingId, w.p101.id, w.studio.id, w.ac.id, w.serial, '0312345678', 'Chủ nhà', 'replacementValue', 'MAINTENANCE', 'RESERVED', 'P.203']) {
        expect(everything).not.toContain(secret);
      }
    });

    it('should search rooms by type, floor, availability, price, area and capacity with sorting and paging', async () => {
      const w = await publishedWorld();
      const search = async (q: string) => (await pub(`/${w.slug}/rooms${q}`).expect(200)).body;
      const numbers = (body: any) => body.data.map((r: any) => r.roomNumber);

      expect((await search('')).data[0]).toEqual({
        roomNumber: 'P.101',
        floor: 1,
        roomTypeCode: 'STUDIO',
        roomTypeName: 'Studio',
        areaSqm: 30,
        maxOccupants: 2,
        monthlyRent: 6500000,
        availability: 'AVAILABLE',
      });
      expect(numbers(await search(''))).toEqual(['P.101', 'P.102', 'P.201', 'P.202']); // P.203 bị ẩn
      expect(numbers(await search('?availability=available'))).toEqual(['P.101', 'P.102']);
      expect((await search('?availability=UNAVAILABLE')).data.map((r: any) => [r.roomNumber, r.availability])).toEqual([
        ['P.201', 'UNAVAILABLE'],
        ['P.202', 'UNAVAILABLE'],
      ]);
      expect(numbers(await search('?roomType=duplex'))).toEqual(['P.201']);
      expect(numbers(await search('?floor=2'))).toEqual(['P.201', 'P.202']);
      expect(numbers(await search('?minPrice=6600000&maxPrice=7000000'))).toEqual(['P.102']);
      expect(numbers(await search('?minAreaSqm=50'))).toEqual(['P.201']);
      expect(numbers(await search('?occupants=3'))).toEqual(['P.201']);
      expect(numbers(await search('?sortBy=monthlyRent&sortOrder=DESC'))).toEqual(['P.201', 'P.102', 'P.101', 'P.202']);
      const page = await search('?limit=3&page=2');
      expect(numbers(page)).toEqual(['P.202']);
      expect(page.meta.pagination).toMatchObject({ page: 2, limit: 3, totalItems: 4, totalPages: 2 });

      await pub(`/${w.slug}/rooms?limit=51`).expect(400);
      await pub(`/${w.slug}/rooms?minPrice=9&maxPrice=1`).expect(400);
      await pub(`/${w.slug}/rooms?availability=RESERVED`).expect(400);
    });

    it('should show one room by its number with its equipment, and hide hidden or unknown rooms', async () => {
      const w = await publishedWorld();
      const room = (await pub(`/${w.slug}/rooms/p.101`).expect(200)).body.data;
      expect(room).toEqual({
        roomNumber: 'P.101',
        floor: 1,
        roomTypeCode: 'STUDIO',
        roomTypeName: 'Studio',
        areaSqm: 30,
        maxOccupants: 2,
        monthlyRent: 6500000,
        availability: 'AVAILABLE',
        buildingSlug: w.slug,
        depositMonths: 1,
        equipment: [{ name: w.ac.name, category: 'APPLIANCE', conditionGrade: 'GRADE_B_GOOD', monthlyFee: 250000 }],
      });
      expect((await pub(`/${w.slug}/rooms/P.201`).expect(200)).body.data.availability).toBe('UNAVAILABLE');
      await pub(`/${w.slug}/rooms/P.203`).expect(404); // ẩn bởi quản lý
      await pub(`/${w.slug}/rooms/P.999`).expect(404);
      await pub(`/${w.slug}/rooms/..%2F..%2Fetc`).expect(404);
    });

    it('should summarise floors, room types, vacancies and equipment over published rooms only', async () => {
      const w = await publishedWorld();
      expect((await pub(`/${w.slug}/floors`).expect(200)).body.data).toEqual([
        { floor: 1, totalRooms: 2, availableRooms: 2, roomNumbers: ['P.101', 'P.102'] },
        { floor: 2, totalRooms: 2, availableRooms: 0, roomNumbers: ['P.201', 'P.202'] },
      ]);
      expect((await pub(`/${w.slug}/room-types`).expect(200)).body.data).toEqual([
        { code: 'STUDIO', name: 'Studio', baseMonthlyRent: 6500000, standardAreaSqm: 28.5, maxOccupants: 2, totalRooms: 3, availableRooms: 2 },
        { code: 'DUPLEX', name: 'Duplex', baseMonthlyRent: 12000000, standardAreaSqm: 55, maxOccupants: 4, totalRooms: 1, availableRooms: 0 },
      ]);
      expect((await pub(`/${w.slug}/vacancies`).expect(200)).body.data.map((v: any) => [v.roomTypeCode, v.totalRooms, v.availableRooms])).toEqual([
        ['STUDIO', 3, 2],
        ['DUPLEX', 1, 0],
      ]);

      // Đơn vị trong phòng bị ẩn không được tính
      await install(w, { roomId: w.staffRoom.id, assetId: w.ac.id, serialNumber: `HID-${unique()}` }).expect(201);
      await createAsset(w, { code: 'SOFA_BED', name: 'Sofa giường', category: 'FURNITURE', standardMonthlyRentalFee: 150_000 });
      expect((await pub(`/${w.slug}/assets`).expect(200)).body.data).toEqual([
        { name: w.ac.name, category: 'APPLIANCE', standardMonthlyRentalFee: 300000, roomsEquipped: 1 },
        { name: 'Sofa giường', category: 'FURNITURE', standardMonthlyRentalFee: 150000, roomsEquipped: 0 },
      ]);
      expect((await pub(`/${w.slug}/assets?category=FURNITURE`).expect(200)).body.data).toHaveLength(1);
    });

    it('should serve from cache, yet show every staff change immediately', async () => {
      const w = await publishedWorld();
      const room = async () => (await pub(`/${w.slug}/rooms/P.102`).expect(200)).body.data;
      expect((await room()).monthlyRent).toBe(7000000);

      // Sửa thẳng DB (bỏ qua API) → website vẫn trả bản cache
      await owner.query(`UPDATE rooms SET price_override = 1 WHERE id = $1`, [w.p102.id]);
      expect((await room()).monthlyRent).toBe(7000000);
      expect(await redis.exists(`cache:${w.buildingId}:public:room:P.102`)).toBe(1); // cache theo tòa nhà, không ở namespace global

      // Thay đổi qua API của nhân viên → làm mới ngay (tag rooms / catalogs / assets / public)
      await http.patch(`/api/v1/properties/rooms/${w.p102.id}`).set(w.h(w.pm)).send({ status: 'RESERVED', priceOverride: 7_200_000 }).expect(200);
      expect(await room()).toMatchObject({ monthlyRent: 7200000, availability: 'UNAVAILABLE' });

      await http.patch(`/api/v1/properties/room-types/${w.studio.id}`).set(w.h(w.pm)).send({ baseMonthlyRent: 6_600_000 }).expect(200);
      expect((await pub(`/${w.slug}/rooms/P.101`)).body.data.monthlyRent).toBe(6600000);

      // Mỗi bước: nạp cache TRƯỚC khi thay đổi, để chứng minh chính thay đổi đó xóa cache
      expect((await room()).equipment).toEqual([]);
      const unit = (await install(w, { roomId: w.p102.id, assetId: w.ac.id, serialNumber: `NEW-${unique()}` }).expect(201)).body.data;
      expect((await room()).equipment).toHaveLength(1);
      await http.delete(`/api/v1/assets/room-assignments/${unit.id}`).set(w.h(w.pm)).expect(204);
      expect((await room()).equipment).toEqual([]); // đơn vị đã gỡ không còn hiển thị

      expect((await pub(`/${w.slug}`)).body.data.description).toBe('Gần đại học');
      await http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(w.landlord.auth).send({ publicDescription: 'Mới cập nhật' }).expect(200);
      expect((await pub(`/${w.slug}`)).body.data.description).toBe('Mới cập nhật');

      // Gỡ công khai → biến mất ngay
      await http.patch(`/api/v1/properties/buildings/${w.buildingId}`).set(w.landlord.auth).send({ isPubliclyListed: false }).expect(200);
      await pub(`/${w.slug}`).expect(404);
      expect((await pub('')).body.data.map((b: any) => b.slug)).not.toContain(w.slug);
    });

    it('should never mix two published buildings', async () => {
      const a = await publishedWorld();
      const b = await publishedWorld();
      await http.patch(`/api/v1/properties/rooms/${b.p101.id}`).set(b.h(b.pm)).send({ priceOverride: 9_999_000 }).expect(200);
      expect((await pub(`/${a.slug}/rooms/P.101`)).body.data.monthlyRent).toBe(6500000);
      expect((await pub(`/${b.slug}/rooms/P.101`)).body.data.monthlyRent).toBe(9999000);
    });

    it('should send Cache-Control and an ETag, answer 304 for an unchanged version, and never cache errors', async () => {
      const w = await publishedWorld();
      const first = await pub(`/${w.slug}/floors`).expect(200);
      expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
      const etag = first.headers.etag;
      expect(etag).toMatch(/^W\/".+"$/);
      const again = await pub(`/${w.slug}/floors`).set('If-None-Match', etag).expect(304);
      expect(again.text).toBe('');
      // Nhân viên thay đổi → ETag mới → trả lại toàn bộ dữ liệu
      await http.patch(`/api/v1/properties/rooms/${w.p101.id}`).set(w.h(w.pm)).send({ status: 'MAINTENANCE' }).expect(200);
      const changed = await pub(`/${w.slug}/floors`).set('If-None-Match', etag).expect(200);
      expect(changed.headers.etag).not.toBe(etag);
      const missing = await pub('/no-such-building').expect(404);
      expect(missing.headers['cache-control']).toBeUndefined();
    });

    it('should stay anonymous: no token needed, a bad token or a foreign building header is ignored', async () => {
      const w = await publishedWorld();
      await pub(`/${w.slug}`).set('Authorization', 'Bearer not-a-token').expect(200);
      await pub(`/${w.slug}`).set('X-Building-ID', randomUUID()).expect(200);
    });

    it('should switch the whole public site off with the public_listing flag, leaving management untouched', async () => {
      const w = await publishedWorld();
      const flags = app.get(FeatureFlagService);
      await flags.setFlag('public_listing', { enabled: false });
      try {
        expect((await pub(`/${w.slug}`).expect(404)).body.errorCode).toBe('RES_FEATURE_DISABLED');
        await pub('').expect(404);
        await http.get('/api/v1/properties/rooms').set(w.h(w.pm)).expect(200);
      } finally {
        await flags.clearOverride('public_listing');
      }
      await pub(`/${w.slug}`).expect(200);
    });
  });

  it('should audit room and asset changes with a diff', async () => {
    const w = await createWorld();
    const room = await roomIn(w, 'AUD-1');
    await http.patch(`/api/v1/properties/rooms/${room.id}`).set(w.h(w.pm)).send({ priceOverride: 7_100_000 }).expect(200);
    const rows = await owner.query(`SELECT action, diff_snapshot FROM audit_logs WHERE resource = 'rooms' AND resource_id = $1 ORDER BY created_at`, [room.id]);
    expect(rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));
    expect(JSON.stringify(rows.find((r: any) => r.action === 'UPDATE').diff_snapshot)).toContain('7100000');
  });
});
