/**
 * Phân giải ma trận quyền đã làm phẳng của user khi access token KHÔNG mang sẵn `rules`
 * (token gọn nhẹ, quyền thay đổi có hiệu lực ngay mà không cần đăng nhập lại).
 *
 * Module nghiệp vụ (users / auth) cung cấp nguồn dữ liệu bằng cách đăng ký provider:
 *   { provide: PERMISSION_RULES_LOADER, useClass: UserRolesPermissionLoader }
 * Kết quả được cache theo user qua PermissionCacheService (Redis, chia sẻ giữa các Pod).
 * Chưa có loader và cache trống → dùng ma trận mặc định theo role trong token (DEFAULT_ROLE_PERMISSIONS).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EffectivePermissionRule } from './access-control.types';
import { PermissionCacheService } from './permission-cache.service';
import { resolveRolePermissions } from './rental-permissions';

export const PERMISSION_RULES_LOADER = Symbol('PERMISSION_RULES_LOADER');

export interface PermissionRulesLoader {
  loadRules(userId: string, tenantId?: string): Promise<EffectivePermissionRule[]>;
}

@Injectable()
export class UserPermissionResolver {
  private readonly logger = new Logger(UserPermissionResolver.name);
  private loader?: PermissionRulesLoader | null;

  constructor(
    private readonly permissionCache: PermissionCacheService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async resolve(userId: string, tenantId?: string, roles: readonly string[] = []): Promise<EffectivePermissionRule[]> {
    const loader = this.getLoader();
    if (!loader) {
      // Chưa có module nghiệp vụ cung cấp loader: đọc cache (do auth module ghi khi đăng nhập),
      // thiếu cache thì suy ra từ role trong token
      return (await this.permissionCache.getUserPermissions(userId)) ?? resolveRolePermissions(roles);
    }
    return this.permissionCache.getOrLoad(userId, () => loader.loadRules(userId, tenantId));
  }

  /** Tìm loader ở bất kỳ module nào (strict: false) để module nghiệp vụ không cần @Global */
  private getLoader(): PermissionRulesLoader | null {
    if (this.loader !== undefined) return this.loader;
    try {
      this.loader = this.moduleRef.get<PermissionRulesLoader>(PERMISSION_RULES_LOADER, {
        strict: false,
      });
    } catch {
      this.loader = null;
      this.logger.debug('No PERMISSION_RULES_LOADER registered; relying on token claims and permission cache.');
    }
    return this.loader;
  }
}
