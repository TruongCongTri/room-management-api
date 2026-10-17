/**
 * Gateway chính xử lý kết nối, xác thực handshake, phân phòng cách ly và ngắt kết nối có kiểm soát.
 *  - Xác thực JWT ở middleware của namespace (từ chối trước khi socket được tạo).
 *  - Phòng cách ly: building:<buildingId> (nếu có) và user:<userId>.
 *  - Graceful Teardown (Pha 2 shutdown): gửi 'reconnect_please' rồi đóng socket CỦA POD NÀY để client
 *    kết nối lại có giãn cách sang Pod khác thay vì đồng loạt reconnect (Thundering Herd).
 */
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, Optional, UseInterceptors } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { WsJwtGuard } from '../guards/ws-jwt.guard';
import { WsRequestContextInterceptor } from '../interceptors/ws-request-context.interceptor';
import { ShutdownRegistry } from '../../../core/shutdown/shutdown.registry';
import { ShutdownPhase } from '../../../core/shutdown/shutdown.interface';

export const RECONNECT_EVENT = 'reconnect_please';

@WebSocketGateway({ namespace: '/realtime' })
@UseInterceptors(WsRequestContextInterceptor)
export class AppEventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(AppEventsGateway.name);

  constructor(
    private readonly wsJwtGuard: WsJwtGuard,
    @Optional() private readonly shutdownRegistry?: ShutdownRegistry,
  ) {}

  onModuleInit(): void {
    this.shutdownRegistry?.register(
      'WebSocketGracefulTeardown',
      ShutdownPhase.PAUSE_CONSUMERS,
      () => this.teardown(),
      15,
    );
  }

  afterInit(namespace: Namespace): void {
    // Xác thực trong handshake: socket không hợp lệ bị từ chối với lỗi 'connect_error' phía client
    namespace.use((socket, next) => {
      this.wsJwtGuard
        .authenticateSocket(socket)
        .then(() => next())
        .catch((err: Error) => next(new Error(err.message || 'Unauthorized')));
    });
  }

  handleConnection(client: Socket): void {
    const user = client.data.user;
    if (!user) {
      client.disconnect(true);
      return;
    }

    // Tự động gán Client vào Room Tenant và Room Cá nhân để cô lập dữ liệu
    if (user.tenantId) client.join(`building:${user.tenantId}`);
    client.join(`user:${user.id}`);

    this.logger.debug(`[WS Connect] Client ${client.id} (user=${user.id}, building=${user.tenantId ?? '-'}) joined rooms`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[WS Disconnect] Client ${client.id} disconnected.`);
  }

  /** Chỉ tác động socket của Pod hiện tại (cờ local), không phát qua Redis adapter sang Pod khác */
  async teardown(): Promise<void> {
    if (!this.server) return;
    const local = this.server.local;
    local.emit(RECONNECT_EVENT, { reason: 'server_shutdown', retryAfterMs: 1000 + Math.floor(Math.random() * 4000) });
    // Cho client thời gian nhận thông điệp trước khi đóng kết nối
    await new Promise((resolve) => setTimeout(resolve, 250));
    local.disconnectSockets(true);
    this.logger.log('[Shutdown] WebSocket clients notified (reconnect_please) and disconnected.');
  }
}
