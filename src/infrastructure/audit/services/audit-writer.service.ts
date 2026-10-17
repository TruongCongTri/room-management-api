/**
 * Chiều Ghi bất biến (Immutable Ingestion):
 *  - record(): ghi độc lập, lỗi không làm gián đoạn nghiệp vụ (HTTP audit, sự kiện bảo mật).
 *  - recordInTransaction(): ghi CÙNG transaction của thay đổi dữ liệu (TypeORM subscriber):
 *    transaction nghiệp vụ rollback → bản ghi audit cũng rollback; ghi audit lỗi → thay đổi bị hủy
 *    (không bao giờ có thay đổi dữ liệu mà thiếu dấu vết).
 */

import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AuditLogEntity } from '../entities/audit-log.entity';
import { AuditAction, EntityDiffSnapshot } from '../interfaces/audit.interface';
import { RequestContextService } from '../../../core/context/request-context.service';

export interface CreateAuditRecordPayload {
  resource: string;
  resourceId: string;
  action: AuditAction;
  diffSnapshot?: EntityDiffSnapshot | null;
  metadata?: Record<string, unknown> | null;
  explicitBuildingId?: string;
  explicitActorId?: string;
}

const MAX_USER_AGENT_LENGTH = 512;

@Injectable()
export class AuditWriterService {
  private readonly logger = new Logger(AuditWriterService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly contextService: RequestContextService,
  ) {}

  /** Dựng bản ghi audit từ ngữ cảnh request/tác vụ nền hiện tại */
  buildEntry(payload: CreateAuditRecordPayload): Partial<AuditLogEntity> {
    const user = this.contextService.getCurrentUser();
    return {
      buildingId: payload.explicitBuildingId || this.contextService.getBuildingId() || user?.tenantId || null,
      actorId: payload.explicitActorId || user?.id || 'SYSTEM_INTERNAL',
      actorEmail: user?.email ?? null,
      departmentId: user?.departmentId ?? null,
      action: payload.action,
      resource: payload.resource,
      resourceId: String(payload.resourceId).slice(0, 255),
      diffSnapshot: payload.diffSnapshot ?? null,
      metadata: payload.metadata ?? null,
      traceId: this.contextService.getTraceId().slice(0, 128),
      clientIp: this.contextService.getClientIp().slice(0, 45),
      userAgent: this.contextService.getUserAgent()?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    };
  }

  /**
   * Ghi độc lập: an toàn, lỗi chỉ được log (không làm hỏng response của người dùng)
   */
  async record(payload: CreateAuditRecordPayload): Promise<void> {
    try {
      const auditRepo = this.dataSource.getRepository(AuditLogEntity);
      await auditRepo.save(auditRepo.create(this.buildEntry(payload)));
    } catch (err: any) {
      this.logger.error(`Failed to record audit log: ${err.message}`, err.stack);
    }
  }

  /**
   * Ghi trong transaction đang mở (dùng EntityManager của transaction)
   */
  async recordInTransaction(manager: EntityManager, payload: CreateAuditRecordPayload): Promise<void> {
    // Cột jsonb (diffSnapshot, metadata) không khớp kiểu QueryDeepPartialEntity của TypeORM → ép kiểu tường minh
    await manager
      .getRepository(AuditLogEntity)
      .insert(this.buildEntry(payload) as QueryDeepPartialEntity<AuditLogEntity>);
  }
}
