/**
 * Lớp cô lập THỨ NHẤT của module 1 (bộ lọc building_id trong mọi truy vấn), kiểm tra ĐỘC LẬP với RLS:
 * file này chạy ứng dụng bằng superuser `postgres` - RLS bị bỏ qua (giống môi trường dev cục bộ). Nếu một truy vấn
 * quên lọc building_id, dữ liệu tòa nhà khác sẽ lộ ra ở đây. Lớp thứ hai (RLS với app_user): properties.e2e-spec.ts.
 */
import './disable-outbox-poller';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/core/config/app-config.service';
import { runSeeds } from '../src/core/database/seed-runner';
import { JwtTokenService } from '../src/core/security/jwt/jwt-token.service';

/** Số điện thoại duy nhất (E.164 15 chữ số, tăng dần): test DB giữ dữ liệu giữa các lần chạy nên không dùng số ngẫu nhiên ngắn */
let phoneCounter = 0;
const uniquePhone = () => `+${Date.now()}${String(phoneCounter++ % 100).padStart(2, '0')}`;

process.env.THROTTLE_LIMIT = '10000';

describe('Properties & Assets - app-layer building isolation (RLS bypassed by a superuser)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let ds: DataSource;
  let tokens: JwtTokenService;

  const world = async () => {
    const buildingId = randomUUID();
    await ds.query(
      `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name)
       VALUES ($1, $2, 'Iso', 'x', 'x', 'x', '0312345678', 'x')`,
      [buildingId, `ISO-${randomUUID().slice(0, 8)}`],
    );
    const [{ id }] = await ds.query(
      `INSERT INTO users (phone_e164, full_name, status, password_hash)
       VALUES ($1, 'pm', 'ACTIVE', 'x') RETURNING id`,
      [uniquePhone()],
    );
    await ds.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'PROPERTY_MANAGER')`, [id]);
    await ds.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, buildingId]);
    const token = await tokens.signAccessToken({ sub: id, buildingId, buildingIds: [buildingId], roles: ['PROPERTY_MANAGER'] });
    const h = { Authorization: `Bearer ${token}`, 'X-Building-ID': buildingId };
    const post = async (path: string, body: object) =>
      (await http.post(path).set(h).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body.data;
    const roomType = await post('/api/v1/properties/room-types', { code: 'STD', name: 'Std', baseMonthlyRent: 5_000_000, standardAreaSqm: 20 });
    const room = await post('/api/v1/properties/rooms', { roomNumber: 'P.101', floor: 1, areaSqm: 20, roomTypeId: roomType.id });
    const asset = await post('/api/v1/assets', { code: 'AC', name: 'AC', category: 'APPLIANCE', standardMonthlyRentalFee: 100_000 });
    const unit = await post('/api/v1/assets/room-assignments', { roomId: room.id, assetId: asset.id, serialNumber: `ISO-${randomUUID().slice(0, 8)}` });
    return { buildingId, h, roomType, room, asset, unit };
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
    ds = app.get(DataSource);
    tokens = app.get(JwtTokenService);
    expect(await runSeeds()).toBe(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('should run as a role that bypasses RLS, so only the application filter protects the data here', async () => {
    const [{ rolsuper }] = await ds.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(rolsuper).toBe(true);
  });

  it("should never show or change another building's rooms, room types, assets or units", async () => {
    const a = await world();
    const b = await world();

    const roomIds = (await http.get('/api/v1/properties/rooms').query({ limit: 100 }).set(a.h).expect(200)).body.data.map((r: any) => r.id);
    expect(roomIds).toEqual([a.room.id]);
    await http.get(`/api/v1/properties/rooms/${b.room.id}`).set(a.h).expect(404);
    await http.patch(`/api/v1/properties/rooms/${b.room.id}`).set(a.h).send({ status: 'MAINTENANCE' }).expect(404);

    expect((await http.get('/api/v1/properties/room-types').set(a.h).expect(200)).body.data.map((t: any) => t.id)).toEqual([a.roomType.id]);
    await http.patch(`/api/v1/properties/room-types/${b.roomType.id}`).set(a.h).send({ baseMonthlyRent: 1 }).expect(404);
    expect((await http.get('/api/v1/properties/rooms/vacancies/summary').set(a.h).expect(200)).body.data.map((v: any) => v.roomTypeId)).toEqual([a.roomType.id]);

    expect((await http.get('/api/v1/assets').set(a.h).expect(200)).body.data.map((x: any) => x.id)).toEqual([a.asset.id]);
    await http.patch(`/api/v1/assets/${b.asset.id}`).set(a.h).send({ name: 'x' }).expect(404);
    await http.patch(`/api/v1/assets/room-assignments/${b.unit.id}`).set(a.h).send({ conditionGrade: 'BROKEN' }).expect(404);
    await http.delete(`/api/v1/assets/room-assignments/${b.unit.id}`).set(a.h).expect(404);

    const post = (path: string, body: object) => http.post(path).set(a.h).set('Idempotency-Key', randomUUID()).send(body);
    await post('/api/v1/properties/rooms', { roomNumber: 'X', floor: 1, areaSqm: 20, roomTypeId: b.roomType.id }).expect(404);
    await post('/api/v1/assets/room-assignments', { roomId: b.room.id, assetId: a.asset.id, serialNumber: `X-${randomUUID().slice(0, 6)}` }).expect(404);
    await post('/api/v1/assets/room-assignments', { roomId: a.room.id, assetId: b.asset.id, serialNumber: `X-${randomUUID().slice(0, 6)}` }).expect(404);
    await http.patch(`/api/v1/assets/room-assignments/${a.unit.id}`).set(a.h).send({ roomId: b.room.id }).expect(404);

    // Website giới thiệu: cùng số phòng P.101 ở hai tòa công khai, mỗi slug chỉ thấy tòa của mình
    for (const w of [a, b]) {
      await ds.query(`UPDATE buildings SET is_publicly_listed = true, public_slug = $2 WHERE id = $1`, [w.buildingId, `iso-${w.buildingId.slice(0, 8)}`]);
    }
    await http.patch(`/api/v1/properties/rooms/${b.room.id}`).set(b.h).send({ priceOverride: 9_000_000 }).expect(200);
    const pubA = (path: string) => http.get(`/api/v1/public/buildings/iso-${a.buildingId.slice(0, 8)}${path}`).expect(200);
    expect((await pubA('/rooms')).body.data.map((r: any) => r.monthlyRent)).toEqual([5000000]);
    expect((await pubA('/rooms/P.101')).body.data).toMatchObject({ monthlyRent: 5000000, equipment: [{ name: 'AC' }] });
    expect((await pubA('/room-types')).body.data).toHaveLength(1);
    expect((await pubA('/assets')).body.data).toHaveLength(1);
    expect((await pubA('')).body.data.totalRooms).toBe(1);

    // Không có gì của tòa b bị thay đổi
    const [bRoom] = await ds.query(`SELECT status FROM rooms WHERE id = $1`, [b.room.id]);
    expect(bRoom.status).toBe('AVAILABLE');
  });
  it("should never show, match or link another building's people (tenants)", async () => {
    const a = await world();
    const b = await world();
    const person = (overrides: Record<string, unknown>) => ({
      fullName: 'Nguyễn Văn Iso',
      idDocumentType: 'CCCD',
      gender: 'MALE',
      dateOfBirth: '1999-08-15',
      phone: '0901234567',
      hometownAddress: 'x',
      permanentAddress: 'x',
      pdplConsentAccepted: true,
      ...overrides,
    });
    const number = `079099${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const post = (w: typeof a, body: object) => http.post('/api/v1/tenants').set(w.h).set('Idempotency-Key', randomUUID()).send(body);
    const parentB = (await post(b, person({ idCardNumber: number })).expect(201)).body.data;

    // Cùng số giấy tờ ở tòa khác là người khác (mỗi tòa một hồ sơ) - không bị coi là trùng
    await post(a, person({ idCardNumber: number })).expect(201);
    expect((await http.get('/api/v1/tenants').query({ q: 'nguyen van iso', limit: 100 }).set(a.h).expect(200)).body.data.map((t: any) => t.id)).not.toContain(parentB.id);
    await http.get(`/api/v1/tenants/${parentB.id}`).set(a.h).expect(404);
    await http.patch(`/api/v1/tenants/${parentB.id}`).set(a.h).send({ fullName: 'Hijack' }).expect(404);
    // Người giám hộ phải thuộc CÙNG tòa nhà - kiểm tra ở tầng ứng dụng (RLS bị bỏ qua ở đây)
    const child = person({ idCardNumber: `079315${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, gender: 'FEMALE', dateOfBirth: '2015-03-02', phone: null, consentGuardianTenantId: parentB.id });
    expect((await post(a, child).expect(422)).body.errorCode).toBe('BIZ_TENANT_GUARDIAN_INVALID');
  });
});
