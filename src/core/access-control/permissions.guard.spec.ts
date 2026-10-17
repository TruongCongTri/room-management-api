import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { CaslAbilityFactory } from './casl-ability.factory';
import { RequestContextService } from '../context/request-context.service';
import { Action, PermissionEffect, Scope } from './access-control.types';
import { PERMISSIONS_KEY, RequiredPermission } from './permission.decorator';
import { RequestUserContext } from '../context/request-context.model';

const BUILDING_A = '11111111-1111-4111-8111-111111111111';
const BUILDING_B = '22222222-2222-4222-8222-222222222222';

describe('PermissionsGuard (ABAC & RBAC Test)', () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;
  let abilityFactory: CaslAbilityFactory;
  let contextService: RequestContextService;

  beforeEach(() => {
    reflector = new Reflector();
    abilityFactory = new CaslAbilityFactory();
    contextService = new RequestContextService();
    guard = new PermissionsGuard(reflector, abilityFactory, contextService);
  });

  const createMockContext = (requestData: any): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue(requestData),
      }),
    }) as unknown as ExecutionContext;

  it('should allow access if no permissions are required on route', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = createMockContext({});

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should throw UnauthorizedException if user context is missing', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([
        { resource: 'contracts', action: Action.READ, scope: Scope.GLOBAL },
      ]);
    jest.spyOn(contextService, 'getCurrentUser').mockReturnValue(undefined);

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should block access when user lacks required permission', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([
        { resource: 'contracts', action: Action.DELETE, scope: Scope.GLOBAL },
      ]);
    jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
      id: 'usr_1',
      email: 'agent@rental.vn',
      roles: ['AGENT'],
      rules: [
        {
          resource: 'contracts',
          action: Action.READ,
          scope: Scope.GLOBAL,
          effect: PermissionEffect.GRANT,
        },
      ],
    });

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should evaluate ABAC and allow access when building matches', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === PERMISSIONS_KEY) {
        return [
          {
            resource: 'contracts',
            action: Action.READ,
            scope: Scope.DEPARTMENT,
          },
        ];
      }
      return undefined;
    });

    // Quản lý được phân công tòa nhà A
    jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
      id: 'usr_lead',
      email: 'lead@rental.vn',
      tenantId: BUILDING_A,
      roles: ['PROPERTY_MANAGER'],
      rules: [
        {
          resource: 'contracts',
          action: Action.READ,
          scope: Scope.DEPARTMENT,
          effect: PermissionEffect.GRANT,
        },
      ],
    });

    // Request truy vấn tài nguyên của tòa nhà A
    const context = createMockContext({
      params: { buildingId: BUILDING_A },
    });

    const isAllowed = await guard.canActivate(context);
    expect(isAllowed).toBe(true);
  });

  it('should evaluate ABAC and reject access when building mismatches', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === PERMISSIONS_KEY) {
        return [
          {
            resource: 'contracts',
            action: Action.READ,
            scope: Scope.DEPARTMENT,
          },
        ];
      }
      return undefined;
    });

    jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
      id: 'usr_lead',
      email: 'lead@rental.vn',
      tenantId: BUILDING_A,
      roles: ['PROPERTY_MANAGER'],
      rules: [
        {
          resource: 'contracts',
          action: Action.READ,
          scope: Scope.DEPARTMENT,
          effect: PermissionEffect.GRANT,
        },
      ],
    });

    // Request truy vấn tài nguyên của tòa nhà B
    const context = createMockContext({
      params: { buildingId: BUILDING_B },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('Enterprise hardening', () => {
    const salesLead: RequestUserContext = {
      id: 'usr_lead',
      email: 'lead@rental.vn',
      tenantId: BUILDING_A,
      roles: ['PROPERTY_MANAGER'],
      rules: [
        {
          resource: 'contracts',
          action: Action.UPDATE,
          scope: Scope.DEPARTMENT,
          effect: PermissionEffect.GRANT,
        },
      ],
    };

    const requirePermissions = (...perms: RequiredPermission[]) =>
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => (key === PERMISSIONS_KEY ? perms : undefined));

    it('should read the user from request.user (set by JwtAuthGuard) because guards run before interceptors', async () => {
      requirePermissions({ resource: 'contracts', action: Action.UPDATE });
      const context = createMockContext({ user: salesLead });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should reject when user scope is narrower than the required scope', async () => {
      requirePermissions({ resource: 'contracts', action: Action.UPDATE, scope: Scope.GLOBAL });
      const context = createMockContext({ user: salesLead });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should NOT trust ownership attributes from the body for UPDATE (spoofing)', async () => {
      // Bản ghi thật thuộc tòa nhà B, client khai man buildingId = A trong body
      requirePermissions({
        resource: 'contracts',
        action: Action.UPDATE,
        scope: Scope.DEPARTMENT,
        subjectResolver: () => ({ id: 'bk_1', buildingId: BUILDING_B }),
      });
      const context = createMockContext({
        user: salesLead,
        params: { id: 'bk_1' },
        body: { buildingId: BUILDING_A },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should expose the resolved entity on request.targetResource for controller reuse', async () => {
      const entity = { id: 'bk_2', buildingId: BUILDING_A };
      requirePermissions({
        resource: 'contracts',
        action: Action.UPDATE,
        subjectResolver: async () => entity,
      });
      const request: any = { user: salesLead, params: { id: 'bk_2' } };

      await expect(guard.canActivate(createMockContext(request))).resolves.toBe(true);
      expect(request.targetResource).toBe(entity);
    });
  });
});

// npx jest src/core/access-control/permissions.guard.spec.ts
