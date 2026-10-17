import { ExecutionContext } from '@nestjs/common';
import { buildCorsConfig } from './headers/security-headers.config';
import { RedisThrottlerStorage } from './throttler/throttler-storage.provider';
import { resolveThrottleTier, ThrottleSensitive, ThrottleSearch } from './throttler/throttler.decorators';
import { THROTTLE_TIERS } from './throttler/throttler.constants';

describe('Security headers & throttling', () => {
  describe('CORS whitelist', () => {
    const check = (allowed: string[], origin: string | undefined) =>
      new Promise<boolean>((resolve, reject) => {
        const { origin: resolver } = buildCorsConfig(allowed) as any;
        resolver(origin, (err: Error | null, allow: boolean) => (err ? reject(err) : resolve(allow)));
      });

    it('should allow exact origins and https subdomains of wildcard entries', async () => {
      const allowed = ['https://admin.partner.com', '*.rental.vn'];
      await expect(check(allowed, 'https://admin.partner.com')).resolves.toBe(true);
      await expect(check(allowed, 'https://contract.rental.vn')).resolves.toBe(true);
      await expect(check(allowed, 'https://a.b.rental.vn')).resolves.toBe(true);
    });

    it('should block look-alike domains and plain-http subdomains without throwing (no 500)', async () => {
      const allowed = ['*.rental.vn'];
      await expect(check(allowed, 'https://evilrental.vn')).resolves.toBe(false);
      await expect(check(allowed, 'https://rental.vn.evil.com')).resolves.toBe(false);
      await expect(check(allowed, 'http://contract.rental.vn')).resolves.toBe(false);
    });

    it('should support explicit regex entries', async () => {
      const allowed = ['/^https:\\/\\/pr-\\d+\\.preview\\.rental\\.vn$/'];
      await expect(check(allowed, 'https://pr-42.preview.rental.vn')).resolves.toBe(true);
      await expect(check(allowed, 'https://pr-x.preview.rental.vn')).resolves.toBe(false);
    });

    it('should allow requests without Origin header (server-to-server)', async () => {
      await expect(check(['https://a.com'], undefined)).resolves.toBe(true);
    });
  });

  describe('Throttle tiers', () => {
    const contextFor = (handler: () => void, cls: new () => unknown) =>
      ({ getHandler: () => handler, getClass: () => cls }) as unknown as ExecutionContext;

    it('should default every route to the PUBLIC tier and honour method/class overrides', () => {
      class PlainController {
        list() {}
      }
      @ThrottleSearch()
      class SearchController {
        find() {}
        @ThrottleSensitive()
        login() {}
      }

      expect(resolveThrottleTier(contextFor(PlainController.prototype.list, PlainController))).toBe(
        THROTTLE_TIERS.PUBLIC,
      );
      expect(resolveThrottleTier(contextFor(SearchController.prototype.find, SearchController))).toBe(
        THROTTLE_TIERS.SEARCH,
      );
      expect(resolveThrottleTier(contextFor(SearchController.prototype.login, SearchController))).toBe(
        THROTTLE_TIERS.SENSITIVE,
      );
    });
  });

  describe('RedisThrottlerStorage', () => {
    it('should map the Lua result (ms) into a ThrottlerStorageRecord (seconds)', async () => {
      const redis = { eval: jest.fn().mockResolvedValue([6, 30500, 1, 60000]) };
      const storage = new RedisThrottlerStorage(redis as any);

      const record = await storage.increment('k', 60000, 5, 60000, 'sensitive');

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        2,
        'throttle:sensitive:k:hits',
        'throttle:sensitive:k:block',
        60000,
        5,
        60000,
      );
      expect(record).toEqual({
        totalHits: 6,
        timeToExpire: 31,
        isBlocked: true,
        timeToBlockExpire: 60,
      });
    });
  });
});

// npx jest src/core/security/security.spec.ts
