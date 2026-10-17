/**
 * TypeORM Subscriber tự động bắt INSERT, UPDATE, SOFT_DELETE, DELETE, RECOVER của các Entity gắn @Auditable()
 * và ghi audit TRONG CÙNG transaction (event.manager) với thay đổi dữ liệu.
 *
 * Bảo mật dữ liệu: cột dùng EncryptionTransformer (hộ chiếu, CMND, số thẻ) luôn bị che trong diff -
 * entity trong bộ nhớ chứa giá trị GIẢI MÃ, nếu không che thì audit log sẽ lưu PII dạng rõ.
 *
 * Lưu ý: UPDATE qua QueryBuilder/Repository.update() không nạp bản ghi cũ (databaseEntity) → diff rỗng,
 * vẫn ghi nhận hành động. Dùng repository.save(entity) cho thao tác cần diff đầy đủ.
 */
import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntityMetadata,
  EntitySubscriberInterface,
  InsertEvent,
  RecoverEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { AuditWriterService } from '../services/audit-writer.service';
import { AuditAction } from '../interfaces/audit.interface';
import { calculateEntityDiff } from '../utils/diff-calculator.util';
import { AuditableOptions, getAuditableOptions } from '../decorators/auditable.decorator';
import { EncryptionTransformer } from '../../../core/security/encryption/encryption.transformer';

@Injectable()
export class AuditEntitySubscriber implements EntitySubscriberInterface {
  constructor(
    dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
  ) {
    // Tự đăng ký vào DataSource (autoLoadEntities không nạp subscriber; @EventSubscriber() không có DI)
    if (dataSource?.subscribers && !dataSource.subscribers.includes(this)) {
      dataSource.subscribers.push(this);
    }
  }

  async afterInsert(event: InsertEvent<any>): Promise<void> {
    await this.capture(event.metadata, event.manager, AuditAction.CREATE, event.entity, {}, event.entity);
  }

  async afterUpdate(event: UpdateEvent<any>): Promise<void> {
    const target = { ...event.databaseEntity, ...event.entity };
    await this.capture(event.metadata, event.manager, AuditAction.UPDATE, target, event.databaseEntity, event.entity);
  }

  async afterSoftRemove(event: SoftRemoveEvent<any>): Promise<void> {
    await this.capture(event.metadata, event.manager, AuditAction.DELETE, event.databaseEntity ?? event.entity, null, null, {
      softDelete: true,
    });
  }

  async afterRemove(event: RemoveEvent<any>): Promise<void> {
    const target = event.databaseEntity ?? event.entity ?? (event.entityId ? { id: event.entityId } : undefined);
    await this.capture(event.metadata, event.manager, AuditAction.DELETE, target, null, null, { softDelete: false });
  }

  async afterRecover(event: RecoverEvent<any>): Promise<void> {
    await this.capture(event.metadata, event.manager, AuditAction.RESTORE, event.databaseEntity ?? event.entity, null, null);
  }

  private async capture(
    metadata: EntityMetadata | undefined,
    manager: InsertEvent<any>['manager'],
    action: AuditAction,
    target: Record<string, any> | undefined,
    before: Record<string, any> | null | undefined,
    after: Record<string, any> | null | undefined,
    extraMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!metadata) return;
    const options = getAuditableOptions(metadata.target);
    if (!options) return;

    const resourceId = this.resolveId(metadata, target);
    const diffSnapshot =
      before && after
        ? calculateEntityDiff(before, after, {
            redact: [...this.encryptedColumns(metadata), ...(options.redact ?? [])],
            ignore: options.exclude,
          })
        : null;

    // UPDATE không đổi giá trị nghiệp vụ nào (chỉ updatedAt/version) → không ghi rác
    if (action === AuditAction.UPDATE && before && after && !diffSnapshot) return;

    await this.auditWriter.recordInTransaction(manager, {
      resource: this.resourceName(metadata, options),
      resourceId,
      action,
      diffSnapshot,
      metadata: extraMetadata ?? null,
      explicitBuildingId: typeof target?.buildingId === 'string' ? target.buildingId : undefined,
    });
  }

  private resourceName(metadata: EntityMetadata, options: AuditableOptions): string {
    return options.resource ?? metadata.tableName;
  }

  private resolveId(metadata: EntityMetadata, target: Record<string, any> | undefined): string {
    if (!target) return 'unknown';
    const ids = metadata.primaryColumns.map((column) => column.getEntityValue(target)).filter((v) => v != null);
    return ids.length > 0 ? ids.map(String).join(':') : 'unknown';
  }

  private encryptedColumns(metadata: EntityMetadata): string[] {
    return metadata.columns
      .filter((column) => {
        const transformers = Array.isArray(column.transformer) ? column.transformer : [column.transformer];
        return transformers.some((t) => t instanceof EncryptionTransformer);
      })
      .map((column) => column.propertyName);
  }
}
