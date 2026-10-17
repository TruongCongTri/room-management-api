import { OccupancySelfScopeService, OccupancySelfScope } from './occupancy-self-scope';

const BUILDING = 'b1000000-0000-4000-8000-000000000001';
const SCOPE: OccupancySelfScope = { tenantId: 't1', contractId: 'c1', roomId: 'r1', roomNumber: 'P.302', occupantRole: 'CO_OCCUPANT' };

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    get: jest.fn(async (k: string) => data.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      data.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (data.delete(k) ? 1 : 0)),
  };
}

const moduleRefWith = (resolver?: unknown) => ({
  get: jest.fn(() => {
    if (!resolver) throw new Error('not found');
    return resolver;
  }),
});

describe('OccupancySelfScopeService ("my room" of a tenant)', () => {
  it('should fail closed - no room for anyone - until ContractsModule registers a resolver', async () => {
    const service = new OccupancySelfScopeService(moduleRefWith() as any, fakeRedis() as any);
    await expect(service.resolve('user-1', BUILDING)).resolves.toBeNull();
  });

  it('should return null without a building context instead of guessing one', async () => {
    const resolver = { resolve: jest.fn().mockResolvedValue(SCOPE) };
    const service = new OccupancySelfScopeService(moduleRefWith(resolver) as any, fakeRedis() as any);
    await expect(service.resolve('user-1', undefined)).resolves.toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('should cache the room per building and user, including "lives nowhere"', async () => {
    const resolver = { resolve: jest.fn().mockResolvedValueOnce(SCOPE).mockResolvedValueOnce(null) };
    const redis = fakeRedis();
    const service = new OccupancySelfScopeService(moduleRefWith(resolver) as any, redis as any);

    await expect(service.resolve('user-1', BUILDING)).resolves.toEqual(SCOPE);
    await expect(service.resolve('user-1', BUILDING)).resolves.toEqual(SCOPE);
    await expect(service.resolve('user-2', BUILDING)).resolves.toBeNull();
    await expect(service.resolve('user-2', BUILDING)).resolves.toBeNull();

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith(`auth:self-scope:${BUILDING}:user-1`, JSON.stringify(SCOPE), 'EX', 300);
    expect(redis.set).toHaveBeenCalledWith(`auth:self-scope:${BUILDING}:user-2`, 'none', 'EX', 300);
  });

  it('should lose access immediately on move-out once the cache entry is evicted', async () => {
    const resolver = { resolve: jest.fn().mockResolvedValueOnce(SCOPE).mockResolvedValueOnce(null) };
    const service = new OccupancySelfScopeService(moduleRefWith(resolver) as any, fakeRedis() as any);
    await service.resolve('user-1', BUILDING);
    await service.evict('user-1', BUILDING);
    await expect(service.resolve('user-1', BUILDING)).resolves.toBeNull();
  });

  it('should keep working (uncached) when Redis reads fail', async () => {
    const resolver = { resolve: jest.fn().mockResolvedValue(SCOPE) };
    const redis = { ...fakeRedis(), get: jest.fn().mockRejectedValue(new Error('down')), set: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new OccupancySelfScopeService(moduleRefWith(resolver) as any, redis as any);
    await expect(service.resolve('user-1', BUILDING)).resolves.toEqual(SCOPE);
  });
});
