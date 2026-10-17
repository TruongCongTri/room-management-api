/**
 * Chiều Đọc phân quyền theo 3 phạm vi:
 *  audit:read:own, audit:read:department, và audit:read:global.
 * Dùng chung logic phạm vi với CaslAbilityFactory (MANAGE, wildcard 'all', DENY tường minh)
 * để quyền tra cứu audit luôn nhất quán với ma trận phân quyền của toàn hệ thống.
 *
 * */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogEntity } from '../entities/audit-log.entity';
import { ScopedAuditQueryDto } from '../interfaces/audit.interface';
import { RequestContextService } from '../../../core/context/request-context.service';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { CaslAbilityFactory } from '../../../core/access-control/casl-ability.factory';

export const AUDIT_RESOURCE = 'audit';

@Injectable()
export class AuditViewerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly contextService: RequestContextService,
    private readonly abilityFactory: CaslAbilityFactory,
  ) {}

  /**
   * Chiều Đọc & Phân quyền truy cập (Scoped Retrieval)
   */
  async queryLogs(filters: ScopedAuditQueryDto) {
    const user = this.contextService.getCurrentUser();
    if (!user) {
      throw new ForbiddenException('Authentication required to access audit records.');
    }

    const buildingId = this.contextService.getBuildingId() ?? user.tenantId;
    if (!buildingId) {
      throw new ForbiddenException('A building context is required to read audit records.');
    }

    // DENY tường minh luôn thắng (CASL) trước khi xét phạm vi
    if (!this.abilityFactory.createForUser(user).can(Action.READ, AUDIT_RESOURCE)) {
      throw new ForbiddenException('You lack permission to read audit trails.');
    }

    const page = Math.max(1, Number(filters.page || 1));
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 20)));

    const queryBuilder = this.dataSource
      .getRepository(AuditLogEntity)
      .createQueryBuilder('log');

    const hasScope = (scope: Scope) => this.abilityFactory.hasScope(user, AUDIT_RESOURCE, Action.READ, scope);

    if (hasScope(Scope.GLOBAL)) {
      // 1. GLOBAL (chủ nhà / kiểm toán): sổ cái của MỌI tòa nhà được cấp trong token, lọc tự do
      const allowed = [...new Set([buildingId, ...(user.buildingIds ?? [])])];
      if (filters.buildingId && !allowed.includes(filters.buildingId)) {
        throw new ForbiddenException('The requested building is not assigned to your account.');
      }
      const scoped = filters.buildingId ? [filters.buildingId] : allowed;
      queryBuilder.where('log.buildingId IN (:...buildingIds)', { buildingIds: scoped });
      if (filters.actorId) queryBuilder.andWhere('log.actorId = :actorId', { actorId: filters.actorId });
      if (filters.departmentId) queryBuilder.andWhere('log.departmentId = :depId', { depId: filters.departmentId });
    } else if (hasScope(Scope.DEPARTMENT)) {
      // 2. DEPARTMENT (quản lý / kế toán): chỉ các thao tác trong tòa nhà được phân công
      queryBuilder.where('log.buildingId = :buildingId', { buildingId });
      if (filters.actorId) queryBuilder.andWhere('log.actorId = :actorId', { actorId: filters.actorId });
    } else if (hasScope(Scope.OWN)) {
      // 3. OWN (bảo vệ / khách thuê): chỉ thao tác do chính user thực hiện trong tòa nhà hiện hành
      queryBuilder
        .where('log.buildingId = :buildingId', { buildingId })
        .andWhere('log.actorId = :userId', { userId: user.id });
    } else {
      throw new ForbiddenException('You lack permission to read audit trails.');
    }

    // Các bộ lọc tùy chọn
    if (filters.resource) queryBuilder.andWhere('log.resource = :res', { res: filters.resource });
    if (filters.resourceId) queryBuilder.andWhere('log.resourceId = :resId', { resId: filters.resourceId });
    if (filters.action) queryBuilder.andWhere('log.action = :act', { act: filters.action });
    if (filters.startDate) queryBuilder.andWhere('log.createdAt >= :start', { start: new Date(filters.startDate) });
    if (filters.endDate) queryBuilder.andWhere('log.createdAt <= :end', { end: new Date(filters.endDate) });

    queryBuilder.orderBy('log.createdAt', 'DESC').skip((page - 1) * limit).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();
    return { items, total, page, limit };
  }
}
