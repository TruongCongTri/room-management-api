/**
 * PERMISSION_RULES_LOADER (tài liệu 01, 3.1): quyền hiệu lực của user = role_permissions của các vai trò
 * trong user_roles (đã seed đồng bộ với DEFAULT_ROLE_PERMISSIONS). Kết quả được UserPermissionResolver cache
 * ở `permissions:user:{id}` và bị xóa khi vai trò thay đổi → gỡ vai trò có hiệu lực ngay, không chờ token hết hạn.
 * Tài khoản không ACTIVE / đã xóa / không tồn tại → không có quyền nào (fail-closed).
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PermissionRulesLoader } from '../../../core/access-control/user-permission.resolver';
import { Action, EffectivePermissionRule, PermissionEffect, Scope } from '../../../core/access-control/access-control.types';
import { UUID_REGEX } from '../../../core/multitenancy/tenancy.constants';
import { UserStatus } from '../entities/user.entity';

@Injectable()
export class UserRolesPermissionLoader implements PermissionRulesLoader {
  constructor(private readonly dataSource: DataSource) {}

  async loadRules(userId: string): Promise<EffectivePermissionRule[]> {
    if (!UUID_REGEX.test(userId)) return [];
    const rows: Array<{ resource: string; action: string; scope: string; effect: string }> = await this.dataSource.query(
      `SELECT DISTINCT rp.resource, rp.action, rp.scope, rp.effect
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id AND u.status = $2 AND u.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_code = ur.role_code
        WHERE ur.user_id = $1`,
      [userId, UserStatus.ACTIVE],
    );
    return rows.map((row) => ({
      resource: row.resource,
      action: row.action as Action,
      scope: row.scope as Scope,
      effect: row.effect as PermissionEffect,
    }));
  }
}
