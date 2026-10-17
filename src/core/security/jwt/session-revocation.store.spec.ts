import { ServiceUnavailableException } from '@nestjs/common';
import { SessionRevocationStore } from './session-revocation.store';
import { parseDurationSeconds, isValidDuration } from './duration';

const SID = '22222222-2222-4222-8222-222222222222';

describe('SessionRevocationStore', () => {
  afterEach(() => jest.useRealTimers());

  it('should remember a revoked session only for the access-token lifetime (in-memory fallback)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T00:00:00Z') });
    const store = new SessionRevocationStore(null);
    await store.markRevoked([SID], 900);
    expect(await store.isRevoked(SID)).toBe(true);
    expect(await store.isRevoked('33333333-3333-4333-8333-333333333333')).toBe(false);
    jest.advanceTimersByTime(899_000);
    expect(await store.isRevoked(SID)).toBe(true);
    jest.advanceTimersByTime(1_000);
    expect(await store.isRevoked(SID)).toBe(false); // access token đã hết hạn tự nhiên
  });

  it('should write every revoked session with the TTL in one Redis round trip', async () => {
    const pipeline = { set: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) };
    const redis = { pipeline: jest.fn(() => pipeline), exists: jest.fn() };
    await new SessionRevocationStore(redis as any).markRevoked([SID, 'sid-2'], 899.4);
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.set).toHaveBeenCalledWith(`auth:revoked-sid:${SID}`, '1', 'EX', 900);
    expect(pipeline.set).toHaveBeenCalledWith('auth:revoked-sid:sid-2', '1', 'EX', 900);
  });

  it('should do nothing for an empty list', async () => {
    const redis = { pipeline: jest.fn() };
    await new SessionRevocationStore(redis as any).markRevoked([], 900);
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it('should fail closed (503) when Redis cannot answer, rather than accept a possibly revoked token', async () => {
    const redis = { exists: jest.fn().mockRejectedValue(new Error('ECONNRESET')) };
    await expect(new SessionRevocationStore(redis as any).isRevoked(SID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('parseDurationSeconds', () => {
  it.each([
    ['900', 900],
    ['45s', 45],
    ['15m', 900],
    ['12h', 43_200],
    ['7d', 604_800],
    [' 30D ', 2_592_000],
  ])('should parse %p as %p seconds', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });

  it.each(['', '0', '0m', '-5m', '1.5h', '7 days', '1w', 'abc'])('should reject %p', (input) => {
    expect(isValidDuration(input)).toBe(false);
    expect(() => parseDurationSeconds(input)).toThrow(/Invalid duration/);
  });
});
