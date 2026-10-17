/**
 * Vai trò & ma trận quyền mặc định của nền tảng cho thuê 80 phòng (tài liệu 05, mục 3).
 * Module identity seed các role này vào DB; PERMISSION_RULES_LOADER có thể dùng
 * resolveRolePermissions() làm quyền nền rồi áp thêm GRANT/DENY trực tiếp của từng user.
 */
import { Action, EffectivePermissionRule, PermissionEffect, Scope } from './access-control.types';

export enum RentalRole {
  LANDLORD = 'LANDLORD',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  ACCOUNTANT = 'ACCOUNTANT',
  GUARD = 'GUARD',
  TENANT = 'TENANT',
}

export enum RentalResource {
  BUILDINGS = 'buildings',
  ROOMS = 'rooms',
  ASSETS = 'assets',
  TENANTS = 'tenants',
  CONTRACTS = 'contracts',
  DEPOSITS = 'deposits',
  METERS = 'meters',
  INVOICES = 'invoices',
  PAYMENTS = 'payments',
  SETTLEMENTS = 'settlements',
  TAX = 'tax',
  COMPLIANCE = 'compliance',
  AUDIT = 'audit',
}

/** Wildcard resource: quyền áp dụng cho mọi tài nguyên */
export const ALL_RESOURCES = 'all';

const grant = (resource: string, action: Action, scope: Scope): EffectivePermissionRule => ({
  resource,
  action,
  scope,
  effect: PermissionEffect.GRANT,
});

const R = RentalResource;
const { OWN, DEPARTMENT, GLOBAL } = Scope;

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<RentalRole, readonly EffectivePermissionRule[]>> = {
  // `*:*:global` - toàn quyền trên các tòa nhà của chủ nhà, thiết lập thuế & tài chính
  [RentalRole.LANDLORD]: [grant(ALL_RESOURCES, Action.MANAGE, GLOBAL)],

  [RentalRole.PROPERTY_MANAGER]: [
    grant(R.ROOMS, Action.MANAGE, DEPARTMENT),
    grant(R.ASSETS, Action.MANAGE, DEPARTMENT),
    grant(R.TENANTS, Action.MANAGE, DEPARTMENT),
    grant(R.CONTRACTS, Action.MANAGE, DEPARTMENT),
    grant(R.DEPOSITS, Action.READ, DEPARTMENT),
    grant(R.METERS, Action.MANAGE, DEPARTMENT),
    grant(R.INVOICES, Action.READ, DEPARTMENT),
    grant(R.SETTLEMENTS, Action.EXECUTE, DEPARTMENT),
    grant(R.SETTLEMENTS, Action.READ, DEPARTMENT),
    grant(R.COMPLIANCE, Action.MANAGE, DEPARTMENT),
    grant(R.AUDIT, Action.READ, DEPARTMENT),
  ],

  [RentalRole.ACCOUNTANT]: [
    grant(R.ROOMS, Action.READ, DEPARTMENT),
    grant(R.ASSETS, Action.READ, DEPARTMENT),
    grant(R.TENANTS, Action.READ, DEPARTMENT),
    grant(R.CONTRACTS, Action.READ, DEPARTMENT),
    grant(R.METERS, Action.READ, DEPARTMENT),
    grant(R.METERS, Action.APPROVE, DEPARTMENT),
    grant(R.INVOICES, Action.MANAGE, DEPARTMENT),
    grant(R.PAYMENTS, Action.MANAGE, DEPARTMENT),
    grant(R.DEPOSITS, Action.SETTLE, DEPARTMENT),
    grant(R.DEPOSITS, Action.READ, DEPARTMENT),
    grant(R.SETTLEMENTS, Action.EXECUTE, DEPARTMENT),
    grant(R.SETTLEMENTS, Action.READ, DEPARTMENT),
    grant(R.TAX, Action.EXPORT, DEPARTMENT),
    grant(R.COMPLIANCE, Action.READ, DEPARTMENT),
    grant(R.AUDIT, Action.READ, DEPARTMENT),
  ],

  // Chỉ chụp ảnh & nhập chỉ số đồng hồ; cờ reset đồng hồ phải được quản lý/kế toán duyệt
  [RentalRole.GUARD]: [
    grant(R.ROOMS, Action.READ, DEPARTMENT),
    grant(R.METERS, Action.UPLOAD, DEPARTMENT),
    grant(R.METERS, Action.CREATE, DEPARTMENT),
    grant(R.METERS, Action.READ, DEPARTMENT),
    grant(R.AUDIT, Action.READ, OWN),
  ],

  // Tự phục vụ: chỉ đọc dữ liệu của chính mình
  [RentalRole.TENANT]: [
    grant(R.TENANTS, Action.READ, OWN),
    // Thiết bị đã bàn giao trong phòng của mình (biên bản bàn giao)
    grant(R.ASSETS, Action.READ, OWN),
    grant(R.CONTRACTS, Action.READ, OWN),
    grant(R.INVOICES, Action.READ, OWN),
    grant(R.PAYMENTS, Action.READ, OWN),
    grant(R.METERS, Action.READ, OWN),
    grant(R.SETTLEMENTS, Action.READ, OWN),
    grant(R.COMPLIANCE, Action.READ, OWN),
    grant(R.AUDIT, Action.READ, OWN),
  ],
};

/** Hợp nhất quyền nền của nhiều role (role lạ bị bỏ qua - fail-closed) */
export function resolveRolePermissions(roles: readonly string[]): EffectivePermissionRule[] {
  return roles.flatMap((role) => DEFAULT_ROLE_PERMISSIONS[role as RentalRole] ?? []).map((rule) => ({ ...rule }));
}

/** Định dạng chuỗi `<resource>:<action>:<scope>` phục vụ log, seed và thông báo lỗi */
export function formatPermission(rule: Pick<EffectivePermissionRule, 'resource' | 'action' | 'scope'>): string {
  const resource = rule.resource === ALL_RESOURCES ? '*' : rule.resource;
  const action = rule.action === Action.MANAGE && rule.resource === ALL_RESOURCES ? '*' : rule.action;
  return `${resource}:${action}:${rule.scope}`;
}
