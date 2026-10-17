import { LoginLockService } from './login-lock.service';
import { InMemoryIdentityStateStore } from './identity-state.store';
import { httpErrorOf, identityTestConfig } from '../identity.test-utils';

const PHONE = 'phone-key-a';
const OTHER = 'phone-key-b';

describe('LoginLockService (lock per phone number)', () => {
  let lock: LoginLockService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T03:00:00Z') });
    lock = new LoginLockService(new InMemoryIdentityStateStore(), identityTestConfig());
  });

  afterEach(() => jest.useRealTimers());

  const fail = (times: number, key = PHONE) =>
    Array.from({ length: times }).reduce<Promise<any>>((p) => p.then(() => lock.recordFailure(key)), Promise.resolve());

  it('should not lock before the 5th wrong password, and lock for 15 minutes on the 5th', async () => {
    await fail(4);
    await expect(lock.assertNotLocked(PHONE)).resolves.toBeUndefined();
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 900 });
    expect(await httpErrorOf(lock.assertNotLocked(PHONE))).toMatchObject({ status: 423, errorCode: 'AUTH_ACCOUNT_LOCKED', retryAfterSeconds: 900 });
  });

  it('should count down Retry-After and release the lock exactly when it ends', async () => {
    await fail(5);
    jest.advanceTimersByTime(600_000);
    expect((await httpErrorOf(lock.assertNotLocked(PHONE))).retryAfterSeconds).toBe(300);
    jest.advanceTimersByTime(299_000);
    await expect(lock.assertNotLocked(PHONE)).rejects.toBeDefined();
    jest.advanceTimersByTime(1_000);
    await expect(lock.assertNotLocked(PHONE)).resolves.toBeUndefined();
  });

  it('should double the lock on each new lock within 24 hours and cap it at 24 hours', async () => {
    const lockLengths: number[] = [];
    for (let i = 0; i < 9; i++) {
      await fail(4);
      const outcome = await lock.recordFailure(PHONE);
      lockLengths.push(outcome.lockSeconds);
      jest.advanceTimersByTime(outcome.lockSeconds * 1000); // chờ hết khóa rồi thử sai tiếp
    }
    expect(lockLengths).toEqual([900, 1800, 3600, 7200, 14400, 28800, 57600, 86400, 86400]);
  });

  it('should forget the escalation 24 hours after the last lock ENDED, not before', async () => {
    await fail(5);
    jest.advanceTimersByTime(900_000);
    await fail(5); // lần 2 → khóa 30 phút
    jest.advanceTimersByTime(1_800_000 + 86_400_000 - 1_000); // 1 giây trước khi cấp khóa nguội
    await fail(4);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 3600 });

    jest.advanceTimersByTime(3_600_000 + 86_400_000 + 1_000);
    await fail(4);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 900 });
  });

  it('should only count failures inside the 15-minute window', async () => {
    await fail(4);
    jest.advanceTimersByTime(900_000);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: false });
  });

  it('should reset the failure counter on success but keep the escalation level', async () => {
    await fail(5);
    jest.advanceTimersByTime(900_000);
    await fail(4);
    await lock.recordSuccess(PHONE);
    await fail(4);
    await expect(lock.assertNotLocked(PHONE)).resolves.toBeUndefined(); // bộ đếm đã về 0
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 1800 }); // vẫn là lần khóa thứ 2
  });

  it('should keep phone numbers independent', async () => {
    await fail(5, PHONE);
    await expect(lock.assertNotLocked(OTHER)).resolves.toBeUndefined();
  });

  it('should fully release a lock and its escalation after a password reset', async () => {
    await fail(5);
    await lock.clear(PHONE);
    await expect(lock.assertNotLocked(PHONE)).resolves.toBeUndefined();
    await fail(4);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 900 });
  });

  it('should honour configured thresholds', async () => {
    lock = new LoginLockService(
      new InMemoryIdentityStateStore(),
      identityTestConfig({ AUTH_LOGIN_MAX_FAILURES: '2', AUTH_LOCK_BASE_SEC: '60', AUTH_LOCK_MAX_SEC: '100' }),
    );
    await fail(1);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 60 });
    jest.advanceTimersByTime(60_000);
    await fail(1);
    await expect(lock.recordFailure(PHONE)).resolves.toEqual({ locked: true, lockSeconds: 100 });
  });
});
