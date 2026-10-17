export interface CreateOutboxEventDto<T = Record<string, any>> {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  explicitBuildingId?: string;
  explicitTraceId?: string;
  explicitActorId?: string;
  maxRetries?: number;
}

export interface OutboxRelayEvent {
  id: string;
  /** Tòa nhà phát sinh sự kiện (NULL = sự kiện hệ thống) */
  buildingId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, any>;
  traceId: string;
  traceparent?: string | null;
  actorId?: string | null;
  createdAt?: Date;
}

export interface OutboxRelayHandler {
  /**
   * Chuyển tiếp sự kiện sang Message Broker (BullMQ, Kafka, RabbitMQ).
   * PHẢI idempotent theo event.id: sự kiện có thể được relay lại sau sự cố (at-least-once).
   */
  relay(event: OutboxRelayEvent): Promise<void>;
}
