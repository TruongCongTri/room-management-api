/**
 * Kiểm tra CHÉO module 0-3 (Identity ↔ Properties/Assets ↔ Tenants ↔ Contracts) và việc dùng các module nền
 * (audit, notification, permission cache) trên PostgreSQL + Redis THẬT, ứng dụng chạy bằng app_user (RLS có hiệu lực).
 *
 *   npm run test:e2e -- cross-module
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
import { NotificationDispatcherService } from '../src/infrastructure/notification/services/notification-dispatcher.service';
import { PasswordHasherService } from '../src/modules/identity/services/password-hasher.service';
import { ContractNotificationsListener } from '../src/modules/contracts/listeners/contract-notifications.listener';
import { vietnamToday } from '../src/modules/properties/properties.helpers';
import { addDays, addYears } from '../src/modules/contracts/domain/contract.rules';

let counter = 0;
const uniquePhone = () => `+${Date.now()}${String(counter++ % 100).padStart(2, '0')}`;
const vnMobile = () => `093${String((Date.now() + counter++ * 7919) % 1e7).padStart(7, '0')}`;
const unique = () => randomUUID().slice(0, 8).toUpperCase();
const TODAY = vietnamToday();
const cccdFor = (dob: string, gender: 'MALE' | 'FEMALE') =>
  `079${(Number(dob.slice(0, 2)) === 19 ? 0 : 2) + (gender === 'FEMALE' ? 1 : 0)}${dob.slice(2, 4)}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

describe('Modules 0-3 working together (HTTP, real PostgreSQL as app_user + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let owner: DataSource;
  let redis: Redis;
  let tokens: JwtTokenService;

  const headers = async (userId: string, roles: string[], buildingId: string) => ({
    Authorization: `Bearer ${await tokens.signAccessToken({ sub: userId, buildingId, buildingIds: [buildingId], roles })}`,
    'X-Building-ID': buildingId,
  });
  const createUser = async (roles: string[], buildingId: string, phone = uniquePhone()) => {
    const [{ id }] = await owner.query(`INSERT INTO users (phone_e164, full_name, status, password_hash) VALUES ($1, 'e2e', 'ACTIVE', 'x') RETURNING id`, [phone]);
    for (const role of roles) await owner.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
    await owner.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, buildingId]);
    return { id, h: await headers(id, roles, buildingId) };
  };
  const post = (path: string, body: object, h: Record<string, string>) => http.post(`/api/v1${path}`).set(h).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, h: Record<string, string>) => http.get(`/api/v1${path}`).set(h);

  const createWorld = async () => {
    const buildingId = randomUUID();
    await owner.query(
      `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name) VALUES ($1, $2, 'Cross e2e', 'x', 'x', 'x', '0312345678', 'x')`,
      [buildingId, `X-${unique()}`],
    );
    const [landlord, pm] = await Promise.all([createUser(['LANDLORD'], buildingId), createUser(['PROPERTY_MANAGER'], buildingId)]);
    const roomType = (await post('/properties/room-types', { code: `T${unique()}`, name: 'Studio', baseMonthlyRent: 6_000_000, standardAreaSqm: 25, defaultMaxOccupants: 3 }, pm.h).expect(201)).body.data;
    const catalog = (await http.post('/api/v1/service-catalog').set(pm.h).send({ code: 'PARKING_MOTORBIKE', name: 'Xe máy', chargeUnit: 'PER_VEHICLE_MONTH', vehicleType: 'MOTORBIKE', defaultUnitPrice: 100_000 }).expect(201)).body.data;
    return { buildingId, landlord, pm, roomType, catalog };
  };
  type World = Awaited<ReturnType<typeof createWorld>>;
  const room = async (w: World) => (await post('/properties/rooms', { roomNumber: `R${unique().slice(0, 6)}`, floor: 3, areaSqm: 25, roomTypeId: w.roomType.id }, w.pm.h).expect(201)).body.data;
  const person = async (w: World, o: { dob?: string; gender?: 'MALE' | 'FEMALE'; phone?: string | null; nationality?: string; passport?: string } = {}) => {
    const dob = o.dob ?? '1994-04-04';
    const gender = o.gender ?? 'MALE';
    return (
      await post(
        '/tenants',
        {
          fullName: `Người ${unique()}`,
          idDocumentType: o.passport ? 'PASSPORT' : 'CCCD',
          idCardNumber: o.passport ?? cccdFor(dob, gender),
          nationality: o.nationality ?? 'VN',
          gender,
          dateOfBirth: dob,
          phone: o.phone === undefined ? vnMobile() : o.phone,
          hometownAddress: 'x',
          permanentAddress: 'x',
          pdplConsentAccepted: true,
        },
        w.pm.h,
      ).expect(201)
    ).body.data;
  };
  const lease = async (w: World, holderId: string, co: string[] = []) => {
    const c = (
      await post('/contracts', { roomId: (await room(w)).id, primaryTenantId: holderId, startDate: addDays(TODAY, -10), endDate: addDays(TODAY, 355), pcccCommitmentSigned: true, coOccupants: co.map((tenantId) => ({ tenantId })) }, w.pm.h).expect(201)
    ).body.data;
    return (await post(`/contracts/${c.id}/activate`, {}, w.pm.h).expect(201)).body.data;
  };
  const occupants = async (w: World, id: string) => (await get(`/contracts/${id}/occupants?status=ALL`, w.pm.h).expect(200)).body.data as any[];
  const audits = (buildingId: string, resource: string, resourceId?: string) =>
    owner.query(
      `SELECT resource_id, action, diff_snapshot FROM audit_logs WHERE building_id = $1 AND resource = $2 ${resourceId ? 'AND resource_id = $3' : ''} ORDER BY created_at, id`,
      resourceId ? [buildingId, resource, resourceId] : [buildingId, resource],
    ) as Promise<Array<{ resource_id: string; action: string; diff_snapshot: any }>>;

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
  describe('Audit trail (WORM) across a whole lease', () => {
    it('should attribute every audit row to a record, with diffs for derived and linked changes', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await lease(w, h.id, [a.id]);
      const ao = (await occupants(w, c.id)).find((o) => o.tenantId === a.id);
      const plate = `59-K1 ${String(Date.now()).slice(-5)}`;
      const v = (await post(`/contracts/${c.id}/vehicles`, { ownerTenantId: a.id, vehicleType: 'MOTORBIKE', licensePlate: plate, brandModel: 'Wave' }, w.pm.h).expect(201)).body.data;
      await http.patch(`/api/v1/contracts/${c.id}/occupants/${ao.occupantId}/residency`).set(w.pm.h).send({ residencyStatus: 'SUBMITTED' }).expect(200);
      await http.patch(`/api/v1/contracts/${c.id}/occupants/${ao.occupantId}/residency`).set(w.pm.h).send({ residencyStatus: 'REGISTERED', temporaryStayValidUntil: addYears(TODAY, 1) }).expect(200);
      await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200);

      const unknown = await owner.query(`SELECT resource, action FROM audit_logs WHERE building_id = $1 AND resource_id = 'unknown'`, [w.buildingId]);
      expect(unknown).toEqual([]);
      // Liên kết hồ sơ ↔ tài khoản lúc chuyển đến: trên đúng hồ sơ, có diff
      expect((await audits(w.buildingId, 'tenants', a.id)).find((r) => r.diff_snapshot?.userId)?.diff_snapshot.userId).toMatchObject({ from: null, to: expect.any(String) });
      // Xe ngừng hoạt động khi chủ xe chuyển đi
      expect((await audits(w.buildingId, 'tenant_vehicles', v.id)).filter((r) => r.action === 'UPDATE').map((r) => r.diff_snapshot?.isActive)).toEqual([{ from: true, to: false }]);
      // Định mức EVN: 0 → 1 (đăng ký) → 0 (chuyển đi), trên đúng hợp đồng
      expect((await audits(w.buildingId, 'contracts', c.id)).filter((r) => r.action === 'UPDATE').map((r) => r.diff_snapshot?.registeredEvnQuotaHeadcount).filter(Boolean)).toEqual([
        { from: 0, to: 1 },
        { from: 1, to: 0 },
      ]);
      // Gói gửi xe tính lại: tạo rồi gỡ khi không còn xe
      const parking = await audits(w.buildingId, 'contract_services');
      expect(parking.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
    });

    it('should not write rows for technical updates (sign-in time) of users', async () => {
      const before = Number((await owner.query(`SELECT count(*) FROM audit_logs WHERE resource = 'users' AND resource_id = 'unknown'`))[0].count);
      const phone = vnMobile();
      const w = await createWorld();
      const user = await createUser(['GUARD'], w.buildingId, `+84${phone.slice(1)}`);
      await owner.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await app.get(PasswordHasherService).hash('Guard-shift-2026-ok')]);
      await http.post('/api/v1/auth/login').send({ phone, password: 'Guard-shift-2026-ok' }).expect(200); // ghi users.last_login_at
      const after = Number((await owner.query(`SELECT count(*) FROM audit_logs WHERE resource = 'users' AND resource_id = 'unknown'`))[0].count);
      expect(after).toBe(before);
    });
  });

  // ===========================================================================
  describe('Notifications after commit (outbox → listeners)', () => {
    it('should invite a tenant account created at move-in, once activated never again', async () => {
      const w = await createWorld();
      const h = await person(w);
      const c = await lease(w, h.id);
      const dispatch = jest.spyOn(app.get(NotificationDispatcherService), 'dispatch').mockResolvedValue({} as any);
      const listener = app.get(ContractNotificationsListener);
      const event = { metadata: { tenantId: w.buildingId }, payload: { data: { tenantId: h.id } } } as any;
      try {
        await listener.onMovedIn(event);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toMatchObject({
          channels: ['SMS'],
          recipient: { phone: h.phone },
          payload: { templateName: 'ACCOUNT_INVITATION', context: { user: { roleLabel: 'khách thuê' } } },
        });
        // Đã kích hoạt → không mời lại; sự kiện tòa nhà khác → không gửi
        await owner.query(`UPDATE users SET status = 'ACTIVE', password_hash = 'x' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [h.id]);
        await listener.onMovedIn(event);
        await listener.onMovedIn({ ...event, metadata: { tenantId: randomUUID() } });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect((await owner.query(`SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'occupant.moved_in'`, [c.id])).length).toBe(1);
      } finally {
        dispatch.mockRestore();
      }
    });

    it('should tell the new holder, the remaining occupants and the outgoing holder about a holder change', async () => {
      const w = await createWorld();
      const [h, a, b] = await Promise.all([person(w), person(w), person(w)]);
      const c = await lease(w, h.id, [a.id, b.id]);
      const t = (await post(`/contracts/${c.id}/primary-holder/transfer`, { effectiveDate: TODAY, newPrimaryTenantId: b.id }, w.pm.h).expect(201)).body.data;
      const dispatch = jest.spyOn(app.get(NotificationDispatcherService), 'dispatch').mockResolvedValue({} as any);
      try {
        await app.get(ContractNotificationsListener).onHolderChanged({ metadata: { tenantId: w.buildingId }, payload: { data: { transferId: t.transferId } } } as any);
        expect(dispatch).toHaveBeenCalledTimes(3);
        const ctx = dispatch.mock.calls[0][0].payload.context as any;
        expect(dispatch.mock.calls[0][0].payload.templateName).toBe('PRIMARY_HOLDER_CHANGED');
        expect(ctx).toMatchObject({ contract: { code: c.contractCode }, transfer: { newHolderName: b.fullName, previousHolderName: h.fullName } });
        expect(new Set(dispatch.mock.calls.map((x) => x[0].recipient.phone)).size).toBe(3);
      } finally {
        dispatch.mockRestore();
      }
    });
  });

  // ===========================================================================
  describe('Profile corrections of people living under a contract', () => {
    it('should refuse turning the active holder into a minor, but allow it for a co-occupant with a guardian', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      await lease(w, h.id, [a.id]);
      const minorDob = addYears(TODAY, -15);
      const res = await http.patch(`/api/v1/tenants/${h.id}`).set(w.pm.h).send({ dateOfBirth: minorDob, idCardNumber: cccdFor(minorDob, 'MALE') }).expect(422);
      expect(res.body).toMatchObject({ errorCode: 'BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE', details: [{ field: 'dateOfBirth', issue: 'UNDERAGE' }] });
      await http.patch(`/api/v1/tenants/${a.id}`).set(w.pm.h).send({ dateOfBirth: minorDob, idCardNumber: cccdFor(minorDob, 'MALE'), phone: null, consentGuardianTenantId: h.id }).expect(200);
    });

    it('should move the current stay to the residence channel of a corrected nationality', async () => {
      const w = await createWorld();
      const h = await person(w);
      const vnPassport = await person(w, { passport: `B${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
      const c = await lease(w, h.id, [vnPassport.id]);
      const channel = async () => (await occupants(w, c.id)).find((o) => o.tenantId === vnPassport.id).residenceChannel;
      expect(await channel()).toBe('CT01'); // công dân Việt Nam có hộ chiếu vẫn khai CT01
      await http.patch(`/api/v1/tenants/${vnPassport.id}`).set(w.pm.h).send({ nationality: 'KR' }).expect(200);
      expect(await channel()).toBe('FOREIGNER_TEMPORARY_RESIDENCE');
    });

    it('should show on the profile where the person lives now, and nothing after moving out', async () => {
      const w = await createWorld();
      const [h, a] = await Promise.all([person(w), person(w)]);
      const c = await lease(w, h.id, [a.id]);
      const profile = (await get(`/tenants/${a.id}`, w.pm.h).expect(200)).body.data;
      expect(profile.currentOccupancy).toMatchObject({ contractId: c.id, contractCode: c.contractCode, roomId: c.room.id, roomNumber: c.room.roomNumber, role: 'CO_OCCUPANT', residencyStatus: 'PENDING_DECLARATION' });
      const ao = (await occupants(w, c.id)).find((o) => o.tenantId === a.id);
      await post(`/contracts/${c.id}/occupants/${ao.occupantId}/move-out`, { movedOutAt: TODAY }, w.pm.h).expect(200);
      expect((await get(`/tenants/${a.id}`, w.pm.h).expect(200)).body.data.currentOccupancy).toBeNull();
    });
  });

  // ===========================================================================
  describe('Identity ↔ contracts', () => {
    it('should give an existing staff account the tenant view at once when that person moves in', async () => {
      const w = await createWorld();
      const phone = vnMobile();
      const guard = await createUser(['GUARD'], w.buildingId, `+84${phone.slice(1)}`);
      await get('/contracts/mine', guard.h).expect(403); // quyền đã được cache: chưa phải khách thuê
      const p = await person(w, { phone });
      const c = await lease(w, p.id);
      expect((await owner.query(`SELECT user_id FROM tenants WHERE id = $1`, [p.id]))[0].user_id).toBe(guard.id); // một người một tài khoản
      expect((await get('/contracts/mine', guard.h).expect(200)).body.data.id).toBe(c.id);
      expect((await get('/auth/me', guard.h).expect(200)).body.data.roles.sort()).toEqual(['GUARD', 'TENANT']);
    });

    it("should let the landlord open one account of their buildings, staff or tenant, and nobody else's", async () => {
      const a = await createWorld();
      const b = await createWorld();
      const p = await person(a);
      await lease(a, p.id);
      const [{ user_id }] = await owner.query(`SELECT user_id FROM tenants WHERE id = $1`, [p.id]);
      expect((await get(`/users/${user_id}`, a.landlord.h).expect(200)).body.data).toMatchObject({ id: user_id, roles: ['TENANT'], status: 'PENDING_ACTIVATION', buildingIds: [a.buildingId] });
      expect((await get(`/users/${a.pm.id}`, a.landlord.h).expect(200)).body.data.roles).toEqual(['PROPERTY_MANAGER']);
      expect((await get(`/users/${user_id}`, b.landlord.h).expect(404)).body.errorCode).toBe('RES_NOT_FOUND');
      await get(`/users/${user_id}`, a.pm.h).expect(403);
      await get(`/users/not-a-uuid`, a.landlord.h).expect(400);
    });
  });

  // ===========================================================================
  describe('New management reads and corrections', () => {
    it('should list installed units by room, item, serial (LIKE wildcards literal) and condition, flagging rented ones', async () => {
      const w = await createWorld();
      const [r1, r2] = [await room(w), await room(w)];
      const asset = (await post('/assets', { code: `AC_${unique()}`, name: 'Máy lạnh', category: 'APPLIANCE', standardMonthlyRentalFee: 200_000 }, w.pm.h).expect(201)).body.data;
      const install = async (roomId: string, serialNumber: string, conditionGrade = 'GRADE_A_NEW') =>
        (await post('/assets/room-assignments', { roomId, assetId: asset.id, serialNumber, conditionGrade }, w.pm.h).expect(201)).body.data;
      const tag = unique();
      const u1 = await install(r1.id, `${tag}_01`);
      const u2 = await install(r2.id, `${tag}X01`, 'GRADE_C_FAIR');
      const h = await person(w);
      const d = (await post('/contracts', { roomId: r1.id, primaryTenantId: h.id, startDate: TODAY, endDate: addYears(TODAY, 1), rentedRoomAssetIds: [u1.id] }, w.pm.h).expect(201)).body.data;

      const list = async (q: string) => (await get(`/assets/room-assignments?${q}`, w.pm.h).expect(200)).body;
      const all = await list(`assetId=${asset.id}`);
      const byRoom = [[r1.roomNumber, u1.id, d.id], [r2.roomNumber, u2.id, null]].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(all.data.map((u: any) => [u.roomNumber, u.id, u.rentedUnderContractId])).toEqual(byRoom);
      expect(all.meta.pagination.totalItems).toBe(2);
      expect((await list(`serialNumber=${tag.toLowerCase()}_0`)).data.map((u: any) => u.id)).toEqual([u1.id]); // "_" không phải ký tự đại diện
      expect((await list(`roomId=${r2.id}`)).data.map((u: any) => u.id)).toEqual([u2.id]);
      expect((await list(`conditionGrade=GRADE_C_FAIR&assetId=${asset.id}`)).data.map((u: any) => u.id)).toEqual([u2.id]);
      const other = await createWorld();
      expect((await get(`/assets/room-assignments?assetId=${asset.id}`, other.pm.h).expect(200)).body.data).toEqual([]);
    });

    it('should correct a vehicle: plate normalised and unique, bicycles without plate, inactive vehicles frozen', async () => {
      const w = await createWorld();
      const [h, x] = await Promise.all([person(w), person(w)]);
      const c = await lease(w, h.id);
      const c2 = await lease(w, x.id);
      const n = String(Date.now()).slice(-5);
      const reg = async (contractId: string, owner: string, body: object) =>
        (await post(`/contracts/${contractId}/vehicles`, { ownerTenantId: owner, vehicleType: 'MOTORBIKE', brandModel: 'Vision', ...body }, w.pm.h).expect(201)).body.data;
      const v = await reg(c.id, h.id, { licensePlate: `59-A1 ${n}` });
      const taken = await reg(c2.id, x.id, { licensePlate: `59-B2 ${n}`, parkingCardCode: `C-${n}` });
      const patch = (id: string, body: object, contractId = c.id) => http.patch(`/api/v1/contracts/${contractId}/vehicles/${id}`).set(w.pm.h).send(body);

      expect((await patch(v.id, { licensePlate: ` 59-a1  ${n}9 `, brandModel: 'Vision 2026', parkingCardCode: 'c-new' }).expect(200)).body.data).toMatchObject({ licensePlate: `59-A1 ${n}9`, brandModel: 'Vision 2026', parkingCardCode: 'C-NEW' });
      expect((await patch(v.id, { licensePlate: taken.licensePlate }).expect(409)).body.details[0].field).toBe('licensePlate');
      expect((await patch(v.id, { parkingCardCode: `C-${n}` }).expect(409)).body.details[0].field).toBe('parkingCardCode');
      expect((await patch(v.id, { licensePlate: null }).expect(400)).body.details[0].field).toBe('licensePlate');
      await patch(v.id, {}).expect(400);
      expect((await patch(v.id, { parkingCardCode: null }).expect(200)).body.data.parkingCardCode).toBeNull();
      const bike = await reg(c.id, h.id, { vehicleType: 'BICYCLE' });
      await patch(bike.id, { licensePlate: null, brandModel: 'Giant' }).expect(200);
      await post(`/contracts/${c.id}/vehicles/${v.id}/deactivate`, {}, w.pm.h).expect(201);
      expect((await patch(v.id, { brandModel: 'x' }).expect(409)).body.details[0].issue).toBe('INACTIVE');
      await patch(taken.id, { brandModel: 'x' }, c.id).expect(404); // xe của hợp đồng khác
    });

    it('should search contracts by part of the code or the room number', async () => {
      const w = await createWorld();
      const c = await lease(w, (await person(w)).id);
      const other = await lease(w, (await person(w)).id);
      const search = async (q: string) => (await get(`/contracts?q=${encodeURIComponent(q)}`, w.pm.h).expect(200)).body.data.map((x: any) => x.id);
      expect(await search(c.contractCode.slice(0, 8).toLowerCase())).toEqual(expect.arrayContaining([c.id, other.id])); // hd-2026/
      expect(await search(c.contractCode)).toEqual([c.id]);
      expect(await search(c.room.roomNumber.toLowerCase())).toEqual([c.id]);
      expect(await search('%%')).toEqual([]); // ký tự đại diện được coi là chữ
      await get('/contracts?q=x', w.pm.h).expect(400);
    });
  });
});
