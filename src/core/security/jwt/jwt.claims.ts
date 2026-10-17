/**
 * Hợp đồng claims của access token. Payload được xác thực nghiêm ngặt (zod) trước khi
 * trở thành RequestUserContext: token ký hợp lệ nhưng sai cấu trúc vẫn bị từ chối.
 */
import { z } from 'zod';
import { Action, PermissionEffect, Scope } from '../../access-control/access-control.types';
import { UUID_REGEX } from '../../multitenancy/tenancy.constants';

const permissionRuleSchema = z.object({
  resource: z.string().min(1),
  action: z.enum(Action),
  scope: z.enum(Scope),
  effect: z.enum(PermissionEffect),
  conditions: z.record(z.string(), z.any()).optional(),
});

const uuid = (name: string) => z.string().regex(UUID_REGEX, `${name} must be a UUID`);

export const accessTokenClaimsSchema = z.object({
  sub: z.string().min(1, 'sub (user id) is required'),
  /** Phiên đăng nhập phát hành token (auth_sessions.id) - bị thu hồi thì token mất hiệu lực ngay */
  sid: uuid('sid').optional(),
  /** Số điện thoại đã che - token không bao giờ mang số đầy đủ hay số giấy tờ tùy thân */
  phoneMasked: z.string().max(32).optional(),
  /** Tòa nhà mặc định của user (phạm vi cô lập RLS). `tenantId` là tên cũ, vẫn được chấp nhận */
  buildingId: uuid('buildingId').optional(),
  tenantId: uuid('tenantId').optional(),
  /** Các tòa nhà user được phép chuyển sang qua header X-Building-ID (chủ nhà nhiều tòa) */
  buildingIds: z.array(uuid('buildingIds[]')).max(200).optional(),
  departmentId: z.string().min(1).optional(),
  roles: z.array(z.string()).default([]),
  /** Ma trận quyền nhúng sẵn (tùy chọn). Bỏ trống → phân giải qua PermissionCache/PERMISSION_RULES_LOADER */
  rules: z.array(permissionRuleSchema).optional(),
  /** Phân biệt access / refresh token để refresh token không thể dùng gọi API */
  typ: z.enum(['access', 'refresh']).optional(),
  jti: z.string().optional(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/** Dữ liệu tối thiểu để phát hành access token (module auth, kiểm thử) */
export type AccessTokenInput = Omit<AccessTokenClaims, 'typ' | 'roles'> & { roles?: string[] };
