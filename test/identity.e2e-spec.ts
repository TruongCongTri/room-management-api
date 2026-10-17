/**
 * Module 0 - Identity trên hạ tầng THẬT (PostgreSQL + Redis của docker compose), qua HTTP như client thật:
 * đăng nhập bằng số điện thoại, khóa theo số, OTP 2 bước, refresh xoay vòng + phát hiện dùng lại, thu hồi tức thời,
 * kích hoạt / đặt lại / đổi mật khẩu, danh sách thiết bị, quản lý tài khoản nhân viên, cấp tài khoản khách thuê.
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e -- identity
 */
import './disable-outbox-poller';
import './identity-e2e-env';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import type Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/core/config/app-config.service';
import { REDIS_CLIENT } from '../src/core/redis/redis.constants';
import { runSeeds } from '../src/core/database/seed-runner';
import { ARGON2_OPTIONS } from '../src/modules/identity/services/password-hasher.service';
import { TenantAccountProvisioningService } from '../src/modules/identity/services/tenant-account-provisioning.service';
import { UserRolesPermissionLoader } from '../src/modules/identity/services/user-permission.loader';

const BUILDING_A = 'a1000000-0000-4000-8000-00000000000a';
const BUILDING_B = 'b1000000-0000-4000-8000-00000000000b';
const PASSWORD = 'Rental-E2E-pass';
const NEW_PASSWORD = 'An0ther-long-passphrase';

/** Giải mã payload JWT (không xác thực chữ ký - chỉ để kiểm tra claims) */
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('Identity module (HTTP, real PostgreSQL + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let dataSource: DataSource;
  let redis: Redis;
  let passwordHash: string;
  // Dải số riêng cho mỗi lần chạy: test DB được giữ lại giữa các lần chạy
  let phoneSeq = Math.floor(Math.random() * 900_000) * 10;

  interface TestUser {
    id: string;
    e164: string;
    /** Định dạng người dùng hay gõ: 09xx xxx xxx */
    phone: string;
  }

  const nextPhone = () => {
    phoneSeq += 1;
    const national = `91${String(phoneSeq).padStart(7, '0')}`;
    return { e164: `+84${national}`, phone: `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}` };
  };

  const createUser = async (
    roles: string[],
    options: { status?: string; buildings?: string[]; password?: string | null } = {},
  ): Promise<TestUser> => {
    const { e164, phone } = nextPhone();
    const status = options.status ?? 'ACTIVE';
    const hash = options.password === null ? null : options.password ? await argon2.hash(options.password, ARGON2_OPTIONS) : passwordHash;
    const [{ id }] = await dataSource.query(
      `INSERT INTO users (phone_e164, full_name, status, password_hash, phone_verified_at)
       VALUES ($1, $2, $3, $4::varchar, CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [e164, `E2E ${roles.join('+')}`, status, hash],
    );
    for (const role of roles) await dataSource.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
    for (const b of options.buildings ?? [BUILDING_A]) {
      await dataSource.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [id, b]);
    }
    return { id, e164, phone };
  };

  const login = (phone: string, password = PASSWORD, extra: Record<string, unknown> = {}) =>
    http.post('/api/v1/auth/login').send({ phone, password, ...extra });

  /** Đăng nhập trọn vẹn (tự vượt bước OTP cho vai trò tài chính) → data của TokenPairDto */
  const signIn = async (user: TestUser, extra: Record<string, unknown> = {}) => {
    const res = await login(user.phone, PASSWORD, extra);
    if (res.status === 202) {
      const mfa = await http
        .post('/api/v1/auth/login/mfa')
        .send({ challengeId: res.body.data.challengeId, code: res.body.data.debugCode, deviceId: extra.deviceId })
        .expect(200);
      return mfa.body.data;
    }
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    expect(await runSeeds()).toBe(0);
    passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);
  });

  beforeEach(async () => {
    await redis.flushdb(); // cooldown OTP, khóa đăng nhập, cache quyền không rò rỉ giữa các test
  });

  afterAll(async () => {
    await app?.close();
  });

  // ===========================================================================
  // POST /auth/login
  // ===========================================================================
  describe('POST /auth/login', () => {
    it('should sign in with the phone number and return a token pair whose claims never carry the raw phone', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const res = await login(pm.phone, PASSWORD, { deviceId: 'ios-1', deviceName: 'iPhone 15' }).expect(200);

      const data = res.body.data;
      expect(data).toMatchObject({
        tokenType: 'Bearer',
        accessTokenExpiresIn: 900,
        user: { id: pm.id, phoneMasked: expect.stringMatching(/^091\*{4}\d{3}$/), roles: ['PROPERTY_MANAGER'], buildingIds: [BUILDING_A] },
      });
      expect(data.refreshToken).toMatch(new RegExp(`^${data.sessionId}\\.[A-Za-z0-9_-]{43}$`));

      const claims = claimsOf(data.accessToken);
      expect(claims).toMatchObject({ sub: pm.id, sid: data.sessionId, buildingId: BUILDING_A, buildingIds: [BUILDING_A], typ: 'access' });
      expect(JSON.stringify(claims)).not.toContain(pm.e164.slice(3));
      expect(claims.exp - claims.iat).toBe(900);

      // Phiên được lưu với HMAC của secret - không bao giờ là token gốc
      const [session] = await dataSource.query(
        `SELECT refresh_token_hash, device_id, device_name, ip_address, mfa_verified_at FROM auth_sessions WHERE id = $1`,
        [data.sessionId],
      );
      expect(session).toMatchObject({ device_id: 'ios-1', device_name: 'iPhone 15', mfa_verified_at: null });
      expect(session.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(session.refresh_token_hash).not.toContain(data.refreshToken.split('.')[1]);

      const [user] = await dataSource.query(`SELECT last_login_at FROM users WHERE id = $1`, [pm.id]);
      expect(user.last_login_at).not.toBeNull();
    });

    it('should accept every way of typing the same number', async () => {
      const guard = await createUser(['GUARD']);
      const national = guard.e164.slice(3);
      for (const variant of [`0${national}`, guard.e164, `84${national}`, `+84 ${national.slice(0, 2)} ${national.slice(2)}`, `0084${national}`]) {
        const res = await login(variant).expect(200);
        expect(res.body.data.user.id).toBe(guard.id);
      }
    });

    it('should give the same 401 for a wrong password, an unknown number and an account that is not activated yet', async () => {
      const active = await createUser(['GUARD']);
      const pending = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      const bodies = [
        (await login(active.phone, 'Wrong-password-1').expect(401)).body,
        (await login(nextPhone().phone).expect(401)).body,
        (await login(pending.phone).expect(401)).body,
      ];
      for (const body of bodies) {
        expect(body).toMatchObject({ errorCode: 'AUTH_CREDENTIALS_INVALID', statusCode: 401 });
        expect(body.message).toBe(bodies[0].message);
        expect(body.detail).toBe(bodies[0].detail);
      }
    });

    it('should lock the number after 5 wrong passwords (423 + Retry-After), even for the right password', async () => {
      const guard = await createUser(['GUARD']);
      for (let i = 0; i < 4; i++) await login(guard.phone, 'Wrong-password-1').expect(401);
      const locked = await login(guard.phone, 'Wrong-password-1').expect(423);
      expect(locked.body.errorCode).toBe('AUTH_ACCOUNT_LOCKED');
      expect(Number(locked.headers['retry-after'])).toBe(900);

      const stillLocked = await login(guard.e164, PASSWORD).expect(423);
      expect(Number(stillLocked.headers['retry-after'])).toBeLessThanOrEqual(900);
      // Khóa theo số, không theo tài khoản: số khác không bị ảnh hưởng
      await signIn(await createUser(['GUARD']));
    });

    it('should lock unknown numbers too, so a lock does not reveal that a number is registered', async () => {
      const unknown = nextPhone().phone;
      for (let i = 0; i < 4; i++) await login(unknown).expect(401);
      await login(unknown).expect(423);
    });

    it('should say "disabled" only to someone who knows the password', async () => {
      const off = await createUser(['GUARD'], { status: 'DISABLED' });
      expect((await login(off.phone, 'Wrong-password-1').expect(401)).body.errorCode).toBe('AUTH_CREDENTIALS_INVALID');
      expect((await login(off.phone).expect(403)).body.errorCode).toBe('AUTH_ACCOUNT_DISABLED');
    });

    it('should validate the payload: not a mobile number, oversized password, unknown fields', async () => {
      const bad = await login('024 1234 5678').expect(400);
      expect(bad.body).toMatchObject({ errorCode: 'REQ_VALIDATION_ERROR', details: [{ field: 'phone' }] });
      await login('0912345678', 'x'.repeat(129)).expect(400);
      await http.post('/api/v1/auth/login').send({ phone: '0912345678', password: PASSWORD, role: 'LANDLORD' }).expect(400);
      await http.post('/api/v1/auth/login').send({ phone: '0912345678' }).expect(400);
    });

    it('should write login successes and failures to the WORM audit log with the phone masked', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      await login(pm.phone, 'Wrong-password-1').expect(401);
      await signIn(pm);
      const rows = await dataSource.query(
        `SELECT actor_id, metadata FROM audit_logs WHERE resource = 'auth' AND resource_id = $1 ORDER BY created_at`,
        [pm.id],
      );
      expect(rows.map((r: any) => r.metadata.event)).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCEEDED']);
      expect(rows[1].actor_id).toBe(pm.id);
      const text = JSON.stringify(rows);
      expect(text).toContain('091****');
      expect(text).not.toContain(pm.e164.slice(3));
      expect(text).not.toContain(PASSWORD);
    });
  });

  // ===========================================================================
  // POST /auth/login/mfa (LANDLORD, ACCOUNTANT)
  // ===========================================================================
  describe('Login second factor for finance roles', () => {
    it('should answer 202 with an OTP challenge and create no session until the code is confirmed', async () => {
      const landlord = await createUser(['LANDLORD']);
      const res = await login(landlord.phone, PASSWORD, { deviceId: 'ios-L' }).expect(202);
      expect(res.body.data).toMatchObject({ mfaRequired: true, otpSentTo: expect.stringMatching(/^091\*{4}/), expiresInSeconds: 300 });
      expect(res.body.data.accessToken).toBeUndefined();
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1`, [landlord.id]))[0].n).toBe(0);

      const done = await http
        .post('/api/v1/auth/login/mfa')
        .send({ challengeId: res.body.data.challengeId, code: res.body.data.debugCode, deviceId: 'ios-L' })
        .expect(200);
      const [session] = await dataSource.query(`SELECT mfa_verified_at FROM auth_sessions WHERE id = $1`, [done.body.data.sessionId]);
      expect(session.mfa_verified_at).not.toBeNull();
    });

    it('should count wrong codes, burn the challenge on the 5th, and never accept a code twice', async () => {
      const accountant = await createUser(['ACCOUNTANT']);
      const { challengeId, debugCode } = (await login(accountant.phone).expect(202)).body.data;
      const wrong = debugCode === '000000' ? '111111' : '000000';

      const first = await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: wrong }).expect(400);
      expect(first.body).toMatchObject({ errorCode: 'AUTH_OTP_INVALID', details: [{ attemptsRemaining: 4 }] });
      for (let i = 0; i < 3; i++) await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: wrong }).expect(400);
      expect((await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: wrong }).expect(429)).body.errorCode).toBe(
        'AUTH_OTP_TOO_MANY_ATTEMPTS',
      );
      expect((await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: debugCode }).expect(400)).body.errorCode).toBe(
        'AUTH_OTP_EXPIRED',
      );

      await redis.flushdb(); // bỏ cooldown để đăng nhập lại
      const again = (await login(accountant.phone).expect(202)).body.data;
      await http.post('/api/v1/auth/login/mfa').send({ challengeId: again.challengeId, code: again.debugCode }).expect(200);
      await http.post('/api/v1/auth/login/mfa').send({ challengeId: again.challengeId, code: again.debugCode }).expect(400);
    });

    it('should bind the challenge to the device that passed the password step', async () => {
      const landlord = await createUser(['LANDLORD']);
      const { challengeId, debugCode } = (await login(landlord.phone, PASSWORD, { deviceId: 'ios-L' }).expect(202)).body.data;
      await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: debugCode, deviceId: 'attacker-device' }).expect(400);
      await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: debugCode }).expect(400);
      await http.post('/api/v1/auth/login/mfa').send({ challengeId, code: debugCode, deviceId: 'ios-L' }).expect(200);
    });

    it('should not send a second code within the cooldown (429 + Retry-After)', async () => {
      const landlord = await createUser(['LANDLORD']);
      await login(landlord.phone).expect(202);
      const res = await login(landlord.phone).expect(429);
      expect(res.body.errorCode).toBe('AUTH_OTP_RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(50);
    });

    it('should validate the challenge payload', async () => {
      await http.post('/api/v1/auth/login/mfa').send({ challengeId: 'nope', code: '123456' }).expect(400);
      await http.post('/api/v1/auth/login/mfa').send({ challengeId: randomUUID(), code: '12345' }).expect(400);
      const unknown = await http.post('/api/v1/auth/login/mfa').send({ challengeId: randomUUID(), code: '123456' }).expect(400);
      expect(unknown.body.errorCode).toBe('AUTH_OTP_EXPIRED');
    });
  });

  // ===========================================================================
  // POST /auth/refresh + revocation
  // ===========================================================================
  describe('Refresh token rotation and revocation', () => {
    it('should rotate: the new pair works, the old refresh token is spent', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const first = await signIn(pm);
      const second = (await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body.data;

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await http.get('/api/v1/auth/me').set(bearer(second.accessToken)).expect(200);
      const [row] = await dataSource.query(`SELECT rotation_count FROM auth_sessions WHERE id = $1`, [first.sessionId]);
      expect(row.rotation_count).toBe(1);
    });

    it('should treat a replayed refresh token as stolen: revoke the whole session and its live access token at once', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const first = await signIn(pm);
      const second = (await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body.data;

      const replay = await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
      expect(replay.body.errorCode).toBe('AUTH_REFRESH_TOKEN_REUSED');
      // Token hợp lệ của kẻ tấn công lẫn của chủ tài khoản đều mất hiệu lực
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401)).body.errorCode).toBe(
        'AUTH_SESSION_REVOKED',
      );
      expect((await http.get('/api/v1/auth/me').set(bearer(second.accessToken)).expect(401)).body.errorCode).toBe('AUTH_SESSION_REVOKED');

      const [row] = await dataSource.query(`SELECT revoked_reason FROM auth_sessions WHERE id = $1`, [first.sessionId]);
      expect(row.revoked_reason).toBe('ROTATION_REUSE_DETECTED');
    });

    it('should let exactly one of two simultaneous refreshes with the same token win (row lock), and revoke the session', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const { refreshToken } = await signIn(pm);
      const results = await Promise.all([
        http.post('/api/v1/auth/refresh').send({ refreshToken }),
        http.post('/api/v1/auth/refresh').send({ refreshToken }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(results.find((r) => r.status === 401)!.body.errorCode).toBe('AUTH_REFRESH_TOKEN_REUSED');
    });

    it('should reject garbage, tampered and foreign-session refresh tokens with AUTH_TOKEN_INVALID', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const { refreshToken, sessionId } = await signIn(pm);
      const secret = refreshToken.split('.')[1];
      const tampered = `${sessionId}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
      for (const token of ['not-a-token', `${sessionId}.short`, tampered, `${randomUUID()}.${secret}`]) {
        expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: token }).expect(401)).body.errorCode).toBe('AUTH_TOKEN_INVALID');
      }
      // Token hỏng không làm hỏng phiên thật
      await http.post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);
    });

    it('should refuse to refresh an expired session (idle or absolute expiry)', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const idle = await signIn(pm);
      await dataSource.query(`UPDATE auth_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`, [idle.sessionId]);
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: idle.refreshToken }).expect(401)).body.errorCode).toBe(
        'AUTH_SESSION_REVOKED',
      );

      const old = await signIn(pm);
      await dataSource.query(
        `UPDATE auth_sessions SET created_at = now() - interval '31 days', absolute_expires_at = now() - interval '1 second',
                                  idle_expires_at = now() - interval '1 second' WHERE id = $1`,
        [old.sessionId],
      );
      await http.post('/api/v1/auth/refresh').send({ refreshToken: old.refreshToken }).expect(401);
    });

    it('should never extend a session beyond its absolute expiry', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const pair = await signIn(pm);
      await dataSource.query(
        `UPDATE auth_sessions SET created_at = now() - interval '29 days 23 hours', absolute_expires_at = now() + interval '1 hour',
                                  idle_expires_at = now() + interval '30 minutes' WHERE id = $1`,
        [pair.sessionId],
      );
      const next = (await http.post('/api/v1/auth/refresh').send({ refreshToken: pair.refreshToken }).expect(200)).body.data;
      const [row] = await dataSource.query(`SELECT idle_expires_at, absolute_expires_at FROM auth_sessions WHERE id = $1`, [pair.sessionId]);
      expect(new Date(row.idle_expires_at).getTime()).toBe(new Date(row.absolute_expires_at).getTime());
      expect(new Date(next.refreshTokenExpiresAt).getTime()).toBe(new Date(row.absolute_expires_at).getTime());
    });

    it('should put current roles and buildings into refreshed tokens', async () => {
      const guard = await createUser(['GUARD']);
      const pair = await signIn(guard);
      await dataSource.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'PROPERTY_MANAGER')`, [guard.id]);
      await dataSource.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2)`, [guard.id, BUILDING_B]);
      const next = (await http.post('/api/v1/auth/refresh').send({ refreshToken: pair.refreshToken }).expect(200)).body.data;
      expect(claimsOf(next.accessToken)).toMatchObject({ roles: ['GUARD', 'PROPERTY_MANAGER'], buildingIds: [BUILDING_A, BUILDING_B] });
    });

    it('should log out: revoke the session in the database and its access token in Redis for the token lifetime', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const pair = await signIn(pm);
      await http.post('/api/v1/auth/logout').set(bearer(pair.accessToken)).expect(204);

      expect((await http.get('/api/v1/auth/me').set(bearer(pair.accessToken)).expect(401)).body.errorCode).toBe('AUTH_SESSION_REVOKED');
      await http.post('/api/v1/auth/refresh').send({ refreshToken: pair.refreshToken }).expect(401);
      const ttl = await redis.ttl(`auth:revoked-sid:${pair.sessionId}`);
      expect(ttl).toBeGreaterThan(890);
      expect(ttl).toBeLessThanOrEqual(900);
      await http.post('/api/v1/auth/logout').expect(401); // không có token
    });

    it('should log out everywhere without touching other users', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const other = await createUser(['PROPERTY_MANAGER']);
      const phone = await signIn(pm, { deviceName: 'phone' });
      const laptop = await signIn(pm, { deviceName: 'laptop' });
      const otherPair = await signIn(other);

      await http.post('/api/v1/auth/logout-all').set(bearer(phone.accessToken)).expect(204);
      await http.get('/api/v1/auth/me').set(bearer(laptop.accessToken)).expect(401);
      await http.get('/api/v1/auth/me').set(bearer(phone.accessToken)).expect(401);
      await http.get('/api/v1/auth/me').set(bearer(otherPair.accessToken)).expect(200);
    });
  });

  // ===========================================================================
  // /auth/sessions, /auth/me
  // ===========================================================================
  describe('Sessions and profile', () => {
    it('should list my devices (current one flagged, no secrets) and let me sign out another one', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const phone = await signIn(pm, { deviceName: 'phone' });
      const laptop = await signIn(pm, { deviceName: 'laptop' });

      const list = (await http.get('/api/v1/auth/sessions').set(bearer(phone.accessToken)).expect(200)).body.data;
      expect(list).toHaveLength(2);
      expect(list.find((s: any) => s.current).id).toBe(phone.sessionId);
      expect(list.map((s: any) => s.deviceName).sort()).toEqual(['laptop', 'phone']);
      expect(JSON.stringify(list)).not.toMatch(/hash|refresh/i);

      await http.delete(`/api/v1/auth/sessions/${laptop.sessionId}`).set(bearer(phone.accessToken)).expect(204);
      await http.get('/api/v1/auth/me').set(bearer(laptop.accessToken)).expect(401);
      expect((await http.get('/api/v1/auth/sessions').set(bearer(phone.accessToken)).expect(200)).body.data).toHaveLength(1);
    });

    it("should not reveal or revoke someone else's session", async () => {
      const me = await signIn(await createUser(['GUARD']));
      const victim = await signIn(await createUser(['GUARD']));
      await http.delete(`/api/v1/auth/sessions/${victim.sessionId}`).set(bearer(me.accessToken)).expect(404);
      await http.get('/api/v1/auth/me').set(bearer(victim.accessToken)).expect(200);
      await http.delete('/api/v1/auth/sessions/not-a-uuid').set(bearer(me.accessToken)).expect(400);
    });

    it('should describe the caller with the phone masked, roles, buildings and permissions; residence is empty until module 3', async () => {
      const tenant = await createUser(['TENANT']);
      const { accessToken } = await signIn(tenant);
      const me = (await http.get('/api/v1/auth/me').set(bearer(accessToken)).expect(200)).body.data;
      expect(me).toMatchObject({
        id: tenant.id,
        phoneMasked: expect.stringMatching(/^091\*{4}\d{3}$/),
        status: 'ACTIVE',
        roles: ['TENANT'],
        activeBuildingId: BUILDING_A,
        buildings: [{ id: BUILDING_A, name: null }],
        residence: null,
      });
      expect(me.permissions).toEqual(expect.arrayContaining(['rooms:read:own', 'invoices:read:own', 'assets:read:own']));
      expect(me.permissions).not.toContain('rooms:read:department');
      expect(JSON.stringify(me)).not.toContain(tenant.e164.slice(3));
    });
  });

  // ===========================================================================
  // OTP: activation, password reset
  // ===========================================================================
  describe('Account activation and password reset by OTP', () => {
    const requestOtp = (phone: string, purpose: string) => http.post('/api/v1/auth/otp/request').send({ phone, purpose });

    it('should answer 202 the same way for unknown, wrong-state and eligible numbers (a code only for the eligible one)', async () => {
      const pending = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      const active = await createUser(['GUARD']);
      const shape = (body: any) => ({ ...body.data, debugCode: undefined });

      const unknown = await requestOtp(nextPhone().phone, 'ACTIVATE_ACCOUNT').expect(202);
      const alreadyActive = await requestOtp(active.phone, 'ACTIVATE_ACCOUNT').expect(202);
      const eligible = await requestOtp(pending.phone, 'ACTIVATE_ACCOUNT').expect(202);

      expect(shape(unknown.body)).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
      expect(shape(alreadyActive.body)).toEqual(shape(unknown.body));
      expect(shape(eligible.body)).toEqual(shape(unknown.body));
      expect(unknown.body.data.debugCode).toBeUndefined();
      expect(alreadyActive.body.data.debugCode).toBeUndefined();
      expect(eligible.body.data.debugCode).toMatch(/^[0-9]{6}$/);
    });

    it('should apply the cooldown to unknown numbers as well', async () => {
      const unknown = nextPhone().phone;
      await requestOtp(unknown, 'RESET_PASSWORD').expect(202);
      const limited = await requestOtp(unknown, 'RESET_PASSWORD').expect(429);
      expect(limited.body.errorCode).toBe('AUTH_OTP_RATE_LIMITED');
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('should activate an account: weak password refused first (code kept), then signed in with the new password', async () => {
      const pending = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      const code = (await requestOtp(pending.phone, 'ACTIVATE_ACCOUNT').expect(202)).body.data.debugCode;

      const weak = await http.post('/api/v1/auth/activate').send({ phone: pending.phone, code, newPassword: 'password123' }).expect(422);
      expect(weak.body).toMatchObject({ errorCode: 'AUTH_PASSWORD_POLICY_VIOLATION', details: [{ field: 'newPassword', issue: 'COMMON_PASSWORD' }] });

      const activated = await http
        .post('/api/v1/auth/activate')
        .send({ phone: pending.e164, code, newPassword: NEW_PASSWORD, deviceName: 'Zalo Mini App' })
        .expect(200);
      expect(activated.body.data.user.id).toBe(pending.id);
      const [row] = await dataSource.query(`SELECT status, phone_verified_at, password_hash FROM users WHERE id = $1`, [pending.id]);
      expect(row.status).toBe('ACTIVE');
      expect(row.phone_verified_at).not.toBeNull();
      // argon2id với tham số OWASP (m = 19 MiB, t = 2, p = 1)
      expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$/);
      expect(row.password_hash.split('$')[3].split(',').sort()).toEqual(['m=19456', 'p=1', 't=2']);

      await login(pending.phone, NEW_PASSWORD).expect(200);
      // Mã đã dùng
      await http.post('/api/v1/auth/activate').send({ phone: pending.phone, code, newPassword: NEW_PASSWORD }).expect(400);
    });

    it('should not activate with a wrong code or a code for another number', async () => {
      const a = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      const b = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      const codeA = (await requestOtp(a.phone, 'ACTIVATE_ACCOUNT').expect(202)).body.data.debugCode;
      const wrong = codeA === '000000' ? '111111' : '000000';
      expect((await http.post('/api/v1/auth/activate').send({ phone: a.phone, code: wrong, newPassword: NEW_PASSWORD }).expect(400)).body.errorCode).toBe(
        'AUTH_OTP_INVALID',
      );
      expect((await http.post('/api/v1/auth/activate').send({ phone: b.phone, code: codeA, newPassword: NEW_PASSWORD }).expect(400)).body.errorCode).toBe(
        'AUTH_OTP_EXPIRED',
      );
    });

    it('should reset a forgotten password: every session signed out, lock lifted, old password dead', async () => {
      const guard = await createUser(['GUARD']);
      const before = await signIn(guard);
      for (let i = 0; i < 5; i++) await login(guard.phone, 'Wrong-password-1');
      await login(guard.phone).expect(423);

      const code = (await requestOtp(guard.phone, 'RESET_PASSWORD').expect(202)).body.data.debugCode;
      await http.post('/api/v1/auth/password/reset').send({ phone: guard.phone, code, newPassword: NEW_PASSWORD }).expect(204);

      await http.get('/api/v1/auth/me').set(bearer(before.accessToken)).expect(401);
      await login(guard.phone, PASSWORD).expect(401);
      await login(guard.phone, NEW_PASSWORD).expect(200);
    });

    it('should not send a reset code to an account that was never activated', async () => {
      const pending = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });
      expect((await requestOtp(pending.phone, 'RESET_PASSWORD').expect(202)).body.data.debugCode).toBeUndefined();
    });

    it('should refuse LOGIN_MFA as a self-service purpose', async () => {
      await requestOtp('0912345678', 'LOGIN_MFA').expect(400);
    });
  });

  describe('POST /auth/password/change', () => {
    it('should change the password, keep this session and sign out the others', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const here = await signIn(pm, { deviceName: 'here' });
      const there = await signIn(pm, { deviceName: 'there' });

      await http.post('/api/v1/auth/password/change').set(bearer(here.accessToken)).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
      await http.get('/api/v1/auth/me').set(bearer(here.accessToken)).expect(200);
      await http.get('/api/v1/auth/me').set(bearer(there.accessToken)).expect(401);
      await login(pm.phone, PASSWORD).expect(401);
      await login(pm.phone, NEW_PASSWORD).expect(200);
    });

    it('should refuse a wrong current password (counting towards the lock), the same password and a weak one', async () => {
      const pm = await createUser(['PROPERTY_MANAGER']);
      const { accessToken } = await signIn(pm);
      const change = (body: object) => http.post('/api/v1/auth/password/change').set(bearer(accessToken)).send(body);

      expect((await change({ currentPassword: 'Wrong-password-1', newPassword: NEW_PASSWORD }).expect(401)).body.errorCode).toBe('AUTH_CREDENTIALS_INVALID');
      expect((await change({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(422)).body.details).toEqual([
        { field: 'newPassword', issue: 'SAME_AS_CURRENT' },
      ]);
      const phoneDigits = pm.e164.slice(-6);
      expect((await change({ currentPassword: PASSWORD, newPassword: `Home-${phoneDigits}-x` }).expect(422)).body.details).toEqual([
        { field: 'newPassword', issue: 'CONTAINS_PHONE_NUMBER' },
      ]);
      // Mỗi lần nhập ĐÚNG mật khẩu hiện tại xóa bộ đếm sai → cần 5 lần sai liên tiếp
      for (let i = 0; i < 4; i++) await change({ currentPassword: 'Wrong-password-1', newPassword: NEW_PASSWORD }).expect(401);
      await change({ currentPassword: 'Wrong-password-1', newPassword: NEW_PASSWORD }).expect(423);
      await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(423);
    });
  });

  // ===========================================================================
  // /users (landlord manages staff accounts)
  // ===========================================================================
  describe('Staff accounts (/users)', () => {
    let landlordA: TestUser;
    let landlordToken: string;

    beforeEach(async () => {
      landlordA = await createUser(['LANDLORD'], { buildings: [BUILDING_A] });
      landlordToken = (await signIn(landlordA)).accessToken;
    });

    const createStaff = (body: Record<string, unknown>, key: string = randomUUID(), token = landlordToken) =>
      http.post('/api/v1/users').set(bearer(token)).set('Idempotency-Key', key).send(body);

    it('should create a staff account waiting for activation, then the person activates it by OTP', async () => {
      const { phone, e164 } = nextPhone();
      const created = await createStaff({ phone, fullName: '  Trần Thị B  ', roles: ['ACCOUNTANT'], buildingIds: [BUILDING_A] }).expect(201);
      expect(created.body.data).toMatchObject({
        fullName: 'Trần Thị B',
        status: 'PENDING_ACTIVATION',
        roles: ['ACCOUNTANT'],
        buildingIds: [BUILDING_A],
        phoneMasked: expect.stringMatching(/^091\*{4}\d{3}$/),
      });
      const code = (await http.post('/api/v1/auth/otp/request').send({ phone: e164, purpose: 'ACTIVATE_ACCOUNT' }).expect(202)).body.data.debugCode;
      expect(code).toMatch(/^\d{6}$/);
      // Kế toán là vai trò tài chính: kích hoạt xong vẫn đăng nhập được, lần sau sẽ cần OTP
      await http.post('/api/v1/auth/activate').send({ phone, code, newPassword: NEW_PASSWORD }).expect(200);
    });

    it('should require an Idempotency-Key and replay the first result for the same key', async () => {
      const body = { ...nextPhone(), fullName: 'Bảo vệ ca đêm', roles: ['GUARD'], buildingIds: [BUILDING_A] };
      delete (body as any).e164;
      await http.post('/api/v1/users').set(bearer(landlordToken)).send(body).expect(400);
      const key = randomUUID();
      const first = await createStaff(body, key).expect(201);
      const replay = await createStaff(body, key).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
    });

    it('should keep one account per phone number, however it is typed', async () => {
      const existing = await createUser(['GUARD']);
      const res = await createStaff({ phone: existing.e164.replace('+84', '0'), fullName: 'Dup', roles: ['GUARD'], buildingIds: [BUILDING_A] }).expect(409);
      expect(res.body.errorCode).toBe('RES_ALREADY_EXISTS');
    });

    it("should refuse to grant access to a building that is not the landlord's", async () => {
      const res = await createStaff({ phone: nextPhone().phone, fullName: 'X', roles: ['GUARD'], buildingIds: [BUILDING_A, BUILDING_B] }).expect(403);
      expect(res.body.details).toEqual([{ field: 'buildingIds', issue: 'NOT_YOUR_BUILDING', buildingId: BUILDING_B }]);
    });

    it('should never create TENANT accounts by hand, and validate the payload', async () => {
      await createStaff({ phone: nextPhone().phone, fullName: 'T', roles: ['TENANT'], buildingIds: [BUILDING_A] }).expect(400);
      await createStaff({ phone: nextPhone().phone, fullName: 'T', roles: [], buildingIds: [BUILDING_A] }).expect(400);
      await createStaff({ phone: nextPhone().phone, fullName: '   ', roles: ['GUARD'], buildingIds: [BUILDING_A] }).expect(400);
      await createStaff({ phone: '028 3822 1234', fullName: 'Landline', roles: ['GUARD'], buildingIds: [BUILDING_A] }).expect(400);
    });

    it('should be reserved to landlords', async () => {
      const pm = await signIn(await createUser(['PROPERTY_MANAGER']));
      await createStaff({ phone: nextPhone().phone, fullName: 'X', roles: ['GUARD'], buildingIds: [BUILDING_A] }, randomUUID(), pm.accessToken).expect(403);
      await http.get('/api/v1/users').set(bearer(pm.accessToken)).expect(403);
      await http.get('/api/v1/users').expect(401);
    });

    it("should list only people of the landlord's buildings, with filters and pagination", async () => {
      const guard = await createUser(['GUARD'], { buildings: [BUILDING_A] });
      await createUser(['GUARD'], { buildings: [BUILDING_B] }); // người của chủ nhà khác
      const shared = await createUser(['PROPERTY_MANAGER'], { buildings: [BUILDING_A, BUILDING_B] });

      const res = await http.get('/api/v1/users').query({ role: 'GUARD', limit: 100 }).set(bearer(landlordToken)).expect(200);
      const ids = res.body.data.map((u: any) => u.id);
      expect(ids).toContain(guard.id);
      expect(res.body.data.every((u: any) => u.roles.includes('GUARD'))).toBe(true);
      expect(res.body.data.every((u: any) => u.buildingIds.every((b: string) => b === BUILDING_A))).toBe(true);

      const all = await http.get('/api/v1/users').query({ limit: 1, page: 1 }).set(bearer(landlordToken)).expect(200);
      expect(all.body.data).toHaveLength(1);
      expect(all.body.meta.pagination).toMatchObject({ page: 1, limit: 1, hasNextPage: true });

      // Người dùng chung tòa nhà: chủ nhà A chỉ thấy tòa A trong danh sách tòa nhà của họ
      const sharedRow = (await http.get('/api/v1/users').query({ role: 'PROPERTY_MANAGER', limit: 100 }).set(bearer(landlordToken))).body.data.find(
        (u: any) => u.id === shared.id,
      );
      expect(sharedRow.buildingIds).toEqual([BUILDING_A]);

      await http.get('/api/v1/users').query({ buildingId: BUILDING_B }).set(bearer(landlordToken)).expect(403);
      await http.get('/api/v1/users').query({ limit: 101 }).set(bearer(landlordToken)).expect(400);
    });

    it('should apply a role change immediately (permission cache evicted) without a new login', async () => {
      const guard = await createUser(['GUARD']);
      const guardToken = (await signIn(guard)).accessToken;
      expect((await http.get('/api/v1/auth/me').set(bearer(guardToken))).body.data.permissions).not.toContain('contracts:manage:department');

      const res = await http.patch(`/api/v1/users/${guard.id}`).set(bearer(landlordToken)).send({ roles: ['GUARD', 'PROPERTY_MANAGER'] }).expect(200);
      expect(res.body.data.roles).toEqual(['GUARD', 'PROPERTY_MANAGER']);
      expect((await http.get('/api/v1/auth/me').set(bearer(guardToken)).expect(200)).body.data.permissions).toContain('contracts:manage:department');
    });

    it('should revoke the sessions of someone whose access is reduced or who is disabled', async () => {
      const pm = await createUser(['PROPERTY_MANAGER', 'GUARD']);
      const pmToken = (await signIn(pm)).accessToken;
      await http.patch(`/api/v1/users/${pm.id}`).set(bearer(landlordToken)).send({ roles: ['GUARD'] }).expect(200);
      expect((await http.get('/api/v1/auth/me').set(bearer(pmToken)).expect(401)).body.errorCode).toBe('AUTH_SESSION_REVOKED');

      const guardToken = (await signIn(pm)).accessToken;
      await http.patch(`/api/v1/users/${pm.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(200);
      await http.get('/api/v1/auth/me').set(bearer(guardToken)).expect(401);
      expect((await login(pm.phone).expect(403)).body.errorCode).toBe('AUTH_ACCOUNT_DISABLED');

      const reopened = await http.patch(`/api/v1/users/${pm.id}`).set(bearer(landlordToken)).send({ status: 'ACTIVE' }).expect(200);
      expect(reopened.body.data.status).toBe('ACTIVE');
      await login(pm.phone).expect(200);
    });

    it('should keep access to buildings outside the landlord scope untouched', async () => {
      const shared = await createUser(['PROPERTY_MANAGER'], { buildings: [BUILDING_A, BUILDING_B] });
      await createUser(['LANDLORD'], { buildings: [BUILDING_A] }); // landlordA vẫn là chủ nhà A cùng người khác
      const res = await http.patch(`/api/v1/users/${shared.id}`).set(bearer(landlordToken)).send({ buildingIds: [BUILDING_A] }).expect(200);
      expect(res.body.data.buildingIds).toEqual([BUILDING_A]);
      const rows = await dataSource.query(`SELECT building_id FROM user_building_access WHERE user_id = $1 ORDER BY building_id`, [shared.id]);
      expect(rows.map((r: any) => r.building_id)).toEqual([BUILDING_A, BUILDING_B]);
    });

    it('should protect the landlord from locking themselves out, and every building from losing its last landlord', async () => {
      expect((await http.patch(`/api/v1/users/${landlordA.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(409)).body.errorCode).toBe('RES_CONFLICT');
      await http.patch(`/api/v1/users/${landlordA.id}`).set(bearer(landlordToken)).send({ roles: ['PROPERTY_MANAGER'] }).expect(409);

      // Đồng chủ nhà tòa A, đồng thời là chủ nhà DUY NHẤT của một tòa nhà khác (ngoài phạm vi của landlordA)
      const onlyTheirs = randomUUID();
      const coLandlord = await createUser(['LANDLORD'], { buildings: [BUILDING_A, onlyTheirs] });
      const orphan = await http.patch(`/api/v1/users/${coLandlord.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(409);
      expect(orphan.body.details).toEqual([{ field: 'buildingIds', issue: 'LAST_LANDLORD', buildingId: onlyTheirs }]);
      await http.patch(`/api/v1/users/${coLandlord.id}`).set(bearer(landlordToken)).send({ roles: ['PROPERTY_MANAGER'] }).expect(409);

      // Khi tòa nhà kia có thêm một chủ nhà ACTIVE, vô hiệu hóa được
      await createUser(['LANDLORD'], { buildings: [onlyTheirs] });
      await http.patch(`/api/v1/users/${coLandlord.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(200);
      await http.patch(`/api/v1/users/${coLandlord.id}`).set(bearer(landlordToken)).send({ buildingIds: [] }).expect(400);
    });

    it("should leave tenant accounts' roles to occupancy, guard optimistic locking and hide other landlords' people", async () => {
      const tenant = await createUser(['TENANT']);
      await http.patch(`/api/v1/users/${tenant.id}`).set(bearer(landlordToken)).send({ roles: ['GUARD'] }).expect(409);
      await http.patch(`/api/v1/users/${tenant.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(200);

      const guard = await createUser(['GUARD']);
      await http.patch(`/api/v1/users/${guard.id}`).set(bearer(landlordToken)).send({ fullName: 'Bảo vệ A', version: 1 }).expect(200);
      const stale = await http.patch(`/api/v1/users/${guard.id}`).set(bearer(landlordToken)).send({ fullName: 'Ghi đè', version: 1 }).expect(409);
      expect(stale.body.errorCode).toBe('RES_CONCURRENCY_CONFLICT');

      const foreign = await createUser(['GUARD'], { buildings: [BUILDING_B] });
      await http.patch(`/api/v1/users/${foreign.id}`).set(bearer(landlordToken)).send({ status: 'DISABLED' }).expect(404);
      await http.patch(`/api/v1/users/${guard.id}`).set(bearer(landlordToken)).send({}).expect(400);
      await http.patch(`/api/v1/users/${guard.id}`).set(bearer(landlordToken)).send({ status: 'PENDING_ACTIVATION' }).expect(400);
    });
  });

  // ===========================================================================
  // Supporting pieces used by later modules
  // ===========================================================================
  describe('Tenant account provisioning (used by Contracts at move-in)', () => {
    it('should create one pending TENANT login per phone number, idempotently and safely in parallel', async () => {
      const provisioning = app.get(TenantAccountProvisioningService);
      const { phone, e164 } = nextPhone();
      const results = await Promise.all([
        provisioning.provision({ phone, fullName: 'Nguyễn Văn A', buildingId: BUILDING_A }),
        provisioning.provision({ phone: e164, fullName: 'Nguyễn Văn A', buildingId: BUILDING_A }),
      ]);
      expect(new Set(results.map((r) => r.userId)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);

      const again = await provisioning.provision({ phone, fullName: 'Nguyễn Văn A', buildingId: BUILDING_B });
      expect(again).toMatchObject({ userId: results[0].userId, created: false, status: 'PENDING_ACTIVATION' });
      const access = await dataSource.query(`SELECT building_id FROM user_building_access WHERE user_id = $1 ORDER BY building_id`, [again.userId]);
      expect(access.map((a: any) => a.building_id)).toEqual([BUILDING_A, BUILDING_B]);
    });

    it('should add TENANT to an existing staff account instead of creating a second account, and never reopen a disabled one', async () => {
      const provisioning = app.get(TenantAccountProvisioningService);
      const guard = await createUser(['GUARD']);
      const result = await provisioning.provision({ phone: guard.phone, fullName: 'ignored', buildingId: BUILDING_A });
      expect(result).toMatchObject({ userId: guard.id, created: false, status: 'ACTIVE' });
      const roles = await dataSource.query(`SELECT role_code FROM user_roles WHERE user_id = $1 ORDER BY role_code`, [guard.id]);
      expect(roles.map((r: any) => r.role_code)).toEqual(['GUARD', 'TENANT']);

      const off = await createUser(['GUARD'], { status: 'DISABLED' });
      expect((await provisioning.provision({ phone: off.phone, fullName: 'x', buildingId: BUILDING_A })).status).toBe('DISABLED');
    });
  });

  describe('Permission source of truth (PERMISSION_RULES_LOADER)', () => {
    it('should grant nothing to disabled, pending or unknown accounts', async () => {
      const loader = app.get(UserRolesPermissionLoader);
      const active = await createUser(['GUARD']);
      const off = await createUser(['LANDLORD'], { status: 'DISABLED' });
      const pending = await createUser(['TENANT'], { status: 'PENDING_ACTIVATION', password: null });

      expect((await loader.loadRules(active.id)).length).toBeGreaterThan(0);
      expect(await loader.loadRules(off.id)).toEqual([]);
      expect(await loader.loadRules(pending.id)).toEqual([]);
      expect(await loader.loadRules(randomUUID())).toEqual([]);
      expect(await loader.loadRules('not-a-uuid')).toEqual([]);
    });
  });
});
