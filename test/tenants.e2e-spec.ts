/**
 * Module 2 - Tenants qua HTTP trên PostgreSQL + Redis THẬT, ứng dụng chạy bằng app_user (RLS có hiệu lực).
 * Dữ liệu mẫu và kiểm tra "at rest" bằng kết nối owner riêng.
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e -- tenants
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

let phoneCounter = 0;
const uniquePhone = () => `+${Date.now()}${String(phoneCounter++ % 100).padStart(2, '0')}`;
/** CCCD hợp lệ cho nam sinh 1999 (tỉnh 079) với 6 số cuối ngẫu nhiên */
const cccd = (century = '0', year = '99', province = '079') => `${province}${century}${year}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

describe('Tenants (HTTP, real PostgreSQL as app_user + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let owner: DataSource;
  let appDs: DataSource;
  let redis: Redis;
  let tokens: JwtTokenService;

  const createUser = async (roles: string[], buildingId: string) => {
    const [{ id }] = await owner.query(
      `INSERT INTO users (phone_e164, full_name, status, password_hash) VALUES ($1, 'e2e', 'ACTIVE', 'x') RETURNING id`,
      [uniquePhone()],
    );
    for (const role of roles) await owner.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
    await owner.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, buildingId]);
    const token = await tokens.signAccessToken({ sub: id, buildingId, buildingIds: [buildingId], roles });
    return { id, h: { Authorization: `Bearer ${token}`, 'X-Building-ID': buildingId } };
  };

  const createWorld = async () => {
    const buildingId = randomUUID();
    await owner.query(
      `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name)
       VALUES ($1, $2, 'Tenants e2e', 'x', 'x', 'x', '0312345678', 'x')`,
      [buildingId, `TEN-${buildingId.slice(0, 8)}`.toUpperCase()],
    );
    const [pm, accountant, guard, tenantUser] = await Promise.all([
      createUser(['PROPERTY_MANAGER'], buildingId),
      createUser(['ACCOUNTANT'], buildingId),
      createUser(['GUARD'], buildingId),
      createUser(['TENANT'], buildingId),
    ]);
    return { buildingId, pm, accountant, guard, tenantUser };
  };
  type World = Awaited<ReturnType<typeof createWorld>>;

  const person = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'Nguyễn Văn An',
    idDocumentType: 'CCCD',
    idCardNumber: cccd(),
    gender: 'MALE',
    dateOfBirth: '1999-08-15',
    phone: '0901 234 567',
    hometownAddress: 'Huế',
    permanentAddress: '123 Nguyễn Huệ, TP.HCM',
    pdplConsentAccepted: true,
    ...overrides,
  });
  const childOf = (guardianId: string, overrides: Record<string, unknown> = {}) =>
    person({ fullName: 'Nguyễn Ngọc Ánh', idCardNumber: cccd('3', '15'), gender: 'FEMALE', dateOfBirth: '2015-03-02', phone: null, consentGuardianTenantId: guardianId, ...overrides });

  const create = (w: World, body: object, h = w.pm.h) => http.post('/api/v1/tenants').set(h).set('Idempotency-Key', randomUUID()).send(body);
  const created = async (w: World, body: object) => (await create(w, body).expect(201)).body.data;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  // ===========================================================================
  describe('POST /tenants', () => {
    it('should register a person with the ID encrypted at rest, blind-indexed, masked in the response, and audited without the number', async () => {
      const w = await createWorld();
      const number = cccd();
      const res = await create(w, person({ idCardNumber: `${number.slice(0, 3)} ${number.slice(3, 6)}.${number.slice(6, 9)}-${number.slice(9)}` })).expect(201);
      const t = res.body.data;
      expect(t).toMatchObject({
        fullName: 'Nguyễn Văn An',
        idDocumentType: 'CCCD',
        idCardMasked: `********${number.slice(-4)}`,
        isMinor: false,
        phone: '+84901234567',
        nationality: 'VN',
        gender: 'MALE',
        refundBankAccountMasked: null,
        pdplConsentVersion: 'v2026.1',
        guardian: null,
        hasLogin: false,
        version: 1,
      });
      expect(JSON.stringify(res.body)).not.toContain(number);
      expect(JSON.stringify(res.body)).not.toMatch(/Encrypted|idCardHash/);

      const [row] = await owner.query(`SELECT id_card_encrypted, id_card_hash, id_card_last4, full_name_search FROM tenants WHERE id = $1`, [t.id]);
      expect(row.id_card_encrypted).toMatch(/^enc:v1:/);
      expect(row.id_card_encrypted).not.toContain(number);
      expect(row.id_card_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row).toMatchObject({ id_card_last4: number.slice(-4), full_name_search: 'nguyen van an' });

      const audit = JSON.stringify(await owner.query(`SELECT diff_snapshot, metadata FROM audit_logs WHERE resource = 'tenants' AND resource_id = $1`, [t.id]));
      expect(audit).toContain('CREATE'.length ? 'fullName' : '');
      expect(audit).not.toContain(number);
      expect(audit).not.toContain(row.id_card_hash);
    });

    it('should detect a duplicate however the number is typed, return the existing id, and allow the same person in another building', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const number = cccd();
      const first = await created(a, person({ idCardNumber: number }));
      const dup = await create(a, person({ idCardNumber: `${number.slice(0, 6)} ${number.slice(6)}` })).expect(409);
      expect(dup.body).toMatchObject({ errorCode: 'BIZ_TENANT_ID_CARD_DUPLICATE', details: [{ field: 'idCardNumber', issue: 'DUPLICATE', tenantId: first.id }] });
      await create(b, person({ idCardNumber: number })).expect(201);
    });

    it('should let exactly one of two simultaneous registrations of the same person win', async () => {
      const w = await createWorld();
      const body = person({ idCardNumber: cccd() });
      const results = await Promise.all([create(w, body), create(w, body)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.errorCode).toBe('BIZ_TENANT_ID_CARD_DUPLICATE');
    });

    it('should reject numbers that contradict the person (gender, birth year, century, length, nationality)', async () => {
      const w = await createWorld();
      const detail = async (body: object) => (await create(w, body).expect(400)).body.details.map((d: any) => d.field);
      expect(await detail(person({ gender: 'FEMALE' }))).toEqual(['idCardNumber']);
      expect(await detail(person({ dateOfBirth: '1998-08-15' }))).toEqual(['idCardNumber']);
      expect(await detail(person({ idCardNumber: cccd('2', '99') }))).toEqual(['idCardNumber']); // 2099?
      expect(await detail(person({ idCardNumber: '07909900123' }))).toEqual(['idCardNumber']);
      expect(await detail(person({ nationality: 'KR' }))).toEqual(['idDocumentType']);
      expect(await detail(person({ phone: null }))).toEqual(['phone']);
      expect(await detail(person({ refundBankAccount: '0071001234567' }))).toEqual(['refundBankName']);
      expect(await detail(person({ dateOfBirth: '2027-01-01', idCardNumber: cccd('2', '27') }))).toEqual(['dateOfBirth']);
      expect((await create(w, person({ phone: '028 3822 1234' })).expect(400)).body.details[0].field).toBe('phone');
      await create(w, person({ gender: 'OTHER' })).expect(400);
      await create(w, person({ role: 'LANDLORD' })).expect(400); // forbidNonWhitelisted
    });

    it('should register foreigners by passport with an international phone number', async () => {
      const w = await createWorld();
      const t = await created(w, person({ fullName: 'Kim Min-ji', idDocumentType: 'PASSPORT', idCardNumber: 'm 1234 5678', nationality: 'kr', gender: 'FEMALE', phone: '+82 10-1234-5678' }));
      expect(t).toMatchObject({ idDocumentType: 'PASSPORT', idCardMasked: '********5678', nationality: 'KR', phone: '+821012345678' });
    });

    it('should require consent from everyone, and a valid adult guardian of the same building for a child', async () => {
      const a = await createWorld();
      const b = await createWorld();
      expect((await create(a, person({ pdplConsentAccepted: false })).expect(422)).body.errorCode).toBe('BIZ_PDPL_CONSENT_REQUIRED');

      const parent = await created(a, person());
      const noGuardian = await create(a, childOf(parent.id, { consentGuardianTenantId: undefined })).expect(422);
      expect(noGuardian.body).toMatchObject({ errorCode: 'BIZ_PDPL_CONSENT_REQUIRED', details: [{ field: 'consentGuardianTenantId' }] });

      const child = await created(a, childOf(parent.id));
      expect(child).toMatchObject({ isMinor: true, phone: null, guardian: { id: parent.id, fullName: 'Nguyễn Văn An' } });

      // Trẻ em không làm người giám hộ; người của tòa khác / không tồn tại cũng không
      const otherParent = await created(b, person());
      for (const guardianId of [child.id, otherParent.id, randomUUID()]) {
        expect((await create(a, childOf(guardianId)).expect(422)).body.errorCode).toBe('BIZ_TENANT_GUARDIAN_INVALID');
      }
      expect((await create(a, person({ consentGuardianTenantId: parent.id })).expect(422)).body.errorCode).toBe('BIZ_TENANT_GUARDIAN_INVALID');
    });

    it('should be idempotent and restricted to building staff who manage people', async () => {
      const w = await createWorld();
      const body = person();
      const key = randomUUID();
      const first = await http.post('/api/v1/tenants').set(w.pm.h).set('Idempotency-Key', key).send(body).expect(201);
      const replay = await http.post('/api/v1/tenants').set(w.pm.h).set('Idempotency-Key', key).send(body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      await http.post('/api/v1/tenants').set(w.pm.h).send(person()).expect(400); // no Idempotency-Key
      await create(w, person(), w.accountant.h).expect(403);
      await create(w, person(), w.guard.h).expect(403);
      await create(w, person(), w.tenantUser.h).expect(403);
    });
  });

  // ===========================================================================
  describe('Search, lookup and detail', () => {
    it('should search by name without diacritics or by phone in any format, filter children, and page', async () => {
      const w = await createWorld();
      const an = await created(w, person({ fullName: 'Nguyễn Văn An', phone: '0912 000 111' }));
      await created(w, person({ fullName: 'Trần Thị Bình', idCardNumber: cccd('1', '99'), gender: 'FEMALE', phone: '0912000222' }));
      await created(w, childOf(an.id, { fullName: 'Nguyễn Ngọc Ánh' }));
      const search = async (query: object) => (await http.get('/api/v1/tenants').query(query).set(w.accountant.h).expect(200)).body;
      const names = (body: any) => body.data.map((t: any) => t.fullName);

      expect(names(await search({ q: 'nguyen' }))).toEqual(['Nguyễn Ngọc Ánh', 'Nguyễn Văn An']);
      expect(names(await search({ q: 'TRAN thi' }))).toEqual(['Trần Thị Bình']);
      expect(names(await search({ q: 'Bình' }))).toEqual(['Trần Thị Bình']);
      expect(names(await search({ q: '+84 912 000 111' }))).toEqual(['Nguyễn Văn An']);
      expect(names(await search({ q: '0912000222' }))).toEqual(['Trần Thị Bình']);
      expect(names(await search({ minor: true }))).toEqual(['Nguyễn Ngọc Ánh']);
      expect(names(await search({ minor: false }))).toEqual(['Nguyễn Văn An', 'Trần Thị Bình']);
      expect((await search({ q: '%%' })).data).toEqual([]); // ký tự đại diện được escape
      const page = await search({ limit: 2, page: 2 });
      expect(page.meta.pagination).toMatchObject({ totalItems: 3, page: 2 });
      await http.get('/api/v1/tenants').query({ q: 'x' }).set(w.pm.h).expect(400);
      await http.get('/api/v1/tenants').set(w.guard.h).expect(403);
    });

    it('should never show people of another building (RLS as app_user)', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const secret = await created(b, person({ fullName: 'Người Tòa B' }));
      expect((await http.get('/api/v1/tenants').query({ q: 'nguoi toa b' }).set(a.pm.h).expect(200)).body.data).toEqual([]);
      await http.get(`/api/v1/tenants/${secret.id}`).set(a.pm.h).expect(404);
      await http.patch(`/api/v1/tenants/${secret.id}`).set(a.pm.h).send({ fullName: 'x' }).expect(404);
      const [{ n }] = await appDs.query(`SELECT count(*)::int AS n FROM tenants`); // không có ngữ cảnh tòa nhà
      expect(n).toBe(0);
    });

    it('should look a person up by their number through the blind index and audit every lookup', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const number = cccd();
      const t = await created(a, person({ idCardNumber: number }));
      const found = await http.get('/api/v1/tenants/lookup').query({ idCardNumber: `${number.slice(0, 4)} ${number.slice(4)}` }).set(a.accountant.h).expect(200);
      expect(found.body.data).toMatchObject({ id: t.id, idCardMasked: `********${number.slice(-4)}` });
      await http.get('/api/v1/tenants/lookup').query({ idCardNumber: number }).set(b.pm.h).expect(404); // tòa khác
      await http.get('/api/v1/tenants/lookup').query({ idCardNumber: cccd() }).set(a.pm.h).expect(404);
      await http.get('/api/v1/tenants/lookup').query({ idCardNumber: '123' }).set(a.pm.h).expect(400);

      const lookups = await owner.query(
        `SELECT metadata FROM audit_logs WHERE resource = 'tenants' AND metadata->>'event' = 'TENANT_LOOKUP' AND building_id = $1`,
        [a.buildingId],
      );
      expect(lookups.map((r: any) => r.metadata.found).sort()).toEqual([false, true]);
      expect(JSON.stringify(lookups)).not.toContain(number);
    });
  });

  // ===========================================================================
  describe('PATCH /tenants/{id}', () => {
    it('should correct contact data and the refund account, keeping secrets masked', async () => {
      const w = await createWorld();
      const t = await created(w, person());
      const patch = (body: object) => http.patch(`/api/v1/tenants/${t.id}`).set(w.pm.h).send(body);
      const updated = (await patch({ phone: '0987 654 321', email: 'AN@Example.COM', refundBankAccount: '0071001234567', refundBankName: 'Vietcombank', version: 1 }).expect(200)).body.data;
      expect(updated).toMatchObject({ phone: '+84987654321', email: 'an@example.com', refundBankAccountMasked: '*********4567', refundBankName: 'Vietcombank', version: 2 });
      const [row] = await owner.query(`SELECT refund_bank_account_encrypted FROM tenants WHERE id = $1`, [t.id]);
      expect(row.refund_bank_account_encrypted).toMatch(/^enc:v1:/);

      expect((await patch({ refundBankAccount: null }).expect(200)).body.data).toMatchObject({ refundBankAccountMasked: null, refundBankName: null });
      expect((await patch({ fullName: 'x', version: 1 }).expect(409)).body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');
      await patch({}).expect(400);
      await patch({ version: 3 }).expect(400);
      await patch({ pdplConsentAccepted: false }).expect(400); // không đổi đồng ý ở đây
    });

    it('should re-validate the whole profile against the stored number (decrypted only inside the service)', async () => {
      const w = await createWorld();
      const t = await created(w, person());
      // Đổi giới tính mà không đổi số → mâu thuẫn với chữ số thứ 4 của CCCD đã lưu
      expect((await http.patch(`/api/v1/tenants/${t.id}`).set(w.pm.h).send({ gender: 'FEMALE' }).expect(400)).body.details[0].field).toBe('idCardNumber');
      // Sửa đồng thời số và giới tính → hợp lệ
      const fixed = cccd('1', '99');
      const res = await http.patch(`/api/v1/tenants/${t.id}`).set(w.pm.h).send({ gender: 'FEMALE', idCardNumber: fixed }).expect(200);
      expect(res.body.data.idCardMasked).toBe(`********${fixed.slice(-4)}`);
      await http.get('/api/v1/tenants/lookup').query({ idCardNumber: fixed }).set(w.pm.h).expect(200);
    });

    it('should refuse an ID correction that collides with another person', async () => {
      const w = await createWorld();
      const number = cccd();
      await created(w, person({ idCardNumber: number }));
      const other = await created(w, person({ fullName: 'Lê Văn C' }));
      const res = await http.patch(`/api/v1/tenants/${other.id}`).set(w.pm.h).send({ idCardNumber: number }).expect(409);
      expect(res.body.errorCode).toBe('BIZ_TENANT_ID_CARD_DUPLICATE');
    });

    it('should keep guardianship consistent', async () => {
      const w = await createWorld();
      const parent = await created(w, person());
      const child = await created(w, childOf(parent.id));
      const patch = (id: string, body: object) => http.patch(`/api/v1/tenants/${id}`).set(w.pm.h).send(body);

      expect((await patch(child.id, { consentGuardianTenantId: null }).expect(422)).body.errorCode).toBe('BIZ_PDPL_CONSENT_REQUIRED');
      expect((await patch(child.id, { consentGuardianTenantId: child.id }).expect(422)).body.errorCode).toBe('BIZ_TENANT_GUARDIAN_INVALID');
      // Người giám hộ không thể bị sửa thành trẻ em
      const asMinor = await patch(parent.id, { dateOfBirth: '2010-01-01', idCardNumber: cccd('2', '10'), phone: null });
      expect(asMinor.status).toBe(422);
      expect(asMinor.body.errorCode).toBe('BIZ_TENANT_GUARDIAN_INVALID');
      // Người thứ hai nhận giám hộ
      const other = await created(w, person({ fullName: 'Phạm Thị D', idCardNumber: cccd('1', '99'), gender: 'FEMALE' }));
      expect((await patch(child.id, { consentGuardianTenantId: other.id }).expect(200)).body.data.guardian.id).toBe(other.id);
    });
  });

  // ===========================================================================
  describe('GET /tenants/me', () => {
    it('should show a tenant their own linked profile, and nothing else', async () => {
      const w = await createWorld();
      const mine = await created(w, person());
      await http.get('/api/v1/tenants/me').set(w.tenantUser.h).expect(404); // chưa liên kết (module 3 làm lúc chuyển đến)
      await owner.query(`UPDATE tenants SET user_id = $2 WHERE id = $1`, [mine.id, w.tenantUser.id]);
      const me = (await http.get('/api/v1/tenants/me').set(w.tenantUser.h).expect(200)).body.data;
      expect(me).toMatchObject({ id: mine.id, hasLogin: true, idCardMasked: mine.idCardMasked });
      await http.get(`/api/v1/tenants/${mine.id}`).set(w.tenantUser.h).expect(403);
      await http.get('/api/v1/tenants').set(w.tenantUser.h).expect(403);
      await http.get('/api/v1/tenants/lookup').query({ idCardNumber: cccd() }).set(w.tenantUser.h).expect(403);
    });
  });

  // ===========================================================================
  describe('Database guarantees', () => {
    it('should enforce identity rules and same-building guardians even for raw SQL', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const guardianB = await created(b, person());
      const base = (over: Record<string, string | null>) => {
        const v = { nationality: 'VN', type: 'CCCD', phone: '+84901234567', guardian: null as string | null, hash: 'a'.repeat(64), ...over };
        return owner.query(
          `INSERT INTO tenants (building_id, full_name, full_name_search, id_document_type, id_card_encrypted, id_card_hash, id_card_last4,
                                nationality, gender, date_of_birth, phone, hometown_address, permanent_address, pdpl_consent_accepted_at, consent_guardian_tenant_id)
           VALUES ($1, 'x', 'x', $2, 'enc', $3, '1234', $4, 'MALE', '2000-01-01', $5, 'x', 'x', now(), $6)`,
          [a.buildingId, v.type, v.hash, v.nationality, v.phone, v.guardian],
        );
      };
      await expect(base({ nationality: 'KR' })).rejects.toThrow(/chk_tenants_cccd_vietnamese/);
      await expect(base({ phone: '0901234567' })).rejects.toThrow(/chk_tenants_phone_e164/);
      await expect(base({ hash: 'not-a-hash' })).rejects.toThrow(/chk_tenants_id_hash/);
      await expect(base({ guardian: guardianB.id })).rejects.toThrow(/fk_tenants_guardian_same_building/);
      await base({ hash: 'b'.repeat(64) }); // hợp lệ: số E.164 chuẩn được chấp nhận
    });
  });
});
