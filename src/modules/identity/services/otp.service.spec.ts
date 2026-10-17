import { OtpService, vietnamDay } from './otp.service';
import { InMemoryIdentityStateStore } from './identity-state.store';
import { OtpPurpose } from '../identity.constants';
import { httpErrorOf, identityTestConfig } from '../identity.test-utils';

const PHONE_KEY = 'phone-key-a';
const RECIPIENT = { userId: 'user-1', phoneE164: '+84901234567' };

describe('OtpService', () => {
  let store: InMemoryIdentityStateStore;
  let notifications: { dispatch: jest.Mock };
  let otp: OtpService;

  const build = (env: Record<string, string> = {}) => {
    store = new InMemoryIdentityStateStore();
    notifications = { dispatch: jest.fn().mockResolvedValue({ success: true, results: [] }) };
    otp = new OtpService(store, identityTestConfig(env), notifications as any);
  };

  /** Mã đã gửi = tham số `otp` của template SMS */
  const sentCode = (call = -1) => notifications.dispatch.mock.calls.at(call)![0].payload.context.otp as string;
  const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

  const issueReset = () => otp.issue({ purpose: OtpPurpose.RESET_PASSWORD, phoneKey: PHONE_KEY, recipient: RECIPIENT });
  const verifyReset = (code: string) => otp.verify({ purpose: OtpPurpose.RESET_PASSWORD, phoneKey: PHONE_KEY }, code);

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T03:00:00Z') });
    build();
  });

  afterEach(() => jest.useRealTimers());

  it('should send a 6-digit code by SMS with the OTP template and never store it in clear text', async () => {
    const issued = await issueReset();
    const code = sentCode();
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(issued).toMatchObject({ delivered: true, channel: 'SMS', expiresInSeconds: 300, resendAfterSeconds: 60 });
    expect(issued.debugCode).toBeUndefined();
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ['SMS'],
        recipient: expect.objectContaining({ phone: '+84901234567' }),
        payload: expect.objectContaining({ templateName: 'OTP_VERIFICATION', context: { otp: code, expiresInMinutes: 5 } }),
      }),
    );
    const stored = (await store.get(`otp:RESET_PASSWORD:${PHONE_KEY}`))!;
    expect(stored).not.toContain(code);
  });

  it('should accept the right code exactly once', async () => {
    await issueReset();
    const code = sentCode();
    await expect(verifyReset(code)).resolves.toMatchObject({ userId: 'user-1', purpose: OtpPurpose.RESET_PASSWORD });
    expect(await httpErrorOf(verifyReset(code))).toMatchObject({ status: 400, errorCode: 'AUTH_OTP_EXPIRED' });
  });

  it('should let only one of two simultaneous submissions of the right code succeed', async () => {
    await issueReset();
    const code = sentCode();
    const results = await Promise.allSettled([verifyReset(code), verifyReset(code)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('should count wrong codes down and burn the challenge on the 5th wrong code', async () => {
    await issueReset();
    const code = sentCode();
    for (let remaining = 4; remaining >= 1; remaining--) {
      expect(await httpErrorOf(verifyReset(wrongCode(code)))).toMatchObject({
        status: 400,
        errorCode: 'AUTH_OTP_INVALID',
        details: [{ field: 'code', issue: 'INVALID', attemptsRemaining: remaining }],
      });
    }
    expect(await httpErrorOf(verifyReset(wrongCode(code)))).toMatchObject({ status: 429, errorCode: 'AUTH_OTP_TOO_MANY_ATTEMPTS' });
    // Kể cả mã đúng cũng không còn dùng được
    expect(await httpErrorOf(verifyReset(code))).toMatchObject({ errorCode: 'AUTH_OTP_EXPIRED' });
  });

  it('should treat malformed codes as wrong attempts without crashing', async () => {
    await issueReset();
    expect(await httpErrorOf(verifyReset('12345'))).toMatchObject({ errorCode: 'AUTH_OTP_INVALID' });
    expect(await httpErrorOf(verifyReset('abcdef'))).toMatchObject({ errorCode: 'AUTH_OTP_INVALID' });
  });

  it('should expire the code after 5 minutes', async () => {
    await issueReset();
    const code = sentCode();
    jest.advanceTimersByTime(300_000);
    expect(await httpErrorOf(verifyReset(code))).toMatchObject({ errorCode: 'AUTH_OTP_EXPIRED' });
  });

  it('should enforce the 60-second resend cooldown with Retry-After, and a new code replaces the old one', async () => {
    await issueReset();
    const first = sentCode();
    jest.advanceTimersByTime(20_000);
    expect(await httpErrorOf(issueReset())).toMatchObject({ status: 429, errorCode: 'AUTH_OTP_RATE_LIMITED', retryAfterSeconds: 40 });

    jest.advanceTimersByTime(40_000);
    await issueReset();
    const second = sentCode();
    if (second !== first) {
      expect(await httpErrorOf(verifyReset(first))).toMatchObject({ errorCode: 'AUTH_OTP_INVALID' });
    }
    await expect(verifyReset(second)).resolves.toBeDefined();
  });

  it('should share the cooldown across purposes for the same phone number', async () => {
    await issueReset();
    expect(
      await httpErrorOf(otp.issue({ purpose: OtpPurpose.ACTIVATE_ACCOUNT, phoneKey: PHONE_KEY, recipient: RECIPIENT })),
    ).toMatchObject({ errorCode: 'AUTH_OTP_RATE_LIMITED' });
  });

  it('should allow 5 activation/reset codes per Vietnamese day, then refuse until midnight (VN time)', async () => {
    for (let i = 0; i < 5; i++) {
      await issueReset();
      jest.advanceTimersByTime(61_000);
    }
    const refused = await httpErrorOf(issueReset());
    expect(refused).toMatchObject({ status: 429, errorCode: 'AUTH_OTP_RATE_LIMITED' });
    // 03:05 UTC = 10:05 giờ VN → còn ~13 giờ 55 phút tới nửa đêm
    expect(refused.retryAfterSeconds).toBeGreaterThan(13 * 3600);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(14 * 3600);

    jest.advanceTimersByTime(refused.retryAfterSeconds! * 1000);
    await expect(issueReset()).resolves.toMatchObject({ delivered: true });
  });

  it('should give login codes their own, larger daily allowance', async () => {
    build({ AUTH_OTP_DAILY_LIMIT: '1', AUTH_MFA_OTP_DAILY_LIMIT: '3' });
    await issueReset();
    jest.advanceTimersByTime(61_000);
    for (let i = 0; i < 3; i++) {
      await otp.issue({ purpose: OtpPurpose.LOGIN_MFA, phoneKey: PHONE_KEY, recipient: RECIPIENT });
      jest.advanceTimersByTime(61_000);
    }
    expect(
      await httpErrorOf(otp.issue({ purpose: OtpPurpose.LOGIN_MFA, phoneKey: PHONE_KEY, recipient: RECIPIENT })),
    ).toMatchObject({ errorCode: 'AUTH_OTP_RATE_LIMITED' });
  });

  it('should apply limits to numbers without an account but never generate or send a code for them', async () => {
    const issued = await otp.issue({ purpose: OtpPurpose.RESET_PASSWORD, phoneKey: 'unknown', recipient: null });
    expect(issued).toMatchObject({ delivered: false, expiresInSeconds: 300, resendAfterSeconds: 60 });
    expect(issued.debugCode).toBeUndefined();
    expect(notifications.dispatch).not.toHaveBeenCalled();
    expect(await store.get('otp:RESET_PASSWORD:unknown')).toBeNull();
    expect(
      await httpErrorOf(otp.issue({ purpose: OtpPurpose.RESET_PASSWORD, phoneKey: 'unknown', recipient: null })),
    ).toMatchObject({ errorCode: 'AUTH_OTP_RATE_LIMITED' });
  });

  describe('login second factor (LOGIN_MFA)', () => {
    const issueMfa = () =>
      otp.issue({ purpose: OtpPurpose.LOGIN_MFA, phoneKey: PHONE_KEY, recipient: RECIPIENT, deviceId: 'ios-1', ip: '10.0.0.1' });
    const verifyMfa = (challengeId: string, code: string, binding = { deviceId: 'ios-1', ip: '10.0.0.1' }) =>
      otp.verify({ purpose: OtpPurpose.LOGIN_MFA, challengeId }, code, binding);

    it('should be looked up by challenge id and bound to the device and IP that passed the password step', async () => {
      const { challengeId } = await issueMfa();
      const code = sentCode();
      expect(await httpErrorOf(verifyMfa(challengeId, code, { deviceId: 'android-9', ip: '10.0.0.1' }))).toMatchObject({
        errorCode: 'AUTH_OTP_INVALID',
      });
      expect(await httpErrorOf(verifyMfa(challengeId, code, { deviceId: 'ios-1', ip: '172.16.0.5' }))).toMatchObject({
        errorCode: 'AUTH_OTP_INVALID',
      });
      await expect(verifyMfa(challengeId, code)).resolves.toMatchObject({ userId: 'user-1', deviceId: 'ios-1' });
    });

    it('should not accept a code issued for another challenge', async () => {
      const first = await issueMfa();
      jest.advanceTimersByTime(61_000);
      await issueMfa();
      const secondCode = sentCode();
      expect(await httpErrorOf(verifyMfa(first.challengeId, secondCode))).toMatchObject({ errorCode: 'AUTH_OTP_INVALID' });
    });
  });

  describe('delivery', () => {
    it('should try Zalo first when the account is linked to Zalo, then fall back to SMS', async () => {
      notifications.dispatch
        .mockResolvedValueOnce({ success: false, results: [] })
        .mockResolvedValueOnce({ success: true, results: [] });
      const issued = await otp.issue({
        purpose: OtpPurpose.RESET_PASSWORD,
        phoneKey: PHONE_KEY,
        recipient: { ...RECIPIENT, zaloUserId: 'zalo-1' },
      });
      expect(notifications.dispatch.mock.calls.map((c) => c[0].channels)).toEqual([['ZALO'], ['SMS']]);
      expect(issued).toMatchObject({ delivered: true, channel: 'SMS' });
    });

    it('should report a failed delivery (all channels down or throwing)', async () => {
      notifications.dispatch.mockRejectedValue(new Error('twilio down'));
      await expect(issueReset()).resolves.toMatchObject({ delivered: false, channel: undefined });
    });
  });

  it('should echo the code only when AUTH_OTP_DEBUG_ECHO is enabled (local / test)', async () => {
    build({ AUTH_OTP_DEBUG_ECHO: 'true' });
    const issued = await issueReset();
    expect(issued.debugCode).toBe(sentCode());
  });

  it('should compute the Vietnamese calendar day (UTC+7) for the daily limit', () => {
    expect(vietnamDay(Date.parse('2026-10-17T16:59:59Z'))).toEqual({ day: '20261017', secondsToMidnight: 1 });
    expect(vietnamDay(Date.parse('2026-10-17T17:00:00Z'))).toEqual({ day: '20261018', secondsToMidnight: 86_400 });
  });
});
