/**
 * Quản lý tài khoản nhân viên bởi chủ nhà (POST/GET /users, PATCH /users/{id} - tài liệu 04):
 *  - Chủ nhà chỉ cấp được quyền truy cập vào tòa nhà CỦA MÌNH (đọc từ user_building_access, không tin token).
 *  - Một số điện thoại một tài khoản; tài khoản mới ở trạng thái PENDING_ACTIVATION + SMS mời kích hoạt.
 *  - Đổi vai trò / tòa nhà / trạng thái: xóa cache quyền `permissions:user:{id}`; giảm quyền hoặc vô hiệu hóa
 *    → thu hồi mọi phiên của tài khoản đó (access token mất hiệu lực ngay).
 *  - Không tự vô hiệu hóa / tự gỡ vai trò chủ nhà; không để tòa nhà nào mất chủ nhà cuối cùng.
 *  - Tài khoản khách thuê (TENANT): vai trò & tòa nhà do việc ở thực tế quyết định → chỉ đổi được trạng thái.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PermissionCacheService } from '../../../core/access-control/permission-cache.service';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { NotificationDispatcherService } from '../../../infrastructure/notification/services/notification-dispatcher.service';
import { NotificationChannel } from '../../../infrastructure/notification/interfaces/notification.interface';
import { NOTIFICATION_TEMPLATES } from '../../../infrastructure/notification/templates/template-renderer.service';
import { User, UserStatus } from '../entities/user.entity';
import { UserRole } from '../entities/user-role.entity';
import { UserBuildingAccess } from '../entities/user-building-access.entity';
import { SessionRevokedReason } from '../entities/auth-session.entity';
import { InvalidPhoneNumberError, maskPhoneNumber, normalizePhoneNumber } from '../domain/phone-number';
import { StaffRole } from '../identity.constants';
import { SessionService } from './session.service';

export interface CreateStaffInput {
  phone: string;
  fullName: string;
  roles: StaffRole[];
  buildingIds: string[];
}

export interface UpdateStaffInput {
  fullName?: string;
  roles?: StaffRole[];
  buildingIds?: string[];
  status?: UserStatus.ACTIVE | UserStatus.DISABLED;
  version?: number;
}

export interface ListUsersQuery {
  role?: string;
  status?: UserStatus;
  buildingId?: string;
  page: number;
  limit: number;
}

export interface UserView {
  id: string;
  fullName: string;
  phoneMasked: string;
  status: UserStatus;
  roles: string[];
  buildingIds: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
  version: number;
}

const ROLE_LABELS: Record<string, string> = {
  LANDLORD: 'chủ nhà',
  PROPERTY_MANAGER: 'quản lý tòa nhà',
  ACCOUNTANT: 'kế toán',
  GUARD: 'bảo vệ',
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly permissionCache: PermissionCacheService,
    private readonly sessions: SessionService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  async create(actor: RequestUserContext, input: CreateStaffInput): Promise<UserView> {
    const phoneE164 = this.normalizePhone(input.phone);
    const buildingIds = this.unique(input.buildingIds);
    await this.assertWithinActorBuildings(actor, buildingIds);

    const user = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.getRepository(User).findOne({ where: { phoneE164 } });
      if (existing) throw this.phoneTaken();

      const created = await manager.getRepository(User).save(
        manager.getRepository(User).create({
          phoneE164,
          fullName: input.fullName.trim(),
          status: UserStatus.PENDING_ACTIVATION,
        }),
      );
      await manager.getRepository(UserRole).insert(this.unique(input.roles).map((roleCode) => ({ userId: created.id, roleCode, grantedBy: actor.id })));
      await manager
        .getRepository(UserBuildingAccess)
        .insert(buildingIds.map((buildingId) => ({ userId: created.id, buildingId, grantedBy: actor.id })));
      return created;
    }).catch((err) => {
      // Hai chủ nhà tạo cùng số điện thoại đồng thời → chỉ unique index chặn được
      if (err?.code === '23505') throw this.phoneTaken();
      throw err;
    });

    this.sendInvitation(user, input.roles);
    return this.view(user.id, await this.actorBuildingIds(actor));
  }

  async list(actor: RequestUserContext, query: ListUsersQuery) {
    const scope = await this.actorBuildingIds(actor);
    if (query.buildingId && !scope.includes(query.buildingId)) throw this.foreignBuilding([query.buildingId]);
    const buildings = query.buildingId ? [query.buildingId] : scope;
    if (buildings.length === 0) return { items: [], total: 0, page: query.page, limit: query.limit };

    const qb = this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .where('EXISTS (SELECT 1 FROM user_building_access a WHERE a.user_id = u.id AND a.building_id IN (:...buildings))', { buildings })
      .orderBy('u.created_at', 'DESC')
      .addOrderBy('u.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    if (query.status) qb.andWhere('u.status = :status', { status: query.status });
    if (query.role) qb.andWhere('EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role_code = :role)', { role: query.role });

    const [users, total] = await qb.getManyAndCount();
    const items = await this.views(users, scope);
    return { items, total, page: query.page, limit: query.limit };
  }

  /** Chi tiết một tài khoản (nhân viên hoặc khách thuê) có chung ít nhất một tòa nhà với chủ nhà; ngoài phạm vi → 404 */
  async getById(actor: RequestUserContext, userId: string): Promise<UserView> {
    const scope = await this.actorBuildingIds(actor);
    const shared = await this.dataSource
      .getRepository(UserBuildingAccess)
      .exists({ where: { userId, buildingId: In(scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) } });
    if (!shared) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'User not found.' });
    return this.view(userId, scope);
  }

  async update(actor: RequestUserContext, userId: string, input: UpdateStaffInput): Promise<UserView> {
    const scope = await this.actorBuildingIds(actor);
    if (input.buildingIds) await this.assertWithinActorBuildings(actor, input.buildingIds);

    const effects = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      const current = user ? await this.accessOf(manager, userId) : undefined;
      // Tài khoản không chung tòa nhà nào với chủ nhà = không tồn tại với chủ nhà này
      if (!user || !current || !current.buildingIds.some((id) => scope.includes(id))) {
        throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'User not found.' });
      }
      if (input.version !== undefined && input.version !== user.version) {
        throw new ConflictException({
          errorCode: SystemErrorCode.RES_CONCURRENCY_CONFLICT,
          message: 'The account was changed by someone else. Reload and try again.',
        });
      }
      if (current.roles.includes(RentalRole.TENANT) && (input.roles || input.buildingIds)) {
        throw this.conflict('Roles and buildings of a tenant account follow their occupancy; only the status can be changed here.');
      }

      const nextRoles = input.roles ? this.unique(input.roles) : current.roles;
      // Chỉ thay quyền truy cập trong phạm vi tòa nhà của chủ nhà; tòa nhà ngoài phạm vi giữ nguyên
      const nextBuildings = input.buildingIds
        ? this.unique([...current.buildingIds.filter((id) => !scope.includes(id)), ...input.buildingIds])
        : current.buildingIds;
      const nextStatus = this.nextStatus(user, input.status);

      if (userId === actor.id) {
        if (nextStatus === UserStatus.DISABLED) throw this.conflict('You cannot disable your own account.');
        if (current.roles.includes(RentalRole.LANDLORD) && !nextRoles.includes(RentalRole.LANDLORD)) {
          throw this.conflict('You cannot remove your own landlord role.');
        }
      }

      const removedRoles = current.roles.filter((r) => !nextRoles.includes(r));
      const addedRoles = nextRoles.filter((r) => !current.roles.includes(r));
      const removedBuildings = current.buildingIds.filter((id) => !nextBuildings.includes(id));
      const addedBuildings = nextBuildings.filter((id) => !current.buildingIds.includes(id));

      await this.assertBuildingsKeepALandlord(manager, userId, current, { nextRoles, nextBuildings, nextStatus });

      if (input.fullName !== undefined) user.fullName = input.fullName.trim();
      user.status = nextStatus;
      await manager.getRepository(User).save(user);

      if (removedRoles.length) await manager.getRepository(UserRole).delete({ userId, roleCode: In(removedRoles) });
      if (addedRoles.length) {
        await manager.getRepository(UserRole).insert(addedRoles.map((roleCode) => ({ userId, roleCode, grantedBy: actor.id })));
      }
      if (removedBuildings.length) await manager.getRepository(UserBuildingAccess).delete({ userId, buildingId: In(removedBuildings) });
      if (addedBuildings.length) {
        await manager
          .getRepository(UserBuildingAccess)
          .insert(addedBuildings.map((buildingId) => ({ userId, buildingId, grantedBy: actor.id })));
      }

      const disabled = nextStatus === UserStatus.DISABLED && current.status !== UserStatus.DISABLED;
      const reduced = removedRoles.length > 0 || removedBuildings.length > 0;
      if (disabled || reduced) {
        await this.sessions.revokeAll(userId, disabled ? SessionRevokedReason.ACCOUNT_DISABLED : SessionRevokedReason.ACCESS_REDUCED, undefined, manager);
      }
      return { permissionsChanged: disabled || reduced || addedRoles.length > 0 || nextStatus !== current.status };
    });

    if (effects.permissionsChanged) await this.permissionCache.invalidateUserPermissions(userId);
    return this.view(userId, scope);
  }

  // ---------------------------------------------------------------------------

  private nextStatus(user: User & { passwordHash?: string | null }, requested?: UserStatus): UserStatus {
    if (!requested || requested === user.status) return user.status;
    if (requested === UserStatus.DISABLED) return UserStatus.DISABLED;
    // Mở lại tài khoản chưa từng kích hoạt → quay về chờ kích hoạt (chưa có mật khẩu)
    return user.phoneVerifiedAt ? UserStatus.ACTIVE : UserStatus.PENDING_ACTIVATION;
  }

  /** Mỗi tòa nhà bị ảnh hưởng phải còn ít nhất một chủ nhà ACTIVE khác */
  private async assertBuildingsKeepALandlord(
    manager: EntityManager,
    userId: string,
    current: { roles: string[]; buildingIds: string[]; status: UserStatus },
    next: { nextRoles: string[]; nextBuildings: string[]; nextStatus: UserStatus },
  ): Promise<void> {
    if (!current.roles.includes(RentalRole.LANDLORD) || current.status !== UserStatus.ACTIVE) return;
    const stillLandlord = next.nextRoles.includes(RentalRole.LANDLORD) && next.nextStatus === UserStatus.ACTIVE;
    const losing = stillLandlord ? current.buildingIds.filter((id) => !next.nextBuildings.includes(id)) : current.buildingIds;
    if (losing.length === 0) return;

    const rows: Array<{ building_id: string }> = await manager.query(
      `SELECT DISTINCT a.building_id
         FROM user_building_access a
         JOIN user_roles r ON r.user_id = a.user_id AND r.role_code = $2
         JOIN users u ON u.id = a.user_id AND u.status = $3 AND u.deleted_at IS NULL
        WHERE a.building_id = ANY($1::uuid[]) AND a.user_id <> $4`,
      [losing, RentalRole.LANDLORD, UserStatus.ACTIVE, userId],
    );
    const covered = new Set(rows.map((r) => r.building_id));
    const orphaned = losing.filter((id) => !covered.has(id));
    if (orphaned.length) {
      throw new ConflictException({
        errorCode: SystemErrorCode.RES_CONFLICT,
        message: 'Every building must keep at least one active landlord.',
        details: orphaned.map((buildingId) => ({ field: 'buildingIds', issue: 'LAST_LANDLORD', buildingId })),
      });
    }
  }

  private async assertWithinActorBuildings(actor: RequestUserContext, buildingIds: string[]): Promise<void> {
    const scope = await this.actorBuildingIds(actor);
    const foreign = buildingIds.filter((id) => !scope.includes(id));
    if (foreign.length) throw this.foreignBuilding(foreign);
  }

  private async actorBuildingIds(actor: RequestUserContext): Promise<string[]> {
    const rows = await this.dataSource.getRepository(UserBuildingAccess).find({ where: { userId: actor.id } });
    return rows.map((r) => r.buildingId);
  }

  private async accessOf(manager: EntityManager, userId: string) {
    const user = await manager.getRepository(User).findOneOrFail({ where: { id: userId } });
    const [roles, access] = await Promise.all([
      manager.getRepository(UserRole).find({ where: { userId } }),
      manager.getRepository(UserBuildingAccess).find({ where: { userId } }),
    ]);
    return { status: user.status, roles: roles.map((r) => r.roleCode).sort(), buildingIds: access.map((a) => a.buildingId) };
  }

  private async view(userId: string, scope: string[]): Promise<UserView> {
    const user = await this.dataSource.getRepository(User).findOneOrFail({ where: { id: userId } });
    return (await this.views([user], scope))[0];
  }

  /** Không N+1: vai trò & tòa nhà của cả trang được nạp bằng 2 truy vấn IN (...) */
  private async views(users: User[], scope: string[]): Promise<UserView[]> {
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);
    const [roles, access] = await Promise.all([
      this.dataSource.getRepository(UserRole).find({ where: { userId: In(ids) } }),
      this.dataSource.getRepository(UserBuildingAccess).find({ where: { userId: In(ids) }, order: { createdAt: 'ASC' } }),
    ]);
    return users.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      phoneMasked: maskPhoneNumber(user.phoneE164),
      status: user.status,
      roles: roles.filter((r) => r.userId === user.id).map((r) => r.roleCode).sort(),
      // Chỉ hiển thị tòa nhà trong phạm vi của chủ nhà đang xem
      buildingIds: access.filter((a) => a.userId === user.id && scope.includes(a.buildingId)).map((a) => a.buildingId),
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      version: user.version,
    }));
  }

  private sendInvitation(user: User, roles: string[]): void {
    void this.notifications
      .dispatch({
        channels: [NotificationChannel.SMS],
        recipient: { phone: user.phoneE164, name: user.fullName },
        payload: {
          templateName: NOTIFICATION_TEMPLATES.ACCOUNT_INVITATION,
          context: { user: { name: user.fullName, roleLabel: roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') } },
        },
      })
      .catch((err) => this.logger.warn(`Invitation SMS could not be sent: ${err.message}`));
  }

  private normalizePhone(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: [{ field: 'phone', message: err.message }],
        });
      }
      throw err;
    }
  }

  private unique<T>(values: T[]): T[] {
    return [...new Set(values)];
  }

  private phoneTaken() {
    return new ConflictException({ errorCode: SystemErrorCode.RES_ALREADY_EXISTS, message: 'This phone number already has an account.' });
  }

  private foreignBuilding(buildingIds: string[]) {
    return new ForbiddenException({
      errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
      message: 'You can only grant access to your own buildings.',
      details: buildingIds.map((buildingId) => ({ field: 'buildingIds', issue: 'NOT_YOUR_BUILDING', buildingId })),
    });
  }

  private conflict(message: string) {
    return new ConflictException({ errorCode: SystemErrorCode.RES_CONFLICT, message });
  }
}
