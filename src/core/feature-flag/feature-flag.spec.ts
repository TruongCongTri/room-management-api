import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureFlagGuard } from './feature-flag.guard';
import { RequestContextService } from '../context/request-context.service';

describe('FeatureFlagModule (Canary Rollout Suite)', () => {
  let flagService: FeatureFlagService;
  let contextService: RequestContextService;

  const config: any = {
    featureFlags: {
      cacheTtlMs: 0,
      defaults: {
        new_vnpay_qr_gateway: { enabled: true, percentage: 20 },
        evn_tiered_quota: { enabled: false },
        b2b_portal: { enabled: true, allowedTenantIds: ['tenant_a'] },
      },
    },
  };

  beforeEach(() => {
    contextService = new RequestContextService();
    flagService = new FeatureFlagService(contextService, config, null);
  });

  it('should return false for disabled or unknown flags', () => {
    expect(flagService.isEnabled('evn_tiered_quota')).toBe(false);
    expect(flagService.isEnabled('does_not_exist')).toBe(false);
  });

  it('should consistently bucket users for canary rollout percentages', () => {
    jest.spyOn(contextService, 'getUserId').mockReturnValue('usr_fixed_hash_1');
    const result1 = flagService.isEnabled('new_vnpay_qr_gateway');
    const result2 = flagService.isEnabled('new_vnpay_qr_gateway');

    // Kết quả hash bucket phải mang tính xác định (Deterministic)
    expect(result1).toBe(result2);
  });

  it('should roughly honour the rollout percentage across many users', () => {
    const spy = jest.spyOn(contextService, 'getUserId');
    let enabled = 0;
    for (let i = 0; i < 2000; i++) {
      spy.mockReturnValue(`usr_${i}`);
      if (flagService.isEnabled('new_vnpay_qr_gateway')) enabled++;
    }
    expect(enabled / 2000).toBeGreaterThan(0.15);
    expect(enabled / 2000).toBeLessThan(0.25);
  });

  it('should restrict flags to allowlisted tenants', () => {
    const tenantSpy = jest.spyOn(contextService, 'getTenantId');
    tenantSpy.mockReturnValue('tenant_a');
    expect(flagService.isEnabled('b2b_portal')).toBe(true);
    tenantSpy.mockReturnValue('tenant_b');
    expect(flagService.isEnabled('b2b_portal')).toBe(false);
  });

  it('should apply runtime overrides and persist them to Redis for other pods', async () => {
    const redis: any = { hset: jest.fn().mockResolvedValue(1), hdel: jest.fn().mockResolvedValue(1) };
    const shared = new FeatureFlagService(contextService, config, redis);

    await shared.setFlag('evn_tiered_quota', { enabled: true });
    expect(shared.isEnabled('evn_tiered_quota')).toBe(true);
    expect(redis.hset).toHaveBeenCalledWith('feature_flags', 'evn_tiered_quota', '{"enabled":true}');

    await shared.clearOverride('evn_tiered_quota');
    expect(shared.isEnabled('evn_tiered_quota')).toBe(false);
  });

  it('FeatureFlagGuard should hide routes of disabled features with 404', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('evn_tiered_quota');
    const guard = new FeatureFlagGuard(reflector, flagService);
    const context = { getHandler: jest.fn(), getClass: jest.fn() } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });
});

// npx jest src/core/feature-flag/feature-flag.spec.ts
