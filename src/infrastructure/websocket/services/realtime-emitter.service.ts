import { Injectable, Logger } from '@nestjs/common';
import { AppEventsGateway, RECONNECT_EVENT } from '../gateways/app-events.gateway';

/** Sự kiện realtime đẩy tới dashboard quản lý & app bảo vệ */
export const REALTIME_EVENTS = {
  METER_READING_SUBMITTED: 'meter_reading.submitted',
  METER_ANOMALY: 'meter_reading.anomaly',
  ROOM_STATUS_CHANGED: 'room.status_changed',
  OCCUPANCY_CHANGED: 'room.occupancy_changed',
  INVOICE_PAID: 'invoice.paid',
  RECONNECT_PLEASE: RECONNECT_EVENT,
} as const;

@Injectable()
export class RealtimeEmitterService {
  private readonly logger = new Logger(RealtimeEmitterService.name);

  constructor(private readonly gateway: AppEventsGateway) {}

  /**
   * Phát tới mọi người dùng đang trực tuyến của một tòa nhà (đồng bộ đa Pod qua Redis),
   * vd: bảo vệ vừa nộp chỉ số phòng P.302 → dashboard quản lý cập nhật checklist ngay.
   */
  emitToBuilding(buildingId: string, event: string, data: any): void {
    this.gateway.server.to(`building:${buildingId}`).emit(event, data);
    this.logger.debug(`[Realtime Broadcast] Sent '${event}' to building '${buildingId}'`);
  }

  /**
   * Bắn thông báo trực tiếp tới 1 User cụ thể trên tất cả thiết bị của họ
   */
  emitToUser(userId: string, event: string, data: any): void {
    this.gateway.server.to(`user:${userId}`).emit(event, data);
    this.logger.debug(`[Realtime P2P] Sent '${event}' to user '${userId}'`);
  }

  /**
   * Bắn cập nhật tới một phòng Socket.IO tùy biến (vd: `room:<roomId>` cho màn hình chi tiết phòng)
   */
  emitToRoom(room: string, event: string, data: any): void {
    this.gateway.server.to(room).emit(event, data);
  }
}
