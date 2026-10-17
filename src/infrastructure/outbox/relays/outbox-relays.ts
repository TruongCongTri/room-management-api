/**
 * Chiến lược chuyển tiếp sự kiện Outbox:
 *  - BullMqOutboxRelay (mặc định khi có Redis): đẩy sang queue `domain-events-queue` với jobId = outbox event id
 *    → BullMQ tự loại bỏ job trùng nếu sự kiện bị relay lại sau sự cố (exactly-once enqueue).
 *  - InProcessOutboxRelay (REDIS_ENABLED=false): phát qua event bus nội bộ (EventEmitter) cho môi trường dev.
 * Module nghiệp vụ có thể thay bằng Kafka/RabbitMQ bằng cách override provider OUTBOX_RELAY_HANDLER.
 */
import { Queue } from 'bullmq';
import { OutboxRelayEvent, OutboxRelayHandler } from '../interfaces/outbox.interface';
import { EnvelopedJobPayload } from '../../queue/interfaces/queue.interface';
import { AppEventPublisher } from '../../events/services/app-event-publisher.service';
import { BaseDomainEvent } from '../../events/bases/base-domain.event';

export interface DomainEventJobPayload {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt?: string;
  data: Record<string, any>;
}

export class BullMqOutboxRelay implements OutboxRelayHandler {
  constructor(private readonly queue: Queue) {}

  async relay(event: OutboxRelayEvent): Promise<void> {
    const job: EnvelopedJobPayload<DomainEventJobPayload> = {
      metadata: {
        traceId: event.traceId,
        tenantId: event.buildingId ?? 'global',
        actorId: event.actorId ?? undefined,
        enqueuedAt: new Date().toISOString(),
        traceparent: event.traceparent ?? undefined,
      },
      payload: {
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        occurredAt: event.createdAt ? new Date(event.createdAt).toISOString() : undefined,
        data: event.payload,
      },
    };
    await this.queue.add(event.eventType, job, { jobId: event.id });
  }
}

/** Sự kiện miền được tái tạo từ bản ghi Outbox (giữ nguyên traceId/tenant/actor gốc) */
export class OutboxDomainEvent extends BaseDomainEvent<DomainEventJobPayload> {}

export class InProcessOutboxRelay implements OutboxRelayHandler {
  constructor(private readonly publisher: AppEventPublisher) {}

  async relay(event: OutboxRelayEvent): Promise<void> {
    await this.publisher.publishAsync(
      event.eventType,
      new OutboxDomainEvent(
        {
          eventId: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          data: event.payload,
        },
        { traceId: event.traceId, tenantId: event.buildingId ?? undefined, actorId: event.actorId ?? undefined },
      ),
    );
  }
}
