import { RequestContextService } from './request-context.service';
import { RequestContextData, RequestUserContext } from './request-context.model';
import { Action, Scope, PermissionEffect } from '../access-control/access-control.types';

describe('RequestContextService (Enterprise Scenarios)', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('should isolate and retrieve HTTP context with shortcut getters', () => {
    const mockContext: RequestContextData = {
      traceId: 'TRACE-TEST-999',
      clientIp: '10.0.0.1',
      userAgent: 'Chrome/Mock',
      startTime: Date.now() - 50, // Giả lập đã chạy được 50ms
      user: {
        id: 'usr_enterprise_1',
        email: 'lead@rental.vn',
        tenantId: 'tenant_vietnam',
        departmentId: 'dep_OPERATIONS',
        roles: ['AGENT_LEAD'],
        rules: [
          {
            resource: 'rooms',
            action: Action.EXECUTE,
            scope: Scope.DEPARTMENT,
            effect: PermissionEffect.GRANT,
          },
        ],
      },
      metadata: new Map<string, any>(),
    };

    service.run(mockContext, () => {
      // Kiểm tra các shortcut getters (Zero prop-drilling)
      expect(service.getTraceId()).toBe('TRACE-TEST-999');
      expect(service.getClientIp()).toBe('10.0.0.1');
      expect(service.getUserId()).toBe('usr_enterprise_1');
      expect(service.getUserEmail()).toBe('lead@rental.vn');
      expect(service.getTenantId()).toBe('tenant_vietnam');
      expect(service.getDepartmentId()).toBe('dep_OPERATIONS');
      expect(service.getUserRoles()).toContain('AGENT_LEAD');
      expect(service.getUserRules()).toHaveLength(1);
      expect(service.isBackgroundJob()).toBe(false);
      expect(service.getDurationMs()).toBeGreaterThanOrEqual(40);
    });
  });

  it('should allow dynamically populating user via setUser() after auth guard', () => {
    // Khởi tạo ngữ cảnh chưa có user (giai đoạn middleware)
    const initialContext: RequestContextData = {
      traceId: 'TRACE-AUTH-FLOW',
      clientIp: '192.168.1.1',
      startTime: Date.now(),
      metadata: new Map<string, any>(),
    };

    service.run(initialContext, () => {
      expect(service.getUserId()).toBeUndefined();

      // Giả lập Guard/Interceptor nạp user sau khi giải mã token JWT
      const authenticatedUser: RequestUserContext = {
        id: 'usr_authenticated',
        email: 'user@auth.com',
        roles: ['CUSTOMER'],
        rules: [],
      };

      service.setUser(authenticatedUser);

      // User đã có mặt trong AsyncLocalStorage của request này
      expect(service.getUserId()).toBe('usr_authenticated');
      expect(service.getUserEmail()).toBe('user@auth.com');
    });
  });

  it('should create an isolated system context for background queue workers / crons', async () => {
    await service.runAsSystem('NIGHTLY_SETTLEMENT', async () => {
      expect(service.getTraceId()).toMatch(/^SYS-NIGHTLY_SETTLEMENT-/);
      expect(service.getUserId()).toBe('SYSTEM_INTERNAL_SERVICE');
      expect(service.getUserRoles()).toContain('SYSTEM');
      expect(service.isBackgroundJob()).toBe(true);
      expect(service.getClientIp()).toBe('127.0.0.1');
    }, 'tenant_default');
  });

  it('should only expose a VERIFIED tenant via getTenantId(), never the raw header value', () => {
    service.run(
      {
        traceId: 'TRACE-TENANT',
        clientIp: '10.0.0.2',
        startTime: Date.now(),
        user: { id: 'usr_1', email: 'a@b.c', tenantId: 'tenant_A', roles: [], rules: [] },
        metadata: new Map(),
      },
      () => {
        service.setRequestedTenantId('tenant_B');
        expect(service.getTenantId()).toBe('tenant_A');
        expect(service.getRequestedTenantId()).toBe('tenant_B');

        // Override chỉ được set sau khi interceptor đã kiểm tra quyền SUPER_ADMIN
        service.setTenantOverride('tenant_B');
        expect(service.getTenantId()).toBe('tenant_B');
      },
    );
  });

  it('should propagate an existing traceId to background workers via runWithContext()', () => {
    const result = service.runWithContext({ traceId: 'TRACE-FROM-JOB-PAYLOAD' }, () => {
      expect(service.isBackgroundJob()).toBe(true);
      return service.getTraceId();
    });
    expect(result).toBe('TRACE-FROM-JOB-PAYLOAD');
  });

  it('should keep concurrent contexts isolated across async boundaries', async () => {
    const runFor = (traceId: string, delay: number) =>
      service.runWithContext({ traceId }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return service.getTraceId();
      });

    await expect(Promise.all([runFor('TRACE-A', 20), runFor('TRACE-B', 5)])).resolves.toEqual([
      'TRACE-A',
      'TRACE-B',
    ]);
  });

  it('should treat SUPER_ADMIN and SYSTEM as privileged', async () => {
    await service.runAsSystem('PRIV_CHECK', async () => {
      expect(service.isPrivileged()).toBe(true);
    });
  });

  it('should return safe fallback values outside an active context', () => {
    expect(service.getStore()).toBeUndefined();
    expect(service.getTraceId()).toBe('TRACE-UNTRACKED');
    expect(service.getUserId()).toBeUndefined();
    expect(service.getUserRoles()).toEqual([]);
    expect(service.getUserRules()).toEqual([]);
    expect(service.isBackgroundJob()).toBe(false);
  });
});

// npx jest src/core/context/request-context.service.spec.ts