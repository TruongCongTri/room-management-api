import { CaslAbilityFactory } from './casl-ability.factory';
import { Action, PermissionEffect, Scope } from './access-control.types';
import { RequestUserContext } from '../context/request-context.model';
import {
  DEFAULT_ROLE_PERMISSIONS,
  formatPermission,
  RentalResource,
  RentalRole,
  resolveRolePermissions,
} from './rental-permissions';

const BUILDING_A = '11111111-1111-4111-8111-111111111111';
const BUILDING_B = '22222222-2222-4222-8222-222222222222';

describe('CaslAbilityFactory with Direct Overrides (Grant/Deny) & ABAC', () => {
  let factory: CaslAbilityFactory;

  beforeEach(() => {
    factory = new CaslAbilityFactory();
  });

  // =========================================================================
  // NHÓM 1: PHẠM VI QUYỀN CƠ BẢN (GLOBAL, OWN, DEPARTMENT = TÒA NHÀ)
  // =========================================================================

  it('should grant GLOBAL permission regardless of attributes', () => {
    const landlord: RequestUserContext = {
      id: 'usr_landlord',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.LANDLORD],
      rules: [
        { resource: 'contracts', action: Action.MANAGE, scope: Scope.GLOBAL, effect: PermissionEffect.GRANT },
      ],
    };

    const ability = factory.createForUser(landlord);
    const anyContract = { __type: 'contracts', userId: 'usr_random', buildingId: BUILDING_B };

    expect(ability.can(Action.READ, 'contracts')).toBe(true);
    expect(ability.can(Action.DELETE, 'contracts')).toBe(true);
    expect(ability.can(Action.READ, anyContract)).toBe(true);
    expect(ability.can(Action.DELETE, anyContract)).toBe(true);
  });

  it('should restrict OWN scoped permissions to the tenant’s own records', () => {
    const tenantUser: RequestUserContext = {
      id: 'usr_tenant',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.TENANT],
      rules: [{ resource: 'invoices', action: Action.READ, scope: Scope.OWN, effect: PermissionEffect.GRANT }],
    };

    const ability = factory.createForUser(tenantUser);

    expect(ability.can(Action.READ, { __type: 'invoices', userId: 'usr_tenant', buildingId: BUILDING_A })).toBe(true);
    expect(ability.can(Action.READ, { __type: 'invoices', userId: 'usr_other', buildingId: BUILDING_A })).toBe(false);
  });

  it('should restrict DEPARTMENT scoped permissions to the assigned building (room.buildingId === user.buildingId)', () => {
    const manager: RequestUserContext = {
      id: 'usr_pm',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.PROPERTY_MANAGER],
      rules: [{ resource: 'rooms', action: Action.READ, scope: Scope.DEPARTMENT, effect: PermissionEffect.GRANT }],
    };

    const ability = factory.createForUser(manager);

    expect(ability.can(Action.READ, { __type: 'rooms', buildingId: BUILDING_A })).toBe(true);
    expect(ability.can(Action.READ, { __type: 'rooms', buildingId: BUILDING_B })).toBe(false);
  });

  // =========================================================================
  // NHÓM 2: CƠ CHẾ GHI ĐÈ TRỰC TIẾP (DIRECT OVERRIDES: GRANT / DENY)
  // =========================================================================

  it('should allow actions from MANAGE but block a specific action with direct DENY override', () => {
    const manager: RequestUserContext = {
      id: 'usr_pm',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.PROPERTY_MANAGER],
      rules: [
        // Quyền kế thừa từ role: toàn quyền hợp đồng trong tòa nhà
        { resource: 'contracts', action: Action.MANAGE, scope: Scope.DEPARTMENT, effect: PermissionEffect.GRANT },
        // Phủ quyết trực tiếp: cấm xóa hợp đồng bất kể role
        { resource: 'contracts', action: Action.DELETE, scope: Scope.DEPARTMENT, effect: PermissionEffect.DENY },
      ],
    };

    const ability = factory.createForUser(manager);
    const contract = { __type: 'contracts', buildingId: BUILDING_A };

    expect(ability.can(Action.READ, contract)).toBe(true);
    expect(ability.can(Action.UPDATE, contract)).toBe(true);
    expect(ability.can(Action.DELETE, contract)).toBe(false);
  });

  it('should enforce Direct DENY even when the user has GLOBAL GRANT', () => {
    const restrictedLandlord: RequestUserContext = {
      id: 'usr_landlord_restricted',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.LANDLORD],
      rules: [
        { resource: 'settlements', action: Action.MANAGE, scope: Scope.GLOBAL, effect: PermissionEffect.GRANT },
        // Cấm tự thực thi quyết toán trả phòng (tách bạch nhiệm vụ với kế toán)
        { resource: 'settlements', action: Action.EXECUTE, scope: Scope.GLOBAL, effect: PermissionEffect.DENY },
      ],
    };

    const ability = factory.createForUser(restrictedLandlord);
    const settlement = { __type: 'settlements', id: 'stl_1' };

    expect(ability.can(Action.READ, settlement)).toBe(true);
    expect(ability.can(Action.EXECUTE, settlement)).toBe(false);
  });

  it('should grant a temporary cross-building permission via Direct GRANT override', () => {
    const accountant: RequestUserContext = {
      id: 'usr_acc',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [RentalRole.ACCOUNTANT],
      rules: [
        { resource: 'invoices', action: Action.READ, scope: Scope.DEPARTMENT, effect: PermissionEffect.GRANT },
        // Đặc quyền tạm thời: xuất tờ khai thuế cho mọi tòa nhà trong kỳ quyết toán năm
        { resource: 'invoices', action: Action.EXPORT, scope: Scope.GLOBAL, effect: PermissionEffect.GRANT },
      ],
    };

    const ability = factory.createForUser(accountant);
    const otherBuildingInvoice = { __type: 'invoices', buildingId: BUILDING_B };

    expect(ability.can(Action.READ, otherBuildingInvoice)).toBe(false);
    expect(ability.can(Action.EXPORT, otherBuildingInvoice)).toBe(true);
  });

  // =========================================================================
  // NHÓM 3: ĐIỀU KIỆN ABAC MỞ RỘNG (CUSTOM CONDITIONS) & TRƯỜNG HỢP BIÊN
  // =========================================================================

  it('should evaluate custom conditions (status-based ABAC constraint)', () => {
    const manager: RequestUserContext = {
      id: 'usr_pm',
      phoneMasked: '090****567',
      roles: [RentalRole.PROPERTY_MANAGER],
      rules: [
        {
          resource: 'contracts',
          action: Action.UPDATE,
          scope: Scope.GLOBAL,
          effect: PermissionEffect.GRANT,
          // Chỉ sửa được hợp đồng còn ở trạng thái DRAFT
          conditions: { status: 'DRAFT' },
        },
      ],
    };

    const ability = factory.createForUser(manager);

    expect(ability.can(Action.UPDATE, { __type: 'contracts', status: 'DRAFT' })).toBe(true);
    expect(ability.can(Action.UPDATE, { __type: 'contracts', status: 'ACTIVE' })).toBe(false);
  });

  it('should deny all actions when user has no permissions (fail-safe default)', () => {
    const guest: RequestUserContext = { id: 'usr_guest', phoneMasked: '090****567', roles: [], rules: [] };

    const ability = factory.createForUser(guest);
    const anyRoom = { __type: 'rooms', userId: 'usr_guest' };

    expect(ability.can(Action.READ, 'rooms')).toBe(false);
    expect(ability.can(Action.READ, anyRoom)).toBe(false);
    expect(ability.can(Action.DELETE, anyRoom)).toBe(false);
  });

  it('should NOT grant DEPARTMENT scope to a user without an assigned building (privilege escalation guard)', () => {
    const unassignedGuard: RequestUserContext = {
      id: 'usr_guard',
      phoneMasked: '090****567',
      roles: [RentalRole.GUARD],
      rules: [{ resource: 'meters', action: Action.CREATE, scope: Scope.DEPARTMENT, effect: PermissionEffect.GRANT }],
    };

    const ability = factory.createForUser(unassignedGuard);
    // Không có buildingId: điều kiện {buildingId: undefined} sẽ khớp mọi bản ghi thiếu buildingId
    expect(ability.can(Action.CREATE, { __type: 'meters' })).toBe(false);
    expect(factory.hasScope(unassignedGuard, 'meters', Action.CREATE, Scope.OWN)).toBe(false);
  });

  it('should not let custom conditions widen the building scope condition', () => {
    const manager: RequestUserContext = {
      id: 'usr_pm',
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles: [],
      rules: [
        {
          resource: 'rooms',
          action: Action.READ,
          scope: Scope.DEPARTMENT,
          effect: PermissionEffect.GRANT,
          conditions: { buildingId: BUILDING_B },
        },
      ],
    };

    const ability = factory.createForUser(manager);
    expect(ability.can(Action.READ, { __type: 'rooms', buildingId: BUILDING_B })).toBe(false);
    expect(ability.can(Action.READ, { __type: 'rooms', buildingId: BUILDING_A })).toBe(true);
  });

  it('should rank scopes GLOBAL > DEPARTMENT > OWN when checking required scope', () => {
    const globalReader: RequestUserContext = {
      id: 'usr_g',
      phoneMasked: '090****567',
      roles: [],
      rules: [{ resource: 'rooms', action: Action.MANAGE, scope: Scope.GLOBAL, effect: PermissionEffect.GRANT }],
    };

    expect(factory.hasScope(globalReader, 'rooms', Action.READ, Scope.DEPARTMENT)).toBe(true);
    expect(factory.hasScope(globalReader, 'payments', Action.READ, Scope.OWN)).toBe(false);
  });

  it('should memoize the ability per user object', () => {
    const user: RequestUserContext = { id: 'u', phoneMasked: '090****567', roles: [], rules: [] };
    expect(factory.createForUser(user)).toBe(factory.createForUser(user));
  });

  // =========================================================================
  // NHÓM 4: MA TRẬN QUYỀN MẶC ĐỊNH 5 VAI TRÒ (TÀI LIỆU 05, MỤC 3)
  // =========================================================================

  describe('Default rental role matrix', () => {
    const userWithRoles = (roles: RentalRole[], userId = 'usr_1'): RequestUserContext => ({
      id: userId,
      phoneMasked: '090****567',
      tenantId: BUILDING_A,
      roles,
      rules: resolveRolePermissions(roles),
    });

    it('should give LANDLORD `*:*:global`', () => {
      expect(DEFAULT_ROLE_PERMISSIONS[RentalRole.LANDLORD].map(formatPermission)).toEqual(['*:*:global']);
      const ability = factory.createForUser(userWithRoles([RentalRole.LANDLORD]));
      expect(ability.can(Action.EXPORT, { __type: RentalResource.TAX, buildingId: BUILDING_B })).toBe(true);
    });

    it('should let a GUARD upload and record meters in the assigned building only, without approving resets', () => {
      const ability = factory.createForUser(userWithRoles([RentalRole.GUARD]));

      expect(ability.can(Action.UPLOAD, { __type: RentalResource.METERS, buildingId: BUILDING_A })).toBe(true);
      expect(ability.can(Action.CREATE, { __type: RentalResource.METERS, buildingId: BUILDING_A })).toBe(true);
      expect(ability.can(Action.CREATE, { __type: RentalResource.METERS, buildingId: BUILDING_B })).toBe(false);
      expect(ability.can(Action.APPROVE, RentalResource.METERS)).toBe(false);
      expect(ability.can(Action.READ, RentalResource.INVOICES)).toBe(false);
    });

    it('should let an ACCOUNTANT export tax and settle deposits but not edit rooms', () => {
      const ability = factory.createForUser(userWithRoles([RentalRole.ACCOUNTANT]));

      expect(ability.can(Action.EXPORT, { __type: RentalResource.TAX, buildingId: BUILDING_A })).toBe(true);
      expect(ability.can(Action.SETTLE, { __type: RentalResource.DEPOSITS, buildingId: BUILDING_A })).toBe(true);
      expect(ability.can(Action.UPDATE, RentalResource.ROOMS)).toBe(false);
    });

    it('should not let a PROPERTY_MANAGER export tax declarations', () => {
      const ability = factory.createForUser(userWithRoles([RentalRole.PROPERTY_MANAGER]));
      expect(ability.can(Action.EXPORT, RentalResource.TAX)).toBe(false);
      expect(ability.can(Action.UPDATE, { __type: RentalResource.ROOMS, buildingId: BUILDING_A })).toBe(true);
    });

    it('should restrict a TENANT to reading their own contracts and invoices', () => {
      const ability = factory.createForUser(userWithRoles([RentalRole.TENANT], 'usr_tenant'));

      expect(ability.can(Action.READ, { __type: RentalResource.INVOICES, userId: 'usr_tenant' })).toBe(true);
      expect(ability.can(Action.READ, { __type: RentalResource.INVOICES, userId: 'usr_other' })).toBe(false);
      expect(ability.can(Action.UPDATE, { __type: RentalResource.CONTRACTS, userId: 'usr_tenant' })).toBe(false);
    });

    it('should merge multiple roles and ignore unknown roles (fail-closed)', () => {
      const rules = resolveRolePermissions([RentalRole.GUARD, 'UNKNOWN_LEGACY_ROLE']);
      expect(rules).toHaveLength(DEFAULT_ROLE_PERMISSIONS[RentalRole.GUARD].length);
    });
  });
});

// npx jest src/core/access-control/casl-ability.factory.spec.ts
