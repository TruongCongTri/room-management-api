/**
 * `room.status_changed` (outbox → AppEventPublisher) → dashboard của tòa nhà qua WebSocket (`room.status_changed`).
 * WebSocket tắt (WS_ENABLED=false) → không có RealtimeEmitterService, listener bỏ qua.
 */
import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { OutboxDomainEvent } from '../../../infrastructure/outbox/relays/outbox-relays';
import { REALTIME_EVENTS, RealtimeEmitterService } from '../../../infrastructure/websocket/services/realtime-emitter.service';

export interface RoomStatusChangedPayload {
  roomId: string;
  roomNumber: string;
  from: string;
  to: string;
}

@Injectable()
export class RoomEventsListener {
  constructor(@Optional() private readonly realtime?: RealtimeEmitterService) {}

  @OnEvent(DOMAIN_EVENTS.ROOM.STATUS_CHANGED)
  onStatusChanged(event: OutboxDomainEvent): void {
    const buildingId = event.metadata.tenantId;
    if (!this.realtime || !buildingId) return;
    const data = event.payload.data as RoomStatusChangedPayload;
    this.realtime.emitToBuilding(buildingId, REALTIME_EVENTS.ROOM_STATUS_CHANGED, {
      roomId: data.roomId,
      roomNumber: data.roomNumber,
      from: data.from,
      to: data.to,
      occurredAt: event.metadata.occurredAt,
    });
  }
}
