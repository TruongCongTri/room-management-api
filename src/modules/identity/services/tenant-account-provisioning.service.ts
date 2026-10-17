/**
 * Tài khoản đăng nhập cho khách thuê (tài liệu 03, tenants.user_id): khi một người ở TRƯỞNG THÀNH có số điện thoại
 * chuyển đến, ContractsModule (module 3) gọi provision() trong CÙNG transaction của việc chuyển đến:
 *  - Tìm tài khoản theo số E.164 (một người một tài khoản, kể cả khi họ cũng là nhân viên) hoặc tạo mới
 *    ở trạng thái PENDING_ACTIVATION - khách thuê tự kích hoạt bằng OTP.
 *  - Bảo đảm vai trò TENANT và quyền truy cập tòa nhà (idempotent: gọi lại không tạo trùng).
 *  - Không bao giờ mở lại tài khoản đã bị chủ nhà vô hiệu hóa.
 * Phạm vi phòng được suy ra từ việc ở thực tế (OCCUPANCY_SELF_SCOPE), không lưu trên tài khoản.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PermissionCacheService } from '../../../core/access-control/permission-cache.service';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { AuditWriterService } from '../../../infrastructure/audit/services/audit-writer.service';
import { AuditAction } from '../../../infrastructure/audit/interfaces/audit.interface';
import { User, UserStatus } from '../entities/user.entity';
import { maskPhoneNumber, normalizePhoneNumber } from '../domain/phone-number';

export interface ProvisionTenantAccountInput {
  phone: string;
  fullName: string;
  buildingId: string;
}

export interface ProvisionedTenantAccount {
  userId: string;
  created: boolean;
  status: UserStatus;
}

@Injectable()
export class TenantAccountProvisioningService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissionCache: PermissionCacheService,
    private readonly audit: AuditWriterService,
  ) {}

  async provision(input: ProvisionTenantAccountInput, manager?: EntityManager): Promise<ProvisionedTenantAccount> {
    const run = (m: EntityManager) => this.provisionWith(m, input);
    const result = manager ? await run(manager) : await this.dataSource.transaction(run);
    if (result.roleAdded) await this.permissionCache.invalidateUserPermissions(result.userId);
    return { userId: result.userId, created: result.created, status: result.status };
  }

  private async provisionWith(manager: EntityManager, input: ProvisionTenantAccountInput) {
    const phoneE164 = normalizePhoneNumber(input.phone);
    // ON CONFLICT trên unique index một phần (số điện thoại của tài khoản còn sống): an toàn khi hai lần chuyển đến song song
    const inserted: Array<{ id: string }> = await manager.query(
      `INSERT INTO users (phone_e164, full_name, status) VALUES ($1, $2, $3)
       ON CONFLICT (phone_e164) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [phoneE164, input.fullName.trim(), UserStatus.PENDING_ACTIVATION],
    );
    const user = await manager.getRepository(User).findOneOrFail({ where: { phoneE164 } });

    const role: Array<{ user_id: string }> = await manager.query(
      `INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id`,
      [user.id, RentalRole.TENANT],
    );
    await manager.query(
      `INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, input.buildingId],
    );
    if (inserted.length === 1 || role.length === 1) {
      // INSERT thô không qua AuditEntitySubscriber → ghi audit tường minh, cùng transaction
      await this.audit.recordInTransaction(manager, {
        resource: 'users',
        resourceId: user.id,
        action: inserted.length === 1 ? AuditAction.CREATE : AuditAction.UPDATE,
        explicitBuildingId: input.buildingId,
        metadata: { event: 'TENANT_ACCOUNT_PROVISIONED', phoneMasked: maskPhoneNumber(phoneE164), roleAdded: role.length === 1 },
      });
    }
    return { userId: user.id, created: inserted.length === 1, status: user.status, roleAdded: role.length === 1 };
  }
}
