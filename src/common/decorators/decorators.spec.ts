import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentUser } from './current-user.decorator';
import { CurrentTenant, RequestedTenant } from './current-tenant.decorator';
import { RequestContextService } from '../../core/context/request-context.service';
import { TraceId } from './trace-id.decorator';
import { IdempotencyKey } from './idempotency-key.decorator';
import { Roles, ROLES_KEY } from './roles.decorator';
import { Public, IS_PUBLIC_KEY } from './public.decorator';
import { SYSTEM_HEADERS } from '../constants/headers.constant';
import { RequestUserContext } from '../../core/context/request-context.model';

// Helper để trích xuất factory function của Parameter Decorators trong NestJS
function getParamDecoratorFactory(decorator: Function) {
  class TestClass {
    testMethod(@decorator() _value: any) {}
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, 'testMethod');
  return args[Object.keys(args)[0]].factory;
}

function getParamDecoratorFactoryWithData(decorator: Function, dataParam: any) {
  class TestClass {
    testMethod(@decorator(dataParam) _value: any) {}
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, 'testMethod');
  return args[Object.keys(args)[0]].factory;
}

describe('Common Custom Decorators (Enterprise Suite)', () => {
  const mockUser: RequestUserContext = {
    id: 'usr_enterprise_001',
    phoneMasked: '090****567',
    tenantId: 'tenant_vietnam',
    departmentId: 'dep_ENGINEERING',
    roles: ['ADMIN', 'MANAGER'],
    rules: [],
  };

  const createMockContext = (req: Record<string, any>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    }) as unknown as ExecutionContext;

  describe('@CurrentUser()', () => {
    it('should extract the full user context from request.user', () => {
      const factory = getParamDecoratorFactory(CurrentUser);
      const ctx = createMockContext({ user: mockUser });

      const result = factory(undefined, ctx);
      expect(result).toEqual(mockUser);
    });

    it('should extract a specific field when data argument is provided', () => {
      const factory = getParamDecoratorFactoryWithData(CurrentUser, 'phoneMasked');
      const ctx = createMockContext({ user: mockUser });

      const result = factory('phoneMasked', ctx);
      expect(result).toBe('090****567');
    });

    it('should return undefined if request.user is missing', () => {
      const factory = getParamDecoratorFactory(CurrentUser);
      const ctx = createMockContext({});

      const result = factory(undefined, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe('@CurrentTenant()', () => {
    it('should extract tenantId from authenticated user if present', () => {
      const factory = getParamDecoratorFactory(CurrentTenant);
      const ctx = createMockContext({ user: mockUser, headers: {} });

      const result = factory(undefined, ctx);
      expect(result).toBe('tenant_vietnam');
    });

    it('should NEVER trust a raw x-building-id header from an anonymous client (tenant spoofing)', () => {
      const factory = getParamDecoratorFactory(CurrentTenant);
      const ctx = createMockContext({
        headers: { [SYSTEM_HEADERS.BUILDING_ID]: 'tenant_from_header' },
      });

      const result = factory(undefined, ctx);
      expect(result).toBeUndefined();
    });

    it('should expose the verified tenant override of a privileged user from the request context', async () => {
      const factory = getParamDecoratorFactory(CurrentTenant);
      const result = await new RequestContextService().runWithContext(
        { isBackgroundJob: false, tenantOverride: 'tenant_switched_by_admin', user: mockUser },
        async () => factory(undefined, createMockContext({ user: mockUser, headers: {} })),
      );
      expect(result).toBe('tenant_switched_by_admin');
    });

    it('@RequestedTenant() should return the unverified tenant hint for public flows only', async () => {
      const factory = getParamDecoratorFactory(RequestedTenant);
      const result = await new RequestContextService().runWithContext(
        { isBackgroundJob: false, requestedTenantId: '44444444-4444-4444-8444-444444444444' },
        async () => factory(undefined, createMockContext({ headers: {} })),
      );
      expect(result).toBe('44444444-4444-4444-8444-444444444444');
    });
  });

  describe('@TraceId()', () => {
    it('should extract traceId from correlation-id header', () => {
      const factory = getParamDecoratorFactory(TraceId);
      const ctx = createMockContext({
        headers: { [SYSTEM_HEADERS.CORRELATION_ID]: 'TRACE-CORR-123' },
      });

      const result = factory(undefined, ctx);
      expect(result).toBe('TRACE-CORR-123');
    });

    it('should return default fallback if no trace header is present', () => {
      const factory = getParamDecoratorFactory(TraceId);
      const ctx = createMockContext({ headers: {} });

      const result = factory(undefined, ctx);
      expect(result).toBe('TRACE-UNTRACKED');
    });
  });

  describe('@IdempotencyKey()', () => {
    it('should extract idempotency-key header string', () => {
      const factory = getParamDecoratorFactory(IdempotencyKey);
      const ctx = createMockContext({
        headers: { [SYSTEM_HEADERS.IDEMPOTENCY_KEY]: 'key_unique_888' },
      });

      const result = factory(undefined, ctx);
      expect(result).toBe('key_unique_888');
    });
  });

  describe('@Roles() and @Public() Metadata Decorators', () => {
    it('should set roles array metadata', () => {
      class TargetController {
        @Roles('ADMIN', 'SUPER_ADMIN')
        securedEndpoint() {}
      }

      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        TargetController.prototype.securedEndpoint,
      );
      expect(metadata).toEqual(['ADMIN', 'SUPER_ADMIN']);
    });

    it('should set isPublic boolean metadata to true', () => {
      class TargetController {
        @Public()
        openEndpoint() {}
      }

      const metadata = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        TargetController.prototype.openEndpoint,
      );
      expect(metadata).toBe(true);
    });
  });
});

// npx jest src/common/decorators/decorators.spec.ts