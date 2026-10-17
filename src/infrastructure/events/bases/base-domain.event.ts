import { randomUUID } from 'crypto';
import { RequestContextService } from '../../../core/context/request-context.service';

export interface DomainEventMetadata {
  eventId: string;
  traceId: string;
  tenantId?: string;
  actorId?: string;
  occurredAt: Date;
}

/**
 * Lớp cơ sở cho mọi Domain Event: tự động mang metadata phân tán (traceId, tenantId, actorId)
 * lấy từ RequestContext hiện hành nếu nơi phát sự kiện không truyền tường minh.
 *
 * @example
 * export class ContractActivatedEvent extends BaseDomainEvent<{ contractId: string; roomId: string }> {}
 * await publisher.publishAsync(DOMAIN_EVENTS.CONTRACT.ACTIVATED, new ContractActivatedEvent({ contractId, roomId }));
 */
export abstract class BaseDomainEvent<T = any> {
  public readonly metadata: DomainEventMetadata;
  public readonly payload: T;

  constructor(payload: T, context?: { traceId?: string; tenantId?: string; actorId?: string }) {
    const store = RequestContextService.current();
    this.payload = payload;
    this.metadata = {
      eventId: randomUUID(),
      traceId: context?.traceId || store?.traceId || `EVT-${randomUUID()}`,
      tenantId: context?.tenantId ?? store?.tenantOverride ?? store?.user?.tenantId,
      actorId: context?.actorId ?? store?.user?.id,
      occurredAt: new Date(),
    };
  }
}
