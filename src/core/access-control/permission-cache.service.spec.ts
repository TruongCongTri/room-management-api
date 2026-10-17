import { PermissionCacheService } from './permission-cache.service';
import { Action, PermissionEffect, Scope, EffectivePermissionRule } from './access-control.types';

describe('PermissionCacheService', () => {
  const rule: EffectivePermissionRule = {
    resource: 'contracts',
    action: Action.READ,
    scope: Scope.OWN,
    effect: PermissionEffect.GRANT,
  };

  it('should deduplicate and cache flattened rules (memory fallback)', async () => {
    const cache = new PermissionCacheService(null);
    await cache.cacheUserPermissions('usr_1', [rule, { ...rule }]);
    await expect(cache.getUserPermissions('usr_1')).resolves.toEqual([rule]);
  });

  it('should load from source on miss and serve from cache afterwards (cache-aside)', async () => {
    const cache = new PermissionCacheService(null);
    const loader = jest.fn().mockResolvedValue([rule]);

    await cache.getOrLoad('usr_2', loader);
    await cache.getOrLoad('usr_2', loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should invalidate cached permissions', async () => {
    const cache = new PermissionCacheService(null);
    await cache.cacheUserPermissions('usr_3', [rule]);
    await cache.invalidateUserPermissions('usr_3');
    await expect(cache.getUserPermissions('usr_3')).resolves.toBeNull();
  });

  it('should use Redis when available', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(JSON.stringify([rule])),
      del: jest.fn().mockResolvedValue(1),
    };
    const cache = new PermissionCacheService(redis as any);

    await cache.cacheUserPermissions('usr_4', [rule], 60);
    expect(redis.set).toHaveBeenCalledWith('permissions:user:usr_4', JSON.stringify([rule]), 'EX', 60);
    await expect(cache.getUserPermissions('usr_4')).resolves.toEqual([rule]);
  });
});

// npx jest src/core/access-control/permission-cache.service.spec.ts
