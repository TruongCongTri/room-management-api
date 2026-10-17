/**
 * Nhánh bảo mật của AuthService với LoginLockService / OtpService THẬT (kho trạng thái bộ nhớ) và argon2 thật;
 * chỉ mock biên ngoài (DB, JWT, thông báo, audit). Luồng HTTP đầy đủ trên PostgreSQL + Redis: test/identity.e2e-spec.ts.
 */
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { LoginLockService } from './login-lock.service';
import { OtpService } from './otp.service';
import { PasswordHasherService, ARGON2_OPTIONS } from './password-hasher.service';
import { InMemoryIdentityStateStore } from './identity-state.store';
import { EncryptionService } from '../../../core/security/encryption/encryption.service';
import { User, UserStatus } from '../entities/user.entity';
import { SessionRevokedReason } from '../entities/auth-session.entity';
import { OtpPurpose } from '../identity.constants';
import { httpErrorOf, identityTestConfig } from '../identity.test-utils';

const PASSWORD = 'Correct-Horse-9';
const CLIENT = { ipAddress: '10.0.0.1', userAgent: 'jest' };

describe('AuthService (security branches)', () => {
  let passwordHash: string;
  let users: Map<string, User & { passwordHash?: string | null }>;
  let access: Record<string, { roles: string[]; buildingIds: string[] }>;
  let hasher: PasswordHasherService;
  let otp: OtpService;
  let sessions: Record<string, jest.Mock>;
  let jwt: { signAccessToken: jest.Mock };
  let notifications: { dispatch: jest.Mock };
  let audit: { record: jest.Mock };
  let repo: { update: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let service: AuthService;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);
  });

  const addUser = (id: string, phoneE164: string, status: UserStatus, roles: string[], hash: string | null = passwordHash) => {
    users.set(phoneE164, Object.assign(new User(), { id, phoneE164, fullName: id, status, passwordHash: hash, version: 1 }));
    access[id] = { roles, buildingIds: ['b1000000-0000-4000-8000-000000000001'] };
  };

  beforeEach(() => {
    const config = identityTestConfig();
    users = new Map();
    access = {};
    hasher = new PasswordHasherService();
    jest.spyOn(hasher, 'verify');
    const store = new InMemoryIdentityStateStore();
    notifications = { dispatch: jest.fn().mockResolvedValue({ success: true, results: [] }) };
    otp = new OtpService(store, config, notifications as any);
    jest.spyOn(otp, 'verify');
    jest.spyOn(otp, 'issue');
    sessions = {
      create: jest.fn().mockImplementation(async (userId: string) => ({
        session: { id: '3f0c9a52-6f1e-4d0b-9a77-1c2d3e4f5a6b', userId, idleExpiresAt: new Date('2026-10-24T00:00:00Z') },
        refreshToken: 'refresh-token',
      })),
      revokeAll: jest.fn().mockResolvedValue([]),
      revoke: jest.fn().mockResolvedValue(true),
      rotate: jest.fn(),
      markRevoked: jest.fn(),
    };
    jwt = { signAccessToken: jest.fn().mockResolvedValue('access-token') };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    repo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation(async (u) => u),
      findOne: jest.fn().mockImplementation(async ({ where }) => [...users.values()].find((u) => u.id === where.id) ?? null),
    };
    const dataSource = {
      getRepository: () => repo,
      transaction: (cb: (m: unknown) => unknown) => cb({ getRepository: () => repo }),
    };
    const directory = {
      findByPhone: jest.fn(async (phone: string) => users.get(phone) ?? null),
      findById: jest.fn(async (id: string) => [...users.values()].find((u) => u.id === id) ?? null),
      getAccess: jest.fn(async (id: string) => access[id]),
    };
    service = new AuthService(
      dataSource as any,
      config,
      new EncryptionService(config),
      jwt as any,
      hasher,
      new LoginLockService(store, config),
      otp,
      sessions as any,
      directory as any,
      { resolve: jest.fn().mockResolvedValue(null) } as any,
      audit as any,
      notifications as any,
    );
  });

  describe('login', () => {
    it('should answer a wrong password, an unknown number and a not-yet-activated account identically', async () => {
      addUser('active', '+84901000001', UserStatus.ACTIVE, ['PROPERTY_MANAGER']);
      addUser('pending', '+84901000002', UserStatus.PENDING_ACTIVATION, ['TENANT'], null);

      const wrong = await httpErrorOf(service.login('0901000001', 'Wrong-Password-1', {}, CLIENT));
      const unknown = await httpErrorOf(service.login('0901999999', PASSWORD, {}, CLIENT));
      const pending = await httpErrorOf(service.login('0901000002', PASSWORD, {}, CLIENT));

      expect(wrong).toEqual({ status: 401, errorCode: 'AUTH_CREDENTIALS_INVALID', retryAfterSeconds: undefined, details: undefined });
      expect(unknown).toEqual(wrong);
      expect(pending).toEqual(wrong);
      // Cùng chi phí argon2 cho cả số không tồn tại (so với hash giả)
      expect(hasher.verify).toHaveBeenCalledTimes(3);
      expect(hasher.verify).toHaveBeenCalledWith(undefined, PASSWORD);
    });

    it('should lock an UNKNOWN number after 5 attempts as well (lock does not reveal registration)', async () => {
      for (let i = 0; i < 4; i++) await httpErrorOf(service.login('0909999999', 'x', {}, CLIENT));
      expect(await httpErrorOf(service.login('0909999999', 'x', {}, CLIENT))).toMatchObject({
        status: 423,
        errorCode: 'AUTH_ACCOUNT_LOCKED',
        retryAfterSeconds: 900,
      });
    });

    it('should refuse a locked number BEFORE checking the password, even when the password is right', async () => {
      addUser('active', '+84901000001', UserStatus.ACTIVE, ['GUARD']);
      for (let i = 0; i < 5; i++) await httpErrorOf(service.login('0901000001', 'nope', {}, CLIENT));
      (hasher.verify as jest.Mock).mockClear();

      expect(await httpErrorOf(service.login('+84 90 100 0001', PASSWORD, {}, CLIENT))).toMatchObject({ status: 423 });
      expect(hasher.verify).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('should tell a disabled user only after the right password, and count wrong passwords as usual', async () => {
      addUser('off', '+84901000003', UserStatus.DISABLED, ['GUARD']);
      expect(await httpErrorOf(service.login('0901000003', 'bad-password', {}, CLIENT))).toMatchObject({ status: 401 });
      expect(await httpErrorOf(service.login('0901000003', PASSWORD, {}, CLIENT))).toMatchObject({
        status: 403,
        errorCode: 'AUTH_ACCOUNT_DISABLED',
      });
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('should reject a malformed phone number as a validation error on the phone field', async () => {
      expect(await httpErrorOf(service.login('0241234567', PASSWORD, {}, CLIENT))).toMatchObject({
        status: 400,
        errorCode: 'REQ_VALIDATION_ERROR',
        details: [{ field: 'phone', message: expect.any(String) }],
      });
    });

    it('should issue a token pair without the raw phone number in any claim', async () => {
      addUser('pm', '+84901000004', UserStatus.ACTIVE, ['PROPERTY_MANAGER']);
      const result = await service.login('0901000004', PASSWORD, { deviceName: 'iPhone' }, CLIENT);

      expect(result.kind).toBe('TOKENS');
      const claims = jwt.signAccessToken.mock.calls[0][0];
      expect(claims).toEqual({
        sub: 'pm',
        sid: '3f0c9a52-6f1e-4d0b-9a77-1c2d3e4f5a6b',
        phoneMasked: '090****004',
        buildingId: 'b1000000-0000-4000-8000-000000000001',
        buildingIds: ['b1000000-0000-4000-8000-000000000001'],
        roles: ['PROPERTY_MANAGER'],
      });
      expect(JSON.stringify(claims)).not.toContain('901000004');
      expect(sessions.create).toHaveBeenCalledWith('pm', expect.objectContaining({ deviceName: 'iPhone', ipAddress: '10.0.0.1' }), null);
    });

    it('should require the OTP step for finance roles and open no session until it is passed', async () => {
      addUser('landlord', '+84901000005', UserStatus.ACTIVE, ['LANDLORD']);
      const result = await service.login('0901000005', PASSWORD, { deviceId: 'ios-1' }, CLIENT);

      expect(result).toMatchObject({
        kind: 'MFA_REQUIRED',
        challenge: { mfaRequired: true, otpSentTo: '090****005', channel: 'SMS', expiresInSeconds: 300 },
      });
      expect(sessions.create).not.toHaveBeenCalled();
      expect(jwt.signAccessToken).not.toHaveBeenCalled();
      expect(otp.issue).toHaveBeenCalledWith(expect.objectContaining({ purpose: OtpPurpose.LOGIN_MFA, deviceId: 'ios-1', ip: '10.0.0.1' }));
    });

    it('should fail with 503 instead of a dead-end challenge when the OTP cannot be delivered', async () => {
      addUser('acc', '+84901000006', UserStatus.ACTIVE, ['ACCOUNTANT']);
      notifications.dispatch.mockResolvedValue({ success: false, results: [] });
      expect(await httpErrorOf(service.login('0901000006', PASSWORD, {}, CLIENT))).toMatchObject({ status: 503 });
    });

    it('should complete the finance login with the OTP from the same device and IP only', async () => {
      addUser('landlord', '+84901000005', UserStatus.ACTIVE, ['LANDLORD']);
      const result = await service.login('0901000005', PASSWORD, { deviceId: 'ios-1', deviceName: 'iPhone' }, CLIENT);
      const { challengeId } = (result as any).challenge;
      const code = notifications.dispatch.mock.calls[0][0].payload.context.otp;

      expect(await httpErrorOf(service.verifyLoginMfa(challengeId, code, { deviceId: 'ios-1' }, { ipAddress: '10.9.9.9' }))).toMatchObject({
        errorCode: 'AUTH_OTP_INVALID',
      });
      await service.verifyLoginMfa(challengeId, code, { deviceId: 'ios-1' }, CLIENT);
      expect(sessions.create).toHaveBeenCalledWith('landlord', expect.objectContaining({ deviceName: 'iPhone' }), expect.any(Date));
    });
  });

  describe('OTP self-service', () => {
    it('should only send an activation code to PENDING accounts and a reset code to ACTIVE ones, with identical responses', async () => {
      addUser('active', '+84901000001', UserStatus.ACTIVE, ['GUARD']);
      addUser('pending', '+84901000002', UserStatus.PENDING_ACTIVATION, ['TENANT'], null);

      const responses = [
        await service.requestOtp('0901000001', OtpPurpose.ACTIVATE_ACCOUNT, CLIENT), // đã kích hoạt → không gửi
        await service.requestOtp('0901000002', OtpPurpose.RESET_PASSWORD, { ipAddress: '10.0.0.2' }), // chưa kích hoạt → không gửi
        await service.requestOtp('0901777777', OtpPurpose.RESET_PASSWORD, CLIENT), // không tồn tại → không gửi
      ];
      expect(notifications.dispatch).not.toHaveBeenCalled();
      for (const response of responses) expect(response).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });

      expect(await service.requestOtp('0901000003', OtpPurpose.RESET_PASSWORD, CLIENT)).toEqual(responses[0]);
    });

    it('should reject a weak new password BEFORE consuming the activation code, so the code can still be used', async () => {
      addUser('pending', '+84901000002', UserStatus.PENDING_ACTIVATION, ['TENANT'], null);
      await service.requestOtp('0901000002', OtpPurpose.ACTIVATE_ACCOUNT, CLIENT);
      const code = notifications.dispatch.mock.calls[0][0].payload.context.otp;

      expect(await httpErrorOf(service.activate('0901000002', code, 'short', {}, CLIENT))).toMatchObject({
        status: 422,
        errorCode: 'AUTH_PASSWORD_POLICY_VIOLATION',
        details: [{ field: 'newPassword', issue: 'TOO_SHORT' }],
      });
      expect(otp.verify).not.toHaveBeenCalled();

      await service.activate('0901000002', code, 'A-much-better-passphrase', {}, CLIENT);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: UserStatus.ACTIVE, passwordHash: expect.stringMatching(/^\$argon2id\$/) }));
    });

    it('should revoke every session after a password reset', async () => {
      addUser('active', '+84901000001', UserStatus.ACTIVE, ['GUARD']);
      await service.requestOtp('0901000001', OtpPurpose.RESET_PASSWORD, CLIENT);
      const code = notifications.dispatch.mock.calls[0][0].payload.context.otp;
      await service.resetPassword('0901000001', code, 'A-much-better-passphrase');
      expect(sessions.revokeAll).toHaveBeenCalledWith('active', SessionRevokedReason.PASSWORD_RESET, undefined, expect.anything());
    });
  });

  describe('changePassword', () => {
    const actor = { id: 'pm', sessionId: 'current-session', roles: [], rules: [] };

    beforeEach(() => addUser('pm', '+84901000004', UserStatus.ACTIVE, ['PROPERTY_MANAGER']));

    it('should count a wrong current password towards the login lock', async () => {
      for (let i = 0; i < 4; i++) {
        expect(await httpErrorOf(service.changePassword(actor, 'wrong', 'A-much-better-passphrase'))).toMatchObject({ status: 401 });
      }
      expect(await httpErrorOf(service.changePassword(actor, 'wrong', 'A-much-better-passphrase'))).toMatchObject({ status: 423 });
      expect(await httpErrorOf(service.login('0901000004', PASSWORD, {}, CLIENT))).toMatchObject({ status: 423 });
    });

    it('should refuse to "change" to the same password', async () => {
      expect(await httpErrorOf(service.changePassword(actor, PASSWORD, PASSWORD))).toMatchObject({
        status: 422,
        details: [{ field: 'newPassword', issue: 'SAME_AS_CURRENT' }],
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should keep the current session and revoke all the others', async () => {
      await service.changePassword(actor, PASSWORD, 'A-much-better-passphrase');
      expect(sessions.revokeAll).toHaveBeenCalledWith('pm', SessionRevokedReason.PASSWORD_CHANGED, 'current-session', expect.anything());
    });
  });

  describe('refresh', () => {
    it('should alert the owner and refuse when a rotated refresh token is replayed', async () => {
      addUser('pm', '+84901000004', UserStatus.ACTIVE, ['PROPERTY_MANAGER']);
      sessions.rotate.mockResolvedValue({ status: 'REUSED', session: { id: 's1', userId: 'pm' } });

      expect(await httpErrorOf(service.refresh('s1.secret', CLIENT))).toMatchObject({ status: 401, errorCode: 'AUTH_REFRESH_TOKEN_REUSED' });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ event: 'REFRESH_TOKEN_REUSED' }) }));
      expect(notifications.dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ templateName: 'SECURITY_ALERT' }) }));
    });

    it('should not refresh a session whose account was disabled meanwhile', async () => {
      addUser('off', '+84901000003', UserStatus.DISABLED, ['GUARD']);
      sessions.rotate.mockResolvedValue({ status: 'ROTATED', session: { id: 's2', userId: 'off' }, refreshToken: 'x' });
      expect(await httpErrorOf(service.refresh('s2.secret', CLIENT))).toMatchObject({ status: 401, errorCode: 'AUTH_SESSION_REVOKED' });
      expect(sessions.revoke).toHaveBeenCalledWith('off', 's2', SessionRevokedReason.ACCOUNT_DISABLED);
      expect(jwt.signAccessToken).not.toHaveBeenCalled();
    });
  });

  it('should never write the raw phone number into the audit log', async () => {
    addUser('pm', '+84901000004', UserStatus.ACTIVE, ['PROPERTY_MANAGER']);
    await httpErrorOf(service.login('0901000004', 'bad-password', {}, CLIENT));
    await service.login('0901000004', PASSWORD, {}, CLIENT);
    const written = JSON.stringify(audit.record.mock.calls);
    expect(written).toContain('090****004');
    expect(written).not.toContain('901000004');
    expect(written).not.toContain(PASSWORD);
  });
});
