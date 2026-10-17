// Service lưu sự kiện vào chung Database Transaction với thực thể chính để giải quyết triệt để bài toán Dual-Write:

import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { context as otelContext, propagation } from '@opentelemetry/api';
import { OutboxEventEntity } from '../entities/outbox-event.entity';
import { CreateOutboxEventDto } from '../interfaces/outbox.interface';
import { OutboxEventStatus, OUTBOX_DEFAULTS } from '../constants/outbox.constants';
import { RequestContextService } from '../../../core/context/request-context.service';

@Injectable()
export class OutboxService {
  constructor(private readonly contextService: RequestContextService) {}

  /**
   * Lưu sự kiện Outbox bên trong Transaction của nghiệp vụ chính (cùng EntityManager)
   * @example
   * await dataSource.transaction(async (manager) => {
   *   const contract = await manager.save(Contract, entity);
   *   await outbox.createEventInTransaction(manager, {
   *     aggregateType: 'CONTRACT', aggregateId: contract.id, eventType: DOMAIN_EVENTS.CONTRACT.ACTIVATED, payload,
   *   });
   * });
   */
  async createEventInTransaction<T extends Record<string, any> = Record<string, any>>(
    manager: EntityManager,
    dto: CreateOutboxEventDto<T>,
  ): Promise<OutboxEventEntity> {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);

    const event = manager.create(OutboxEventEntity, {
      buildingId: dto.explicitBuildingId || this.contextService.getBuildingId() || null,
      aggregateType: dto.aggregateType,
      aggregateId: String(dto.aggregateId),
      eventType: dto.eventType,
      payload: dto.payload,
      status: OutboxEventStatus.PENDING,
      retryCount: 0,
      maxRetries: dto.maxRetries ?? OUTBOX_DEFAULTS.MAX_RETRIES,
      nextRetryAt: null,
      traceId: dto.explicitTraceId || this.contextService.getTraceId(),
      traceparent: carrier.traceparent ?? null,
      actorId: dto.explicitActorId || this.contextService.getUserId() || 'SYSTEM',
    });

    return manager.save(OutboxEventEntity, event);
  }
}
