/**
 * Module 3 - Contracts qua HTTP trên PostgreSQL + Redis THẬT, ứng dụng chạy bằng app_user (RLS có hiệu lực).
 * Dữ liệu nền (tòa nhà, người dùng, thiết bị) và kiểm tra kernel bằng kết nối owner riêng.
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e -- contracts
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
import { vietnamToday } from '../src/modules/properties/properties.helpers';
import { addDays, addYears } from '../src/modules/contracts/domain/contract.rules';

let counter = 0;
const uniquePhone = () => `+${Date.now()}${String(counter++ % 100).padStart(2, '0')}`;
const vnMobile = () => `090${String((Date.now() + counter++ * 7919) % 1e7).padStart(7, '0')}`;
const unique = () => randomUUID().slice(0, 8).toUpperCase();
const TODAY = vietnamToday();
const YEAR = TODAY.slice(0, 4);
/** CCCD khớp giới tính / năm sinh (tỉnh 079, 6 số cuối ngẫu nhiên) */
const cccdFor = (dob: string, gender: 'MALE' | 'FEMALE') => {
  const century = Number(dob.slice(0, 2)) === 19 ? 0 : 2;
  return `079${century + (gender === 'FEMALE' ? 1 : 0)}${dob.slice(2, 4)}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
};

describe('Contracts (HTTP, real PostgreSQL as app_user + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let owner: DataSource;
  let redis: Redis;
  let tokens: JwtTokenService;

  // ---------------------------------------------------------------- fixtures
  const createUser = async (roles: string[], buildingId: string) => {
    const [{ id }] = await owner.query(
      `INSERT INTO users (phone_e164, full_name, status, password_hash) VALUES ($1, 'e2e', 'ACTIVE', 'x') RETURNING id`,
      [uniquePhone()],
    );
    for (const role of roles) await owner.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
    await owner.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, buildingId]);
    return { id, h: await headers(id, roles, buildingId) };
  };
  const headers = async (userId: string, roles: string[], buildingId: string) => ({
    Authorization: `Bearer ${await tokens.signAccessToken({ sub: userId, buildingId, buildingIds: [buildingId], roles })}`,
    'X-Building-ID': buildingId,
  });

  const createWorld = async () => {
    const buildingId = randomUUID();
    await owner.query(
      `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name)
       VALUES ($1, $2, 'Contracts e2e', 'x', 'x', 'x', '0312345678', 'x')`,
      [buildingId, `CON-${unique()}`],
    );
    const [landlord, pm, accountant, guard, tenantUser] = await Promise.all([
      createUser(['LANDLORD'], buildingId),
      createUser(['PROPERTY_MANAGER'], buildingId),
      createUser(['ACCOUNTANT'], buildingId),
      createUser(['GUARD'], buildingId),
      createUser(['TENANT'], buildingId),
    ]);
    const roomType = (
      await post(`/properties/room-types`, { code: `ST${unique()}`, name: 'Studio', baseMonthlyRent: 6_500_000, standardAreaSqm: 28.5, defaultMaxOccupants: 3 }, pm.h).expect(201)
    ).body.data;
    const catalog: Record<string, string> = {};
    for (const [code, unit, vehicle, price] of [
      ['WIFI', 'PER_ROOM_MONTH', null, 150_000],
      ['SANITATION', 'PER_PERSON_MONTH', null, 30_000],
      ['PARKING_MOTORBIKE', 'PER_VEHICLE_MONTH', 'MOTORBIKE', 150_000],
      ['PARKING_CAR', 'PER_VEHICLE_MONTH', 'CAR', 1_200_000],
    ] as const) {
      catalog[code] = (await http.post('/api/v1/service-catalog').set(pm.h).send({ code, name: code, chargeUnit: unit, vehicleType: vehicle, defaultUnitPrice: price }).expect(201)).body.data.id;
    }
    return { buildingId, landlord, pm, accountant, guard, tenantUser, roomType, catalog };
  };
  type World = Awaited<ReturnType<typeof createWorld>>;

  const post = (path: string, body: object, h: Record<string, string>) => http.post(`/api/v1${path}`).set(h).set('Idempotency-Key', randomUUID()).send(body);

  const room = async (w: World, extra: Record<string, unknown> = {}) =>
    (await post('/properties/rooms', { roomNumber: `R${unique().slice(0, 6)}`, floor: 2, areaSqm: 30, roomTypeId: w.roomType.id, ...extra }, w.pm.h).expect(201)).body.data;

  const unit = async (w: World, roomId: string, conditionGrade = 'GRADE_A_NEW') => {
    const [asset] = await owner.query(
      `INSERT INTO assets (building_id, code, name, category, standard_monthly_rental_fee, replacement_value) VALUES ($1, $2, 'Máy lạnh', 'APPLIANCE', 300000, 9000000) RETURNING id`,
      [w.buildingId, `AC_${unique()}`],
    );
    const [u] = await owner.query(
      `INSERT INTO room_assets (building_id, room_id, asset_id, serial_number, condition_grade, custom_monthly_fee, installed_date)
       VALUES ($1, $2, $3, $4, $5, 250000, '2026-01-01') RETURNING id`,
      [w.buildingId, roomId, asset.id, `SN-${unique()}`, conditionGrade],
    );
    return u.id as string;
  };

  const person = async (w: World, o: { dob?: string; gender?: 'MALE' | 'FEMALE'; phone?: string | null; passport?: boolean; guardianId?: string; name?: string } = {}) => {
    const dob = o.dob ?? '1995-05-05';
    const gender = o.gender ?? 'MALE';
    const body = {
      fullName: o.name ?? `Người ở ${unique()}`,
      idDocumentType: o.passport ? 'PASSPORT' : 'CCCD',
      idCardNumber: o.passport ? `M${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` : cccdFor(dob, gender),
      nationality: o.passport ? 'KR' : 'VN',
      gender,
      dateOfBirth: dob,
      phone: o.phone === undefined ? vnMobile() : o.phone,
      hometownAddress: 'Huế',
      permanentAddress: '1 Lê Lợi, Huế',
      pdplConsentAccepted: true,
      ...(o.guardianId ? { consentGuardianTenantId: o.guardianId } : {}),
    };
    return (await post('/tenants', body, w.pm.h).expect(201)).body.data as { id: string; fullName: string };
  };
  const child = async (w: World, guardianId: string, age = 10) => {
    const dob = addYears(TODAY, -age);
    return person(w, { dob, gender: 'FEMALE', phone: null, guardianId });
  };

  const term = { startDate: addDays(TODAY, -30), endDate: addDays(TODAY, 335) };
  const draft = (w: World, body: Record<string, unknown>, h = w.pm.h) => post('/contracts', { ...term, pcccCommitmentSigned: true, ...body }, h);
  const drafted = async (w: World, body: Record<string, unknown>) => (await draft(w, body).expect(201)).body.data;
  const activate = (w: World, id: string, body: object = {}, h = w.pm.h) => post(`/contracts/${id}/activate`, body, h);
  const activeContract = async (w: World, body: Record<string, unknown>) => {
    const c = await drafted(w, body);
    return (await activate(w, c.id).expect(201)).body.data;
  };
  const get = (path: string, h: Record<string, string>) => http.get(`/api/v1${path}`).set(h);
  const occupants = async (w: World, contractId: string, status = 'ACTIVE') => (await get(`/contracts/${contractId}/occupants?status=${status}`, w.pm.h).expect(200)).body.data;
  const services = async (w: World, contractId: string) => (await get(`/contracts/${contractId}/services`, w.pm.h).expect(200)).body.data as any[];
  const ledger = async (w: World, contractId: string) => (await get(`/contracts/${contractId}/deposit-ledger`, w.pm.h).expect(200)).body.data as any[];
  const events = async (aggregateId: string) =>
    (await owner.query(`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id`, [aggregateId])) as Array<{ event_type: string; payload: any }>;
  /** Token khách thuê của tài khoản được tạo lúc chuyển đến (kích hoạt OTP mô phỏng bằng owner) */
  const tenantHeaders = async (w: World, tenantId: string) => {
    const [{ user_id }] = await owner.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId]);
    await owner.query(`UPDATE users SET status = 'ACTIVE', password_hash = 'x' WHERE id = $1`, [user_id]);
    return headers(user_id, ['TENANT'], w.buildingId);
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
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

  // ===========================================================================
  describe('Draft (POST / PATCH /contracts, cancel)', () => {
    it('should create a draft with defaults, a yearly per-building code, the room RESERVED and nothing collected', async () => {
      const w = await createWorld();
      const r = await room(w);
      const u = await unit(w, r.id);
      const holder = await person(w);
      const c = await drafted(w, { roomId: r.id, primaryTenantId: holder.id, rentedRoomAssetIds: [u] });
      expect(c).toMatchObject({
        contractCode: `HD-${YEAR}/001-${r.roomNumber.replace(/[^A-Z0-9]/g, '')}`,
        status: 'DRAFT',
        monthlyRoomRent: 6_500_000,
        depositAmount: 6_500_000,
        depositStatus: 'PENDING_COLLECTION',
        depositBalance: 0,
        paymentDueDay: 5,
        activeOccupantCount: 0,
        plannedCoOccupants: [],
        primaryHolder: { tenantId: holder.id, fullName: holder.fullName },
        rentedAssets: [{ roomAssetId: u, agreedMonthlyFee: 250_000, handoverCondition: 'GRADE_A_NEW' }],
        activatedAt: null,
      });
      expect(c.primaryHolder.idCardMasked).toMatch(/^\*{8}\d{4}$/);
      expect(await ledger(w, c.id)).toEqual([]);
      expect((await get(`/properties/rooms/${r.id}`, w.pm.h).expect(200)).body.data).toMatchObject({ status: 'RESERVED', activeContract: null });
      expect((await events(r.id)).map((e) => e.payload)).toEqual([expect.objectContaining({ from: 'AVAILABLE', to: 'RESERVED' })]);

      const second = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id, monthlyRoomRent: 7_000_000 });
      expect(second).toMatchObject({ contractCode: expect.stringMatching(new RegExp(`^HD-${YEAR}/002-`)), monthlyRoomRent: 7_000_000, depositAmount: 7_000_000 });
    });

    it('should allow one draft per room and never a draft on a room in maintenance', async () => {
      const w = await createWorld();
      const r = await room(w);
      await drafted(w, { roomId: r.id, primaryTenantId: (await person(w)).id });
      const again = await draft(w, { roomId: r.id, primaryTenantId: (await person(w)).id }).expect(409);
      expect(again.body).toMatchObject({ errorCode: 'BIZ_ROOM_NOT_AVAILABLE', details: [{ field: 'roomId', issue: 'DRAFT_EXISTS' }] });

      const maintenance = await room(w);
      await http.patch(`/api/v1/properties/rooms/${maintenance.id}`).set(w.pm.h).send({ status: 'MAINTENANCE' }).expect(200);
      expect((await draft(w, { roomId: maintenance.id, primaryTenantId: (await person(w)).id }).expect(409)).body.details[0]).toMatchObject({
        issue: 'ROOM_NOT_AVAILABLE',
        status: 'MAINTENANCE',
      });
    });

    it('should let exactly one of two simultaneous drafts on the same room through', async () => {
      const w = await createWorld();
      const r = await room(w);
      const [a, b] = await Promise.all([person(w), person(w)]);
      const results = await Promise.all([draft(w, { roomId: r.id, primaryTenantId: a.id }), draft(w, { roomId: r.id, primaryTenantId: b.id })]);
      expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(await owner.query(`SELECT 1 FROM contracts WHERE room_id = $1`, [r.id])).toHaveLength(1);
    });

    it('should give simultaneous drafts in different rooms distinct sequential codes', async () => {
      const w = await createWorld();
      const rooms = [await room(w), await room(w), await room(w)];
      const holders = await Promise.all(rooms.map(() => person(w)));
      const results = await Promise.all(rooms.map((r, i) => draft(w, { roomId: r.id, primaryTenantId: holders[i].id })));
      expect(results.map((x) => x.status)).toEqual([201, 201, 201]);
      expect(results.map((x) => x.body.data.contractCode.slice(8, 11)).sort()).toEqual(['001', '002', '003']);
    });

    it('should require an eligible holder: adult exactly on the start date passes, one day younger is UNDERAGE', async () => {
      const w = await createWorld();
      const turns18 = await person(w, { dob: addYears(term.startDate, -18) });
      await drafted(w, { roomId: (await room(w)).id, primaryTenantId: turns18.id });

      // Còn 17 tuổi vào ngày bắt đầu (dù hôm nay đã đủ 18) → không đứng tên được hợp đồng bắt đầu từ ngày đó
      const almost = await person(w, { dob: addDays(addYears(term.startDate, -18), 1) });
      const res = await draft(w, { roomId: (await room(w)).id, primaryTenantId: almost.id }).expect(422);
      expect(res.body).toMatchObject({ errorCode: 'BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE', details: [{ field: 'primaryTenantId', issue: 'UNDERAGE' }] });
    });

    it('should cap holder + planned people at the room capacity (exactly full passes)', async () => {
      const w = await createWorld();
      const r = await room(w, { maxOccupants: 2 });
      const [h, a, b] = await Promise.all([person(w), person(w), person(w)]);
      const over = await draft(w, { roomId: r.id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }, { tenantId: b.id }] }).expect(409);
      expect(over.body).toMatchObject({ errorCode: 'BIZ_OCCUPANT_LIMIT_EXCEEDED', details: [{ maxOccupants: 2, requested: 3 }] });
      const full = await drafted(w, { roomId: r.id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id, relationshipToHolder: 'Bạn' }] });
      expect(full.plannedCoOccupants).toEqual([{ tenantId: a.id, fullName: a.fullName, movedInAt: null, successionOrder: null, relationshipToHolder: 'Bạn' }]);
    });

    it('should validate the planned list, the term and the people (same building only)', async () => {
      const w = await createWorld();
      const other = await createWorld();
      const r = await room(w);
      const h = await person(w);
      const stranger = await person(other);
      const bad = async (body: Record<string, unknown>, status: number) => (await draft(w, { roomId: r.id, primaryTenantId: h.id, ...body }).expect(status)).body;

      expect((await bad({ coOccupants: [{ tenantId: h.id }] }, 400)).details[0].field).toBe('coOccupants[0].tenantId');
      const a = await person(w);
      expect((await bad({ coOccupants: [{ tenantId: a.id }, { tenantId: a.id }] }, 400)).details[0].field).toBe('coOccupants[1].tenantId');
      expect((await bad({ endDate: term.startDate }, 400)).details[0]).toMatchObject({ field: 'endDate' });
      expect((await bad({ coOccupants: [{ tenantId: a.id, movedInAt: addDays(term.startDate, -1) }] }, 400)).details[0].field).toBe('coOccupants[0].movedInAt');
      expect((await bad({ coOccupants: [{ tenantId: stranger.id }] }, 404)).details[0].field).toBe('coOccupants[0].tenantId');
      expect((await bad({ primaryTenantId: stranger.id }, 404)).details[0].field).toBe('primaryTenantId');
      expect((await bad({ paymentDueDay: 29 }, 400)).errorCode).toBe('REQ_VALIDATION_ERROR');
    });

    it('should rent only units installed in that room and in working order', async () => {
      const w = await createWorld();
      const [r1, r2] = [await room(w), await room(w)];
      const elsewhere = await unit(w, r2.id);
      const broken = await unit(w, r1.id, 'BROKEN');
      const h = await person(w);
      expect((await draft(w, { roomId: r1.id, primaryTenantId: h.id, rentedRoomAssetIds: [elsewhere] }).expect(404)).body.details[0].field).toBe('rentedRoomAssetIds');
      expect((await draft(w, { roomId: r1.id, primaryTenantId: h.id, rentedRoomAssetIds: [broken] }).expect(400)).body.details[0].message).toMatch(/BROKEN/);
    });

    it('should edit a draft as a whole (lists replaced, per-person service follows the plan) and refuse stale versions', async () => {
      const w = await createWorld();
      const r = await room(w);
      const [u1, u2] = [await unit(w, r.id), await unit(w, r.id)];
      const [h, a, b] = await Promise.all([person(w), person(w), person(w)]);
      const c = await drafted(w, { roomId: r.id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }], rentedRoomAssetIds: [u1] });
      await post(`/contracts/${c.id}/services`, { serviceCatalogId: w.catalog.SANITATION }, w.pm.h).expect(201);
      expect((await services(w, c.id))[0]).toMatchObject({ serviceCode: 'SANITATION', quantity: 2, quantitySource: 'OCCUPANTS' });

      const patched = (
        await http.patch(`/api/v1/contracts/${c.id}`).set(w.pm.h).send({ coOccupants: [{ tenantId: a.id }, { tenantId: b.id }], rentedRoomAssetIds: [u2], monthlyRoomRent: 6_000_000, version: c.version }).expect(200)
      ).body.data;
      expect(patched.plannedCoOccupants.map((p: any) => p.tenantId)).toEqual([a.id, b.id]);
      expect(patched.rentedAssets.map((x: any) => x.roomAssetId)).toEqual([u2]);
      expect(patched.monthlyRoomRent).toBe(6_000_000);
      expect((await services(w, c.id))[0].quantity).toBe(3);
      expect((await http.patch(`/api/v1/contracts/${c.id}`).set(w.pm.h).send({ paymentDueDay: 10, version: c.version }).expect(409)).body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');
      // Kiểm tra lại toàn bộ bản nháp sau khi gộp: hạ ngày kết thúc trước ngày chuyển đến dự kiến → 400
      await http.patch(`/api/v1/contracts/${c.id}`).set(w.pm.h).send({ coOccupants: [{ tenantId: a.id, movedInAt: term.endDate }], endDate: addDays(term.endDate, -1) }).expect(400);
    });

    it('should cancel a draft: room AVAILABLE again, units released, and no further changes', async () => {
      const w = await createWorld();
      const r = await room(w);
      const u = await unit(w, r.id);
      const c = await drafted(w, { roomId: r.id, primaryTenantId: (await person(w)).id, rentedRoomAssetIds: [u] });
      // Phòng bị bản nháp giữ: không đổi trạng thái tay, không chuyển / gỡ thiết bị đang cho thuê
      expect((await http.patch(`/api/v1/properties/rooms/${r.id}`).set(w.pm.h).send({ status: 'AVAILABLE' }).expect(409)).body.details[0].issue).toBe('ROOM_RESERVED_BY_DRAFT');
      expect((await http.delete(`/api/v1/assets/room-assignments/${u}`).set(w.pm.h).expect(409)).body.errorCode).toBe('BIZ_ASSET_UNDER_CONTRACT');
      const elsewhere = await room(w);
      expect((await http.patch(`/api/v1/assets/room-assignments/${u}`).set(w.pm.h).send({ roomId: elsewhere.id }).expect(409)).body.errorCode).toBe('BIZ_ASSET_UNDER_CONTRACT');
      await http.patch(`/api/v1/assets/room-assignments/${u}`).set(w.pm.h).send({ conditionGrade: 'GRADE_B_GOOD' }).expect(200); // đổi tình trạng vẫn được

      const cancelled = (await post(`/contracts/${c.id}/cancel`, {}, w.pm.h).expect(201)).body.data;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', plannedCoOccupants: null, rentedAssets: [] });
      expect(cancelled.cancelledAt).toBeTruthy();
      expect((await get(`/properties/rooms/${r.id}`, w.pm.h).expect(200)).body.data.status).toBe('AVAILABLE');
      await http.delete(`/api/v1/assets/room-assignments/${u}`).set(w.pm.h).expect(204);
      expect((await post(`/contracts/${c.id}/cancel`, {}, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_DRAFT');
      expect((await activate(w, c.id).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_DRAFT');
      // Phòng nhận bản nháp mới
      await drafted(w, { roomId: r.id, primaryTenantId: (await person(w)).id });
    });
  });

  // ===========================================================================
  describe('Activation (POST /contracts/{id}/activate)', () => {
    it('should move everybody in, hold the deposit, occupy the room, record handover and provision adult accounts', async () => {
      const w = await createWorld();
      const r = await room(w);
      const u = await unit(w, r.id);
      const holder = await person(w);
      const kid = await child(w, holder.id);
      const krPhone = `+82 10-${String(1000 + (Date.now() % 9000))}-${String(1000 + (counter++ % 9000))}`;
      const foreigner = await person(w, { passport: true, gender: 'FEMALE', phone: krPhone });
      const c = await drafted(w, {
        roomId: r.id,
        primaryTenantId: holder.id,
        coOccupants: [{ tenantId: kid.id, relationshipToHolder: 'Con' }, { tenantId: foreigner.id, movedInAt: addDays(term.startDate, 3), successionOrder: 1 }],
        rentedRoomAssetIds: [u],
      });
      // Tình trạng thiết bị thay đổi giữa lúc lập nháp và lúc bàn giao
      await owner.query(`UPDATE room_assets SET condition_grade = 'GRADE_B_GOOD' WHERE id = $1`, [u]);

      const active = (await activate(w, c.id).expect(201)).body.data;
      expect(active).toMatchObject({ status: 'ACTIVE', depositStatus: 'HELD', depositBalance: 6_500_000, activeOccupantCount: 3, plannedCoOccupants: null, registeredEvnQuotaHeadcount: 0 });
      expect(active.rentedAssets[0].handoverCondition).toBe('GRADE_B_GOOD');

      const people = await occupants(w, c.id);
      expect(people.map((p: any) => [p.tenantId, p.role, p.residencyStatus, p.residenceChannel])).toEqual([
        [holder.id, 'PRIMARY_HOLDER', 'PENDING_DECLARATION', 'CT01'],
        [kid.id, 'CO_OCCUPANT', 'PENDING_DECLARATION', 'CT01'],
        [foreigner.id, 'CO_OCCUPANT', 'PENDING_DECLARATION', 'FOREIGNER_TEMPORARY_RESIDENCE'],
      ]);
      expect(people[1]).toMatchObject({ relationshipToHolder: 'Con', isMinor: true, movedInAt: term.startDate });
      expect(people[2]).toMatchObject({ successionOrder: 1, movedInAt: addDays(term.startDate, 3) });
      expect(await ledger(w, c.id)).toEqual([expect.objectContaining({ entryNo: 1, transactionType: 'INITIAL_COLLECTION', amount: 6_500_000, balanceAfter: 6_500_000, counterpartyTenantId: holder.id })]);

      const detail = (await get(`/properties/rooms/${r.id}`, w.pm.h).expect(200)).body.data;
      expect(detail).toMatchObject({
        status: 'OCCUPIED',
        activeContract: { id: c.id, contractCode: c.contractCode, primaryTenantName: holder.fullName, occupantCount: 3, monthlyRoomRent: 6_500_000, depositHeld: 6_500_000, startDate: term.startDate, endDate: term.endDate },
      });

      const types = (await events(c.id)).map((e) => e.event_type);
      expect(types.filter((t) => t === 'contract.activated')).toHaveLength(1);
      expect(types.filter((t) => t === 'occupant.moved_in')).toHaveLength(3);
      expect(types.filter((t) => t === 'residence.declaration_required')).toHaveLength(3);
      expect(types).toContain('deposit.collected');

      // Tài khoản: người lớn có số điện thoại (kể cả người nước ngoài) - trẻ em thì không
      const accounts = await owner.query(
        `SELECT t.id, u.status, u.phone_e164, (SELECT array_agg(role_code) FROM user_roles ur WHERE ur.user_id = u.id) AS roles,
                EXISTS (SELECT 1 FROM user_building_access a WHERE a.user_id = u.id AND a.building_id = t.building_id) AS access
           FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1)`,
        [[holder.id, kid.id, foreigner.id]],
      );
      const byId = new Map(accounts.map((a: any) => [a.id, a]));
      expect(byId.get(holder.id)).toMatchObject({ status: 'PENDING_ACTIVATION', roles: ['TENANT'], access: true });
      expect(byId.get(foreigner.id)).toMatchObject({ phone_e164: krPhone.replace(/[^+\d]/g, ''), roles: ['TENANT'] });
      expect(byId.get(kid.id)).toMatchObject({ status: null });
    });

    it('should give the tenant their own room and contract only after activation, without the holder ID number', async () => {
      const w = await createWorld();
      const r = await room(w);
      const holder = await person(w);
      const c = await drafted(w, { roomId: r.id, primaryTenantId: holder.id });
      await activate(w, c.id).expect(201);
      const th = await tenantHeaders(w, holder.id);

      expect((await get('/properties/rooms/mine', th).expect(200)).body.data).toMatchObject({ id: r.id, activeContract: { id: c.id } });
      await get(`/properties/rooms/${r.id}`, th).expect(200);
      await get(`/properties/rooms/${(await room(w)).id}`, th).expect(403);
      const mine = (await get('/contracts/mine', th).expect(200)).body.data;
      expect(mine).toMatchObject({ id: c.id, primaryHolder: { tenantId: holder.id, fullName: holder.fullName } });
      expect(mine.primaryHolder.idCardMasked).toBeUndefined();
      expect((await get('/tenants/me', th).expect(200)).body.data.id).toBe(holder.id);
      // Không xem được danh sách / hợp đồng theo id
      await get('/contracts', th).expect(403);
      await get(`/contracts/${c.id}`, th).expect(403);
      // Nhân viên không có hợp đồng "của mình"
      expect((await get('/contracts/mine', w.pm.h).expect(403)).body.errorCode).toBe('AUTH_FORBIDDEN_RESOURCE');
      expect((await get('/contracts/mine', w.tenantUser.h).expect(404)).body.errorCode).toBe('BIZ_NO_ACTIVE_ROOM');
    });

    it('should grant room access at once on move-in and activation, even over a cached "no room"', async () => {
      const w = await createWorld();
      const [h, y] = await Promise.all([person(w), person(w)]);
      const c1 = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: y.id }] });
      const yo = (await occupants(w, c1.id))[1];
      await post(`/contracts/${c1.id}/occupants/${yo.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200);
      const yh = await tenantHeaders(w, y.id);
      await get('/contracts/mine', yh).expect(404); // cache: không có phòng

      const c2 = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      await post(`/contracts/${c2.id}/occupants`, { tenantId: y.id, movedInAt: TODAY }, w.pm.h).expect(201);
      expect((await get('/contracts/mine', yh).expect(200)).body.data.id).toBe(c2.id);
      await post(`/contracts/${c2.id}/occupants/${(await occupants(w, c2.id))[1].occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200);
      await get('/contracts/mine', yh).expect(404);

      const c3 = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: y.id });
      expect((await get('/contracts/mine', yh).expect(200)).body.data).toMatchObject({ id: c3.id, primaryHolder: { tenantId: y.id } });
    });

    it('should require the PCCC commitment and an unexpired term', async () => {
      const w = await createWorld();
      const c = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id, pcccCommitmentSigned: false });
      expect((await activate(w, c.id).expect(422)).body).toMatchObject({ errorCode: 'BIZ_PCCC_COMMITMENT_REQUIRED', details: [{ field: 'pcccCommitmentSigned' }] });
      await http.patch(`/api/v1/contracts/${c.id}`).set(w.pm.h).send({ pcccCommitmentSigned: true }).expect(200);
      await activate(w, c.id).expect(201);

      const past = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id, startDate: '2025-01-01', endDate: addDays(TODAY, -1) });
      expect((await activate(w, past.id).expect(400)).body.details[0].field).toBe('endDate');
    });

    it('should refuse anyone still living in another room, writing nothing', async () => {
      const w = await createWorld();
      const [h1, h2, roomie] = await Promise.all([person(w), person(w), person(w)]);
      await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h1.id, coOccupants: [{ tenantId: roomie.id }] });
      const r = await room(w);
      const c = await drafted(w, { roomId: r.id, primaryTenantId: h2.id, coOccupants: [{ tenantId: roomie.id }] });
      const res = await activate(w, c.id).expect(409);
      expect(res.body).toMatchObject({ errorCode: 'BIZ_OCCUPANT_ALREADY_ACTIVE', details: [{ issue: 'LIVES_IN_ANOTHER_ROOM', tenantId: roomie.id }] });
      expect(await owner.query(`SELECT 1 FROM contract_occupants WHERE contract_id = $1`, [c.id])).toEqual([]);
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data.status).toBe('DRAFT');
      expect((await get(`/properties/rooms/${r.id}`, w.pm.h).expect(200)).body.data.status).toBe('RESERVED');
    });

    it('should replay the same Idempotency-Key and refuse a second activation', async () => {
      const w = await createWorld();
      const c = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      const key = randomUUID();
      const first = await http.post(`/api/v1/contracts/${c.id}/activate`).set(w.pm.h).set('Idempotency-Key', key).send({}).expect(201);
      const replay = await http.post(`/api/v1/contracts/${c.id}/activate`).set(w.pm.h).set('Idempotency-Key', key).send({}).expect(201);
      expect(replay.body.data).toEqual(first.body.data);
      expect((await activate(w, c.id).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_DRAFT');
      await http.post(`/api/v1/contracts/${c.id}/activate`).set(w.pm.h).send({}).expect(400); // thiếu Idempotency-Key
      expect(await ledger(w, c.id)).toHaveLength(1);
    });

    it('should hold a zero deposit without a ledger row', async () => {
      const w = await createWorld();
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id, depositAmount: 0 });
      expect(c).toMatchObject({ depositStatus: 'HELD', depositAmount: 0, depositBalance: 0 });
      expect(await ledger(w, c.id)).toEqual([]);
    });
  });

  // ===========================================================================
  describe('Occupants move in / out', () => {
    it('should add a co-occupant up to exactly the capacity, then refuse with BIZ_OCCUPANT_LIMIT_EXCEEDED', async () => {
      const w = await createWorld();
      const r = await room(w, { maxOccupants: 2 });
      const [h, a, b] = await Promise.all([person(w), person(w), person(w)]);
      const c = await activeContract(w, { roomId: r.id, primaryTenantId: h.id });
      await post(`/contracts/${c.id}/services`, { serviceCatalogId: w.catalog.SANITATION }, w.pm.h).expect(201);

      const added = (await post(`/contracts/${c.id}/occupants`, { tenantId: a.id, movedInAt: TODAY, successionOrder: 2 }, w.pm.h).expect(201)).body.data;
      expect(added).toMatchObject({ tenantId: a.id, role: 'CO_OCCUPANT', status: 'ACTIVE', residencyStatus: 'PENDING_DECLARATION', successionOrder: 2 });
      expect((await services(w, c.id))[0].quantity).toBe(2);
      expect((await owner.query(`SELECT user_id FROM tenants WHERE id = $1`, [a.id]))[0].user_id).toBeTruthy();

      expect((await post(`/contracts/${c.id}/occupants`, { tenantId: b.id, movedInAt: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_OCCUPANT_LIMIT_EXCEEDED');
      expect((await post(`/contracts/${c.id}/occupants`, { tenantId: a.id, movedInAt: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_OCCUPANT_ALREADY_ACTIVE');
      // Không hạ sức chứa của phòng xuống dưới số người đang ở
      expect((await http.patch(`/api/v1/properties/rooms/${r.id}`).set(w.pm.h).send({ maxOccupants: 1 }).expect(409)).body.details[0]).toMatchObject({ issue: 'BELOW_CURRENT_OCCUPANTS', occupants: 2 });
    });

    it('should check move-in dates and the contract status', async () => {
      const w = await createWorld();
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      const a = await person(w);
      expect((await post(`/contracts/${c.id}/occupants`, { tenantId: a.id, movedInAt: addDays(TODAY, 1) }, w.pm.h).expect(400)).body.details[0].message).toBe('Cannot be in the future');
      expect((await post(`/contracts/${c.id}/occupants`, { tenantId: a.id, movedInAt: addDays(term.startDate, -1) }, w.pm.h).expect(400)).body.details[0].field).toBe('movedInAt');
      const d = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      expect((await post(`/contracts/${d.id}/occupants`, { tenantId: a.id, movedInAt: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_ACTIVE');
    });

    it('should let one person move into only one of two rooms at the same time', async () => {
      const w = await createWorld();
      const [c1, c2] = [
        await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id }),
        await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id }),
      ];
      const a = await person(w);
      const results = await Promise.all([
        post(`/contracts/${c1.id}/occupants`, { tenantId: a.id, movedInAt: TODAY }, w.pm.h),
        post(`/contracts/${c2.id}/occupants`, { tenantId: a.id, movedInAt: TODAY }, w.pm.h),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(results.find((x) => x.status === 409)!.body.errorCode).toBe('BIZ_OCCUPANT_ALREADY_ACTIVE');
      expect(await owner.query(`SELECT 1 FROM contract_occupants WHERE tenant_id = $1 AND status = 'ACTIVE'`, [a.id])).toHaveLength(1);
    });

    it('should move a co-occupant out: residence follow-up, vehicles off, services and EVN quota recomputed, access ends', async () => {
      const w = await createWorld();
      const r = await room(w);
      const [h, a, b] = await Promise.all([person(w), person(w), person(w)]);
      const c = await activeContract(w, { roomId: r.id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }, { tenantId: b.id }] });
      await post(`/contracts/${c.id}/services`, { serviceCatalogId: w.catalog.SANITATION }, w.pm.h).expect(201);
      const [ho, ao, bo] = await occupants(w, c.id);
      const res = (o: any, residencyStatus: string, extra = {}) =>
        http.patch(`/api/v1/contracts/${c.id}/occupants/${o.occupantId}/residency`).set(w.pm.h).send({ residencyStatus, ...extra });
      await res(ao, 'SUBMITTED').expect(200);
      await res(ao, 'REGISTERED', { temporaryStayValidUntil: addYears(TODAY, 1) }).expect(200);
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data.registeredEvnQuotaHeadcount).toBe(1);
      const plate = `59-${unique().slice(0, 2)} ${String(Date.now()).slice(-5)}`.replace(/[^A-Z0-9 -]/g, '1');
      await post(`/contracts/${c.id}/vehicles`, { ownerTenantId: a.id, vehicleType: 'MOTORBIKE', licensePlate: plate, brandModel: 'Wave' }, w.pm.h).expect(201);
      const aTenant = await tenantHeaders(w, a.id);
      await get(`/properties/rooms/${r.id}`, aTenant).expect(200); // đang ở: xem được (và được cache)

      expect((await post(`/contracts/${c.id}/occupants/${ho.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_PRIMARY_HOLDER_USE_TRANSFER');
      expect((await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: addDays(term.startDate, -1) }, w.pm.h).expect(400)).body.details[0].field).toBe('movedOutAt');
      const out = (await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200)).body.data;
      expect(out).toMatchObject({ status: 'MOVED_OUT', movedOutAt: TODAY, residencyStatus: 'DEREGISTRATION_PENDING' });
      // Người chưa từng khai báo: không có gì để xóa đăng ký
      expect((await post(`/contracts/${c.id}/occupants/${bo.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200)).body.data.residencyStatus).toBe('DEREGISTERED');
      expect((await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_OCCUPANT_NOT_ACTIVE');

      const after = (await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data;
      expect(after).toMatchObject({ registeredEvnQuotaHeadcount: 0, activeOccupantCount: 1, depositBalance: 6_500_000 });
      expect((await services(w, c.id)).map((s) => [s.serviceCode, s.quantity])).toEqual([['SANITATION', 1]]); // gói gửi xe đã gỡ
      expect((await get(`/contracts/${c.id}/vehicles?status=ALL`, w.pm.h).expect(200)).body.data[0]).toMatchObject({ isActive: false, deactivatedAt: TODAY });
      expect((await occupants(w, c.id, 'ALL')).map((o: any) => o.status)).toEqual(['ACTIVE', 'MOVED_OUT', 'MOVED_OUT']);
      // Hết quyền xem phòng ngay khi chuyển đi (cache phạm vi đã xóa)
      await get(`/properties/rooms/${r.id}`, aTenant).expect(403);
      expect((await get('/contracts/mine', aTenant).expect(404)).body.errorCode).toBe('BIZ_NO_ACTIVE_ROOM');
      const types = (await events(c.id)).map((e) => e.event_type);
      expect(types.filter((t) => t === 'occupant.moved_out')).toHaveLength(2);
      expect(types.filter((t) => t === 'residence.deregistration_required')).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('Residence status per person', () => {
    it('should follow PENDING → SUBMITTED → REGISTERED (≤ 2 years) and recompute the EVN quota from REGISTERED people only', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const [ho, ao] = await occupants(w, c.id);
      const set = (o: any, body: object, h2 = w.pm.h) => http.patch(`/api/v1/contracts/${c.id}/occupants/${o.occupantId}/residency`).set(h2).send(body);

      expect((await set(ho, { residencyStatus: 'REGISTERED', temporaryStayValidUntil: addYears(TODAY, 1) }).expect(409)).body).toMatchObject({
        errorCode: 'BIZ_RESIDENCY_TRANSITION_INVALID',
        details: [{ from: 'PENDING_DECLARATION', to: 'REGISTERED', allowed: 'SUBMITTED' }],
      });
      expect((await set(ho, { residencyStatus: 'SUBMITTED', temporaryStayValidUntil: addYears(TODAY, 1) }).expect(400)).body.details[0].field).toBe('temporaryStayValidUntil');
      expect((await set(ho, { residencyStatus: 'SUBMITTED', referenceNo: 'VNeID-1' }).expect(200)).body.data).toMatchObject({ residencyStatus: 'SUBMITTED', residenceReferenceNo: 'VNeID-1' });
      await set(ho, { residencyStatus: 'REGISTERED' }).expect(400);
      expect((await set(ho, { residencyStatus: 'REGISTERED', temporaryStayValidUntil: addDays(addYears(TODAY, 2), 1) }).expect(400)).body.details[0].message).toBe('At most 2 years from today');
      await set(ho, { residencyStatus: 'REGISTERED', temporaryStayValidUntil: addYears(TODAY, 2) }).expect(200);
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data.registeredEvnQuotaHeadcount).toBe(1);
      await set(ao, { residencyStatus: 'SUBMITTED' }).expect(200);
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data.registeredEvnQuotaHeadcount).toBe(1); // SUBMITTED không tính
      await set(ao, { residencyStatus: 'DEREGISTERED' }).expect(409);

      // Kế toán: chỉ đọc cư trú (compliance:read) → 403
      await set(ao, { residencyStatus: 'REGISTERED', temporaryStayValidUntil: addYears(TODAY, 1) }, w.accountant.h).expect(403);
      expect((await events(c.id)).filter((e) => e.event_type === 'residence.status_changed').map((e) => e.payload.data?.to ?? e.payload.to)).toEqual(['SUBMITTED', 'REGISTERED', 'SUBMITTED']);
    });

    it('should finish deregistration after moving out', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const ao = (await occupants(w, c.id))[1];
      const set = (body: object) => http.patch(`/api/v1/contracts/${c.id}/occupants/${ao.occupantId}/residency`).set(w.pm.h).send(body);
      await set({ residencyStatus: 'SUBMITTED' }).expect(200);
      await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200);
      await set({ residencyStatus: 'REGISTERED', temporaryStayValidUntil: addYears(TODAY, 1) }).expect(409);
      expect((await set({ residencyStatus: 'DEREGISTERED', referenceNo: 'XOA-1' }).expect(200)).body.data).toMatchObject({ residencyStatus: 'DEREGISTERED', residenceReferenceNo: 'XOA-1' });
    });
  });

  // ===========================================================================
  describe('Contract-holder transfer', () => {
    it('should pass the contract to the earliest eligible adult (skipping a child) and carry the deposit over', async () => {
      const w = await createWorld();
      const r = await room(w, { maxOccupants: 4 });
      const holder = await person(w);
      const kid = await child(w, holder.id);
      const [early, late] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, {
        roomId: r.id,
        primaryTenantId: holder.id,
        coOccupants: [{ tenantId: kid.id }, { tenantId: late.id, movedInAt: addDays(term.startDate, 5) }, { tenantId: early.id, movedInAt: addDays(term.startDate, 1) }],
      });
      const plate = `51F-${String(Date.now()).slice(-5)}`;
      await post(`/contracts/${c.id}/vehicles`, { ownerTenantId: holder.id, vehicleType: 'MOTORBIKE', licensePlate: plate, brandModel: 'SH' }, w.pm.h).expect(201);
      const holderTenant = await tenantHeaders(w, holder.id);
      await get('/contracts/mine', holderTenant).expect(200);

      const t = (await post(`/contracts/${c.id}/primary-holder/transfer`, { effectiveDate: TODAY }, w.pm.h).expect(201)).body.data;
      expect(t).toMatchObject({
        fromTenantId: holder.id,
        toTenantId: early.id,
        selection: 'AUTO_SUCCESSION',
        reason: 'HOLDER_MOVED_OUT',
        depositHandling: 'CARRY_OVER',
        outstandingBalance: 0,
        addendumNo: c.contractCode.replace(/^HD-/, 'PL-') + '-01',
        addendumDownloadUrl: null,
      });
      expect(t.newHolderIdCardMasked).toMatch(/^\*{8}\d{4}$/);
      const after = (await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data;
      expect(after).toMatchObject({ primaryHolder: { tenantId: early.id }, activeOccupantCount: 3, depositBalance: 6_500_000 });
      const people = await occupants(w, c.id, 'ALL');
      expect(people[0]).toMatchObject({ tenantId: early.id, role: 'PRIMARY_HOLDER', status: 'ACTIVE' });
      expect(people.find((p: any) => p.tenantId === holder.id)).toMatchObject({ role: 'CO_OCCUPANT', status: 'MOVED_OUT', movedOutAt: TODAY, residencyStatus: 'DEREGISTERED' });
      expect((await ledger(w, c.id)).map((l) => [l.transactionType, l.amount, l.counterpartyTenantId, l.holderTransferId])).toEqual([
        ['INITIAL_COLLECTION', 6_500_000, holder.id, null],
        ['HOLDER_TRANSFER_CARRY_OVER', 0, early.id, t.transferId],
      ]);
      expect((await get(`/contracts/${c.id}/vehicles`, w.pm.h).expect(200)).body.data).toEqual([]);
      expect((await get(`/contracts/${c.id}/primary-holder/history`, w.pm.h).expect(200)).body.data.map((h: any) => h.transferId)).toEqual([t.transferId]);
      expect((await get(`/contracts?tenantId=${holder.id}`, w.pm.h).expect(200)).body.data.map((x: any) => x.id)).toEqual([c.id]);
      // Người cũ mất quyền ngay; người mới (đã có tài khoản từ lúc chuyển đến) thấy hợp đồng với tư cách người đứng tên
      expect((await get('/contracts/mine', holderTenant).expect(404)).body.errorCode).toBe('BIZ_NO_ACTIVE_ROOM');
      expect((await get('/contracts/mine', await tenantHeaders(w, early.id)).expect(200)).body.data.primaryHolder.tenantId).toBe(early.id);
      expect((await events(c.id)).map((e) => e.event_type)).toEqual(expect.arrayContaining(['contract.primary_holder_changed']));
    });

    it('should refund the outgoing holder and collect again from the successor (REFUND_AND_RECOLLECT), holder staying on', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const t = (
        await post(`/contracts/${c.id}/primary-holder/transfer`, { effectiveDate: TODAY, newPrimaryTenantId: a.id, outgoingHolderStays: true, depositHandling: 'REFUND_AND_RECOLLECT', outstandingBalanceAssumedBy: 'INCOMING_HOLDER' }, w.pm.h).expect(201)
      ).body.data;
      expect(t).toMatchObject({ selection: 'DESIGNATED', reason: 'MUTUAL_AGREEMENT', outstandingBalanceAssumedBy: 'INCOMING_HOLDER' });
      expect((await ledger(w, c.id)).map((l) => [l.entryNo, l.transactionType, l.amount, l.balanceAfter, l.counterpartyTenantId])).toEqual([
        [1, 'INITIAL_COLLECTION', 6_500_000, 6_500_000, h.id],
        [2, 'HOLDER_TRANSFER_REFUND', -6_500_000, 0, h.id],
        [3, 'HOLDER_TRANSFER_COLLECTION', 6_500_000, 6_500_000, a.id],
      ]);
      expect((await occupants(w, c.id)).map((o: any) => [o.tenantId, o.role, o.status])).toEqual([
        [a.id, 'PRIMARY_HOLDER', 'ACTIVE'],
        [h.id, 'CO_OCCUPANT', 'ACTIVE'],
      ]);
    });

    it('should refuse ineligible successors, a room of only children, and the last occupant', async () => {
      const w = await createWorld();
      const h = await person(w);
      const kid = await child(w, h.id, 17);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: kid.id }] });
      const transfer = (body: object) => post(`/contracts/${c.id}/primary-holder/transfer`, { effectiveDate: TODAY, ...body }, w.pm.h);
      expect((await transfer({ newPrimaryTenantId: kid.id }).expect(422)).body).toMatchObject({ errorCode: 'BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE', details: [{ field: 'newPrimaryTenantId', issue: 'UNDERAGE' }] });
      expect((await transfer({}).expect(409)).body.errorCode).toBe('BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED');
      expect((await transfer({ effectiveDate: addDays(TODAY, 1) }).expect(400)).body.details[0].field).toBe('effectiveDate');

      const alone = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      expect((await post(`/contracts/${alone.id}/primary-holder/transfer`, { effectiveDate: TODAY }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT');
      // Không có gì thay đổi
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data.primaryHolder.tenantId).toBe(h.id);
      expect(await owner.query(`SELECT 1 FROM contract_holder_transfers WHERE contract_id = $1`, [c.id])).toEqual([]);
    });
  });

  // ===========================================================================
  describe('Renewal', () => {
    it('should extend the term, change the rent from the next day, top the deposit up and share the addendum counter', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const newEnd = addYears(term.endDate, 1);
      const renew = (body: object) => post(`/contracts/${c.id}/renew`, body, w.pm.h);

      expect((await renew({ newEndDate: term.endDate }).expect(400)).body.details[0].field).toBe('newEndDate');
      const r1 = (await renew({ newEndDate: newEnd, newMonthlyRoomRent: 7_000_000, topUpDeposit: true, notes: 'Tăng giá theo thỏa thuận' }).expect(201)).body.data;
      expect(r1).toMatchObject({
        previousEndDate: term.endDate,
        newEndDate: newEnd,
        effectiveDate: addDays(term.endDate, 1),
        previousMonthlyRent: 6_500_000,
        newMonthlyRent: 7_000_000,
        depositTopUpAmount: 500_000,
        addendumNo: c.contractCode.replace(/^HD-/, 'PL-') + '-01',
      });
      expect((await get(`/contracts/${c.id}`, w.pm.h).expect(200)).body.data).toMatchObject({ endDate: newEnd, monthlyRoomRent: 7_000_000, depositAmount: 7_000_000, depositBalance: 7_000_000 });
      expect((await ledger(w, c.id)).map((l) => [l.transactionType, l.amount, l.balanceAfter])).toEqual([
        ['INITIAL_COLLECTION', 6_500_000, 6_500_000],
        ['TOP_UP', 500_000, 7_000_000],
      ]);
      // Gia hạn không đổi giá, không bù cọc → không có dòng sổ cái mới
      await renew({ newEndDate: addYears(newEnd, 1) }).expect(201);
      expect(await ledger(w, c.id)).toHaveLength(2);
      const t = (await post(`/contracts/${c.id}/primary-holder/transfer`, { effectiveDate: TODAY }, w.pm.h).expect(201)).body.data;
      expect(t.addendumNo).toBe(c.contractCode.replace(/^HD-/, 'PL-') + '-03');
      expect((await get(`/contracts/${c.id}/renewals`, w.pm.h).expect(200)).body.data.map((x: any) => x.addendumNo.slice(-2))).toEqual(['01', '02']);
      expect((await get(`/contracts?endingBefore=${addYears(newEnd, 1)}&status=ACTIVE`, w.pm.h).expect(200)).body.data.map((x: any) => x.id)).toContain(c.id);
    });

    it('should renew only active contracts', async () => {
      const w = await createWorld();
      const d = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      expect((await post(`/contracts/${d.id}/renew`, { newEndDate: addYears(term.endDate, 1) }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_ACTIVE');
    });
  });

  // ===========================================================================
  describe('Vehicles & services', () => {
    it('should count parking per active vehicle of the matching type, normalise plates and keep them unique among active vehicles', async () => {
      const w = await createWorld();
      const [h, a, other] = await Promise.all([person(w), person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const c2 = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: other.id });
      const reg = (contractId: string, body: object) => post(`/contracts/${contractId}/vehicles`, { vehicleType: 'MOTORBIKE', brandModel: 'Vision', ...body }, w.pm.h);
      const n = String(Date.now()).slice(-5);
      const plate = `59-G${n.slice(0, 1)} ${n}`;

      const v1 = (await reg(c.id, { ownerTenantId: h.id, licensePlate: ` ${plate.toLowerCase().replace(' ', '  ')} `, parkingCardCode: `card-${n}` }).expect(201)).body.data;
      expect(v1).toMatchObject({ licensePlate: plate, parkingCardCode: `CARD-${n}`, isActive: true, ownerName: h.fullName });
      expect((await services(w, c.id)).map((s) => [s.serviceCode, s.quantity, s.quantitySource])).toEqual([['PARKING_MOTORBIKE', 1, 'VEHICLES']]);
      await reg(c.id, { ownerTenantId: a.id, licensePlate: `29-A1 ${n}` }).expect(201);
      expect((await services(w, c.id))[0].quantity).toBe(2);
      await reg(c.id, { ownerTenantId: a.id, vehicleType: 'BICYCLE' }).expect(201); // xe đạp: không biển số, không có gói
      expect((await services(w, c.id))).toHaveLength(1);

      expect((await reg(c2.id, { ownerTenantId: other.id, licensePlate: plate }).expect(409)).body).toMatchObject({ errorCode: 'RES_ALREADY_EXISTS', details: [{ field: 'licensePlate' }] });
      expect((await reg(c2.id, { ownerTenantId: other.id, licensePlate: `30-B2 ${n}`, parkingCardCode: `CARD-${n}` }).expect(409)).body.details[0].field).toBe('parkingCardCode');
      expect((await reg(c2.id, { ownerTenantId: other.id }).expect(400)).body.details[0].field).toBe('licensePlate');
      expect((await reg(c2.id, { ownerTenantId: other.id, licensePlate: 'ABCDEF' }).expect(400)).body.details[0].message).toMatch(/licence plate/);
      expect((await reg(c2.id, { ownerTenantId: h.id, licensePlate: `31-C3 ${n}` }).expect(409)).body).toMatchObject({ errorCode: 'BIZ_OCCUPANT_NOT_ACTIVE', details: [{ field: 'ownerTenantId' }] });

      await post(`/contracts/${c.id}/vehicles/${v1.id}/deactivate`, {}, w.pm.h).expect(201);
      expect((await post(`/contracts/${c.id}/vehicles/${v1.id}/deactivate`, {}, w.pm.h).expect(409)).body.errorCode).toBe('RES_CONFLICT');
      expect((await services(w, c.id))[0].quantity).toBe(1);
      // Biển số của xe đã ngừng dùng lại được
      await reg(c2.id, { ownerTenantId: other.id, licensePlate: plate }).expect(201);
      expect((await post(`/contracts/${c.id}/vehicles/${v1.id}/deactivate`, { deactivatedAt: addDays(TODAY, 1) }, w.pm.h).expect(400)).body.details[0].field).toBe('deactivatedAt');
    });

    it('should manage per-room services and refuse to hand-set derived quantities', async () => {
      const w = await createWorld();
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      const add = (body: object) => post(`/contracts/${c.id}/services`, body, w.pm.h);
      const wifi = (await add({ serviceCatalogId: w.catalog.WIFI, quantity: 2, agreedUnitPrice: 120_000 }).expect(201)).body.data;
      expect(wifi).toMatchObject({ serviceCode: 'WIFI', quantity: 2, agreedUnitPrice: 120_000, quantitySource: 'MANUAL' });
      expect((await add({ serviceCatalogId: w.catalog.WIFI }).expect(409)).body.errorCode).toBe('RES_ALREADY_EXISTS');
      expect((await add({ serviceCatalogId: w.catalog.PARKING_MOTORBIKE }).expect(409)).body.errorCode).toBe('BIZ_SERVICE_QUANTITY_DERIVED');
      expect((await add({ serviceCatalogId: w.catalog.SANITATION, quantity: 3 }).expect(409)).body.errorCode).toBe('BIZ_SERVICE_QUANTITY_DERIVED');
      const sanitation = (await add({ serviceCatalogId: w.catalog.SANITATION }).expect(201)).body.data;
      expect(sanitation).toMatchObject({ quantity: 1, agreedUnitPrice: 30_000 });
      expect((await http.patch(`/api/v1/contracts/${c.id}/services/${sanitation.subscriptionId}`).set(w.pm.h).send({ quantity: 4 }).expect(409)).body.errorCode).toBe('BIZ_SERVICE_QUANTITY_DERIVED');
      expect((await http.patch(`/api/v1/contracts/${c.id}/services/${wifi.subscriptionId}`).set(w.pm.h).send({ quantity: 1, agreedUnitPrice: 100_000 }).expect(200)).body.data).toMatchObject({ quantity: 1, agreedUnitPrice: 100_000 });
      await http.patch(`/api/v1/contracts/${c.id}/services/${wifi.subscriptionId}`).set(w.pm.h).send({}).expect(400);
      await http.delete(`/api/v1/contracts/${c.id}/services/${wifi.subscriptionId}`).set(w.pm.h).expect(204);
      await add({ serviceCatalogId: w.catalog.WIFI }).expect(201); // bỏ rồi đăng ký lại được
      // Hợp đồng đã hủy: không đổi dịch vụ
      const d = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      await post(`/contracts/${d.id}/cancel`, {}, w.pm.h).expect(201);
      expect((await post(`/contracts/${d.id}/services`, { serviceCatalogId: w.catalog.WIFI }, w.pm.h).expect(409)).body.errorCode).toBe('BIZ_CONTRACT_NOT_ACTIVE');
    });

    it('should keep the service catalogue consistent (vehicle type rule, unique codes, items in use)', async () => {
      const w = await createWorld();
      const create = (body: object) => http.post('/api/v1/service-catalog').set(w.pm.h).send({ name: 'x', defaultUnitPrice: 1000, ...body });
      expect((await create({ code: 'PARKING_EBIKE', chargeUnit: 'PER_VEHICLE_MONTH' }).expect(400)).body.details[0].field).toBe('vehicleType');
      expect((await create({ code: 'GYM', chargeUnit: 'PER_PERSON_MONTH', vehicleType: 'CAR' }).expect(400)).body.details[0].field).toBe('vehicleType');
      expect((await create({ code: 'WIFI', chargeUnit: 'PER_ROOM_MONTH' }).expect(409)).body.details[0].field).toBe('code');
      expect((await create({ code: 'PARKING_CAR_2', chargeUnit: 'PER_VEHICLE_MONTH', vehicleType: 'CAR' }).expect(409)).body.details[0].field).toBe('vehicleType');
      expect((await create({ code: 'gym', chargeUnit: 'PER_PERSON_MONTH' }).expect(201)).body.data.code).toBe('GYM');
      await create({ code: '1GYM', chargeUnit: 'PER_PERSON_MONTH' }).expect(400);

      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      await post(`/contracts/${c.id}/services`, { serviceCatalogId: w.catalog.WIFI }, w.pm.h).expect(201);
      expect((await http.patch(`/api/v1/service-catalog/${w.catalog.WIFI}`).set(w.pm.h).send({ chargeUnit: 'PER_PERSON_MONTH' }).expect(409)).body.errorCode).toBe('BIZ_SERVICE_IN_USE');
      expect((await http.delete(`/api/v1/service-catalog/${w.catalog.WIFI}`).set(w.pm.h).expect(409)).body.errorCode).toBe('BIZ_SERVICE_IN_USE');
      // Đổi giá mặc định không ảnh hưởng giá đã thỏa thuận
      await http.patch(`/api/v1/service-catalog/${w.catalog.WIFI}`).set(w.pm.h).send({ defaultUnitPrice: 999_000 }).expect(200);
      expect((await services(w, c.id))[0].agreedUnitPrice).toBe(150_000);
      await http.delete(`/api/v1/service-catalog/${w.catalog.PARKING_CAR}`).set(w.pm.h).expect(204);
      await create({ code: 'PARKING_CAR', chargeUnit: 'PER_VEHICLE_MONTH', vehicleType: 'CAR' }).expect(201); // mã & loại xe được giải phóng
      await http.post('/api/v1/service-catalog').set(w.accountant.h).send({ code: 'X1', name: 'x', chargeUnit: 'PER_ROOM_MONTH', defaultUnitPrice: 1 }).expect(403);
      await get('/service-catalog', w.accountant.h).expect(200);
    });
  });

  // ===========================================================================
  describe('Permissions & building isolation', () => {
    it('should apply the document 05 matrix to contracts, deposits and residence', async () => {
      const w = await createWorld();
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      await get(`/contracts/${c.id}`, w.accountant.h).expect(200);
      await get(`/contracts/${c.id}/deposit-ledger`, w.accountant.h).expect(200);
      await get(`/contracts/${c.id}`, w.landlord.h).expect(200);
      await draft(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id }, w.accountant.h).expect(403);
      await post(`/contracts/${c.id}/renew`, { newEndDate: addYears(term.endDate, 1) }, w.accountant.h).expect(403);
      await get('/contracts', w.guard.h).expect(403);
      await get(`/contracts/${c.id}/deposit-ledger`, w.guard.h).expect(403);
      await get(`/contracts/${c.id}/occupants`, w.tenantUser.h).expect(403);
    });

    it("should never reveal or change another building's contracts", async () => {
      const a = await createWorld();
      const b = await createWorld();
      const c = await activeContract(a, { roomId: (await room(a)).id, primaryTenantId: (await person(a)).id });
      await get(`/contracts/${c.id}`, b.pm.h).expect(404);
      await get(`/contracts/${c.id}/deposit-ledger`, b.pm.h).expect(404);
      await post(`/contracts/${c.id}/renew`, { newEndDate: addYears(term.endDate, 1) }, b.pm.h).expect(404);
      await post(`/contracts/${c.id}/occupants`, { tenantId: (await person(b)).id, movedInAt: TODAY }, b.pm.h).expect(404);
      expect((await get('/contracts', b.pm.h).expect(200)).body.data).toEqual([]);
      // Header tòa B với token tòa A
      await http.get(`/api/v1/contracts/${c.id}`).set({ ...a.pm.h, 'X-Building-ID': b.buildingId }).expect(403);
      // Draft trên phòng tòa A từ tòa B
      expect((await draft(b, { roomId: c.room.id, primaryTenantId: (await person(b)).id }).expect(404)).body.details[0].field).toBe('roomId');
    });
  });

  // ===========================================================================
  describe('PostgreSQL kernel guarantees (raw SQL as owner)', () => {
    const fail = async (sql: string, params: unknown[], code: string, constraint?: string) => {
      const err = await owner.query(sql, params).then(() => null, (e) => e);
      expect(err).not.toBeNull();
      expect(err.code).toBe(code);
      if (constraint) expect(String(err.constraint ?? err.message)).toContain(constraint);
    };

    it('should allow one active and one draft contract per room, one holder per contract and one room per person', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      const base = `INSERT INTO contracts (building_id, contract_code, room_id, primary_tenant_id, start_date, end_date, monthly_room_rent, deposit_amount, status, deposit_status, activated_at, pccc_commitment_signed)
                    VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 1, 0, $5, $6, $7, true)`;
      await fail(base, [w.buildingId, `X-${unique()}`, c.room.id, a.id, 'ACTIVE', 'HELD', new Date()], '23505', 'idx_unique_active_contract_per_room');
      const d = await drafted(w, { roomId: (await room(w)).id, primaryTenantId: a.id });
      await fail(base, [w.buildingId, `X-${unique()}`, d.room.id, a.id, 'DRAFT', 'PENDING_COLLECTION', null], '23505', 'idx_unique_draft_contract_per_room');
      await fail(`UPDATE contract_occupants SET role = 'PRIMARY_HOLDER' WHERE contract_id = $1 AND tenant_id = $2`, [c.id, a.id], '23505', 'idx_occupants_one_active_holder');
      const other = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
      await fail(
        `INSERT INTO contract_occupants (building_id, contract_id, tenant_id, role, moved_in_at) VALUES ($1, $2, $3, 'CO_OCCUPANT', '2026-01-01')`,
        [w.buildingId, other.id, a.id],
        '23505',
        'idx_occupants_tenant_one_active',
      );
      await fail(`INSERT INTO contracts (building_id, contract_code, room_id, primary_tenant_id, start_date, end_date, monthly_room_rent, deposit_amount) VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 1, 0)`,
        [w.buildingId, c.contractCode, (await room(w)).id, a.id], '23505', 'idx_contracts_bld_code_unique');
    });

    it('should reject at COMMIT an active contract whose holder pointer and holder row disagree', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id, coOccupants: [{ tenantId: a.id }] });
      await fail(`UPDATE contracts SET primary_tenant_id = $2 WHERE id = $1`, [c.id, a.id], '23514');
      await fail(`UPDATE contract_occupants SET role = 'CO_OCCUPANT' WHERE contract_id = $1 AND tenant_id = $2`, [c.id, h.id], '23514');
      // Đổi cả hai trong cùng transaction (đúng thứ tự index) → hợp lệ
      await owner.transaction(async (m) => {
        await m.query(`UPDATE contract_occupants SET role = 'CO_OCCUPANT' WHERE contract_id = $1 AND tenant_id = $2`, [c.id, h.id]);
        await m.query(`UPDATE contract_occupants SET role = 'PRIMARY_HOLDER' WHERE contract_id = $1 AND tenant_id = $2`, [c.id, a.id]);
        await m.query(`UPDATE contracts SET primary_tenant_id = $2 WHERE id = $1`, [c.id, a.id]);
      });
      // Bản nháp không bị kiểm tra (chưa có người ở)
      await drafted(w, { roomId: (await room(w)).id, primaryTenantId: (await person(w)).id });
    });

    it('should keep the deposit ledger append-only with signed amounts and holder-transfer references', async () => {
      const w = await createWorld();
      const h = await person(w);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id });
      await fail(`UPDATE deposit_ledgers SET amount = 1 WHERE contract_id = $1`, [c.id], '42501');
      await fail(`DELETE FROM deposit_ledgers WHERE contract_id = $1`, [c.id], '42501');
      await fail(`TRUNCATE deposit_ledgers`, [], '42501');
      const ins = (entry: number, type: string, amount: number, balance: number) =>
        `INSERT INTO deposit_ledgers (building_id, contract_id, entry_no, transaction_type, amount, balance_after, counterparty_tenant_id, recorded_by_id) VALUES ('${w.buildingId}', '${c.id}', ${entry}, '${type}', ${amount}, ${balance}, '${h.id}', '${h.id}')`;
      await fail(ins(2, 'TOP_UP', -1, 0), [], '23514', 'chk_deposit_ledgers_sign');
      await fail(ins(2, 'SURPLUS_REFUND', 1, 0), [], '23514', 'chk_deposit_ledgers_sign');
      await fail(ins(2, 'SURPLUS_REFUND', -1, -1), [], '23514', 'chk_deposit_ledgers_balance');
      await fail(ins(2, 'HOLDER_TRANSFER_CARRY_OVER', 0, 0), [], '23514', 'chk_deposit_ledgers_transfer_ref');
      await fail(ins(1, 'TOP_UP', 1, 1), [], '23505', 'idx_deposit_ledgers_contract_entry_unique');
      await owner.query(ins(2, 'TOP_UP', 1, 6_500_001)); // dòng hợp lệ đi qua
    });

    it('should enforce the row CHECKs of contracts, occupants, services, catalogue and vehicles (valid rows pass)', async () => {
      const w = await createWorld();
      const h = await person(w);
      const c = await activeContract(w, { roomId: (await room(w)).id, primaryTenantId: h.id });
      const contractRow = (extra: string, values: string) =>
        `INSERT INTO contracts (building_id, contract_code, room_id, primary_tenant_id, start_date, end_date, monthly_room_rent, deposit_amount${extra})
         VALUES ('${w.buildingId}', 'K-${unique()}', '${c.room.id}', '${h.id}', '2026-01-01', '2026-12-31', 1, 0${values})`;
      await fail(contractRow(', status, activated_at', `, 'CANCELLED', NULL`), [], '23514', 'chk_contracts_cancelled');
      await fail(contractRow(', planned_co_occupants, status, deposit_status, activated_at', `, '[]', 'TERMINATED', 'HELD', now()`), [], '23514', 'chk_contracts_plan_only_draft');
      const free = await room(w);
      await fail(
        `INSERT INTO contracts (building_id, contract_code, room_id, primary_tenant_id, start_date, end_date, monthly_room_rent, deposit_amount, status, activated_at)
         VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 1, 0, 'ACTIVE', now())`,
        [w.buildingId, `K-${unique()}`, free.id, h.id],
        '23514',
        'chk_contracts_active_deposit',
      );
      await fail(contractRow(', payment_due_day', ', 29'), [], '23514', 'chk_contracts_payment_due_day');
      await fail(contractRow(', activated_at', ', now()'), [], '23514', 'chk_contracts_activated');
      await fail(
        `UPDATE contract_occupants SET status = 'MOVED_OUT' WHERE contract_id = $1`,
        [c.id],
        '23514',
      );
      await fail(`UPDATE contract_occupants SET succession_order = 0 WHERE contract_id = $1`, [c.id], '23514', 'chk_occupants_succession_order');

      const catalog = (code: string, unit: string, vehicle: string | null) =>
        owner.query(`INSERT INTO service_catalogs (building_id, code, name, charge_unit, vehicle_type, default_unit_price) VALUES ($1, $2, 'x', $3, $4, 0)`, [w.buildingId, code, unit, vehicle]);
      await expect(catalog('lower_case', 'PER_ROOM_MONTH', null)).rejects.toMatchObject({ code: '23514', constraint: 'chk_service_catalogs_code' });
      await expect(catalog('X', 'PER_ROOM_MONTH', null)).rejects.toMatchObject({ constraint: 'chk_service_catalogs_code' });
      await expect(catalog('TRUCK', 'PER_VEHICLE_MONTH', null)).rejects.toMatchObject({ constraint: 'chk_service_catalogs_vehicle' });
      await catalog('LAUNDRY_2', 'PER_PERSON_MONTH', null); // mã hợp lệ (chữ hoa, số, _)

      const vehicle = (type: string, plate: string | null, active = true, deactivated: string | null = null) =>
        owner.query(
          `INSERT INTO tenant_vehicles (building_id, contract_id, owner_tenant_id, vehicle_type, license_plate, brand_model, is_active, deactivated_at) VALUES ($1, $2, $3, $4, $5, 'x', $6, $7)`,
          [w.buildingId, c.id, h.id, type, plate, active, deactivated],
        );
      await expect(vehicle('MOTORBIKE', null)).rejects.toMatchObject({ constraint: 'chk_vehicles_plate' });
      await expect(vehicle('MOTORBIKE', `P-${unique()}`, true, '2026-01-01')).rejects.toMatchObject({ constraint: 'chk_vehicles_active' });
      await vehicle('BICYCLE', null);
      await expect(
        owner.query(
          `INSERT INTO contract_services (building_id, contract_id, service_catalog_id, service_code, charge_unit, quantity, agreed_unit_price) VALUES ($1, $2, $3, 'WIFI', 'PER_ROOM_MONTH', 0, 0)`,
          [w.buildingId, c.id, w.catalog.WIFI],
        ),
      ).rejects.toMatchObject({ constraint: 'chk_contract_services_values' });
      await expect(
        owner.query(
          `INSERT INTO contract_renewals (building_id, contract_id, previous_end_date, new_end_date, effective_date, previous_monthly_rent, new_monthly_rent, addendum_no, approved_by_id)
           VALUES ($1, $2, '2026-12-31', '2027-12-31', '2026-12-31', 1, 1, $3, $4)`,
          [w.buildingId, c.id, `PL-${unique()}`, w.pm.id],
        ),
      ).rejects.toMatchObject({ constraint: 'chk_renewals_values' });
    });

    it('should never link rows across buildings (same-building composite FKs)', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const c = await activeContract(a, { roomId: (await room(a)).id, primaryTenantId: (await person(a)).id });
      const stranger = await person(b);
      await fail(
        `INSERT INTO contract_occupants (building_id, contract_id, tenant_id, role, moved_in_at) VALUES ($1, $2, $3, 'CO_OCCUPANT', '2026-01-01')`,
        [a.buildingId, c.id, stranger.id],
        '23503',
        'fk_occupants_tenant_same_building',
      );
      await fail(
        `INSERT INTO contract_services (building_id, contract_id, service_catalog_id, service_code, charge_unit, quantity, agreed_unit_price) VALUES ($1, $2, $3, 'WIFI', 'PER_ROOM_MONTH', 1, 0)`,
        [a.buildingId, c.id, b.catalog.WIFI],
        '23503',
        'fk_contract_services_catalog_same_building',
      );
      // Hợp đồng (nháp) của tòa A chưa gắn phòng nào → chỉ FK cùng tòa nhà chặn (không phải unique current_contract_id)
      const draftA = await drafted(a, { roomId: (await room(a)).id, primaryTenantId: (await person(a)).id });
      const roomB = await room(b);
      await fail(`UPDATE rooms SET current_contract_id = $1 WHERE id = $2`, [draftA.id, roomB.id], '23503', 'fk_rooms_current_contract_same_building');
    });
  });
});
