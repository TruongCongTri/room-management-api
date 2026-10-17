/**
 * Xác thực danh tính JWT cho kết nối Socket.IO.
 *  - Handshake: AppEventsGateway gọi authenticateSocket() trong middleware của namespace
 *    (guard của NestJS KHÔNG chạy cho handleConnection).
 *  - Message (@SubscribeMessage + @UseGuards(WsJwtGuard)): dùng user đã gắn lúc handshake.
 * Token lấy từ handshake.auth.token (khuyến nghị) hoặc header Authorization: Bearer.
 * Không nhận token qua query string (dễ lộ trong access log của proxy / CDN).
 */
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { JwtTokenService } from '../../../core/security/jwt/jwt-token.service';
import { RequestUserContext } from '../../../core/context/request-context.model';

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly tokenService: JwtTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    if (client.data?.user) return true;
    await this.authenticateSocket(client);
    return true;
  }

  /** Xác thực token của socket và gắn RequestUserContext vào socket.data.user */
  async authenticateSocket(client: Socket): Promise<RequestUserContext> {
    const token = this.extractToken(client);
    if (!token) {
      throw new WsException('Missing authentication token in WebSocket connection.');
    }

    try {
      const user = await this.tokenService.verifyAccessToken(token);
      client.data.user = user;
      return user;
    } catch (err: any) {
      this.logger.warn(`WebSocket unauthorized attempt from ${client.handshake?.address}: ${err.message}`);
      throw new WsException('Invalid or expired WebSocket authentication token.');
    }
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken) {
      return authToken.replace(/^Bearer\s+/i, '');
    }
    return this.tokenService.extractBearerToken(client.handshake?.headers?.authorization);
  }
}
