/**
 * Phần không cần DB của website giới thiệu: Cache-Control / ETag / 304, DTO tìm phòng, slug, công tắc ngắt mặc định BẬT,
 * phạm vi tòa nhà cho request ẩn danh, giới hạn tốc độ theo route. Truy vấn & RLS: test/properties.e2e-spec.ts.
 */
import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { lastValueFrom, of } from 'rxjs';
import {
  etagMatches,
  PUBLIC_CACHE_CONTROL_KEY,
  PublicCacheControlInterceptor,
  weakEtagOf,
} from '../../infrastructure/cache/interceptors/public-cache-control.interceptor';
import { PublicRoomQueryDto } from './dto/public-listing.dto';
import { PUBLIC_SLUG, UpdateBuildingDto } from './dto/properties.dto';
import { runInBuildingScope } from './building-scope';
import { PublicListingService } from './services/public-listing.service';
import { PublicListingController } from './controllers/public-listing.controller';
import { FeatureFlagService } from '../../core/feature-flag/feature-flag.service';
import { FEATURE_FLAG_METADATA } from '../../core/feature-flag/feature-flag.guard';
import { RequestContextService } from '../../core/context/request-context.service';
import { THROTTLE_TIER_METADATA, THROTTLE_TIERS } from '../../core/security/throttler/throttler.constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

describe('PublicCacheControlInterceptor', () => {
  const run = async (opts: { method?: string; ifNoneMatch?: string; maxAge?: number | undefined; data?: unknown }) => {
    const headers: Record<string, string> = {};
    const response = { setHeader: (k: string, v: string) => (headers[k] = v), status: jest.fn() };
    const ctx = {
      getType: () => 'http',
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ method: opts.method ?? 'GET', headers: { 'if-none-match': opts.ifNoneMatch } }), getResponse: () => response }),
    } as unknown as ExecutionContext;
    const reflector = { getAllAndOverride: () => ('maxAge' in opts ? opts.maxAge : 60) } as unknown as Reflector;
    const next: CallHandler = { handle: () => of(opts.data ?? { items: [1, 2] }) };
    const body = await lastValueFrom(new PublicCacheControlInterceptor(reflector).intercept(ctx, next));
    return { body, headers, status: response.status };
  };

  it('should mark anonymous GET responses cacheable for browsers / CDNs with a weak ETag over the data', async () => {
    const { body, headers, status } = await run({});
    expect(body).toEqual({ items: [1, 2] });
    expect(headers).toEqual({
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ETag: weakEtagOf({ items: [1, 2] }),
      Vary: 'Accept-Language',
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('should answer 304 without a body when the client already has this version', async () => {
    const etag = weakEtagOf({ items: [1, 2] });
    for (const ifNoneMatch of [etag, etag.replace('W/', ''), `"other", ${etag}`, '*']) {
      const { body, status } = await run({ ifNoneMatch });
      expect(body).toBeUndefined();
      expect(status).toHaveBeenCalledWith(304);
    }
  });

  it('should send the full body when the data changed since the client cached it', async () => {
    const { body, status } = await run({ ifNoneMatch: weakEtagOf({ items: [1] }) });
    expect(body).toEqual({ items: [1, 2] });
    expect(status).not.toHaveBeenCalled();
  });

  it('should leave non-GET requests and undecorated routes alone', async () => {
    expect((await run({ method: 'POST' })).headers).toEqual({});
    expect((await run({ maxAge: undefined })).headers).toEqual({});
  });

  it('should give equal data the same ETag and different data a different one', () => {
    expect(weakEtagOf({ a: 1 })).toBe(weakEtagOf({ a: 1 }));
    expect(weakEtagOf({ a: 1 })).not.toBe(weakEtagOf({ a: 2 }));
    expect(etagMatches(undefined, weakEtagOf(1))).toBe(false);
  });
});

describe('Public listing - inputs', () => {
  const check = async (plain: Record<string, unknown>) => {
    const dto = plainToInstance(PublicRoomQueryDto, plain);
    return { dto, fields: (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property) };
  };

  it('should parse and normalise the room search', async () => {
    const { dto, fields } = await check({ roomType: ' studio ', availability: 'available', floor: '3', minPrice: '5000000', occupants: '2', sortBy: 'monthlyRent', sortOrder: 'desc' });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ roomType: 'STUDIO', availability: 'AVAILABLE', floor: 3, minPrice: 5000000, occupants: 2, sortOrder: 'DESC', page: 1, limit: 20 });
  });

  it.each([
    [{ limit: '51' }, 'limit'],
    [{ availability: 'RESERVED' }, 'availability'],
    [{ sortBy: 'tenant' }, 'sortBy'],
    [{ minPrice: '-1' }, 'minPrice'],
    [{ occupants: '0' }, 'occupants'],
    [{ roomType: "x'; DROP" }, 'roomType'],
    [{ floor: '31' }, 'floor'],
  ])('should reject %p', async (plain, field) => {
    expect((await check(plain)).fields).toEqual([field]);
  });

  it('should accept only well-formed public slugs (matches the database CHECK)', () => {
    for (const ok of ['sunrise-quan-7', 'abc', 'a1-b2-c3']) expect(PUBLIC_SLUG.test(ok)).toBe(true);
    for (const bad of ['ab', 'Sunrise', 'sun--rise', '-sun', 'sun-', 'sun rise', 'x'.repeat(81), 'tòa-nhà']) expect(PUBLIC_SLUG.test(bad)).toBe(false);
  });

  it('should lower-case the slug sent by the landlord and allow removing it', async () => {
    const dto = plainToInstance(UpdateBuildingDto, { publicSlug: ' Sunrise-Quan-7 ' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.publicSlug).toBe('sunrise-quan-7');
    expect(await validate(plainToInstance(UpdateBuildingDto, { publicSlug: null, isPubliclyListed: false }))).toEqual([]);
    expect((await validate(plainToInstance(UpdateBuildingDto, { publicSlug: 'bad slug' }))).map((e) => e.property)).toEqual(['publicSlug']);
  });

  it('should treat malformed slugs as "not found" without touching the database', async () => {
    const find = jest.fn();
    const service = new PublicListingService({ getRepository: () => ({ findOne: find }) } as any, {} as any, {} as any, {} as any);
    await expect(service.getRoomTypes('../../etc')).rejects.toBeInstanceOf(NotFoundException);
    expect(find).not.toHaveBeenCalled();
  });

  it('should refuse minPrice above maxPrice', async () => {
    const service = new PublicListingService({} as any, {} as any, {} as any, {} as any);
    const err = await service.searchRooms('sunrise', Object.assign(new PublicRoomQueryDto(), { minPrice: 9, maxPrice: 1 })).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ errorCode: 'REQ_VALIDATION_ERROR', details: [{ field: 'minPrice' }] });
  });
});

describe('Public listing - kill switch, scope and route protection', () => {
  it('should be ON by default and switchable OFF from configuration', () => {
    const ctx = new RequestContextService();
    expect(new FeatureFlagService(ctx).isEnabled('public_listing')).toBe(true);
    const off = { featureFlags: { defaults: { public_listing: { enabled: false } }, cacheTtlMs: 0 } } as any;
    expect(new FeatureFlagService(ctx, off).isEnabled('public_listing')).toBe(false);
    // Cờ khác không có giá trị mặc định → vẫn TẮT khi chưa cấu hình
    expect(new FeatureFlagService(ctx).isEnabled('evn_tiered_quota')).toBe(false);
  });

  it('should scope an anonymous request to the published building without making it a background job', () => {
    const ctx = new RequestContextService();
    const outer = { traceId: 'T-1', clientIp: '1.2.3.4', startTime: 1, metadata: new Map(), isBackgroundJob: false } as any;
    const seen = ctx.run(outer, () =>
      runInBuildingScope(ctx, 'b-1', () => ({ tenant: ctx.getTenantId(), trace: ctx.getTraceId(), ip: ctx.getClientIp(), bg: ctx.isBackgroundJob() })),
    );
    expect(seen).toEqual({ tenant: 'b-1', trace: 'T-1', ip: '1.2.3.4', bg: false });
    expect(ctx.run(outer, () => ctx.getTenantId())).toBeUndefined(); // không rò rỉ ra ngoài
  });

  it('should keep every public route anonymous, rate limited per IP and behind the kill switch', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PublicListingController)).toBe(true);
    expect(Reflect.getMetadata(THROTTLE_TIER_METADATA, PublicListingController)).toBe(THROTTLE_TIERS.PUBLIC);
    expect(Reflect.getMetadata(THROTTLE_TIER_METADATA, PublicListingController.prototype.rooms)).toBe(THROTTLE_TIERS.SEARCH);
    expect(Reflect.getMetadata(FEATURE_FLAG_METADATA, PublicListingController)).toBe('public_listing');
    expect(Reflect.getMetadata(PUBLIC_CACHE_CONTROL_KEY, PublicListingController)).toBe(60);
  });
});
