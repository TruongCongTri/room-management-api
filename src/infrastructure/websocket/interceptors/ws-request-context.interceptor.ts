/**
 * Thiết lập RequestContext (AsyncLocalStorage) cho từng message WebSocket: middleware HTTP không chạy với
 * Socket.IO, nên service/repository/logger bên dưới sẽ mất traceId/userId/tenantId nếu thiếu bước này.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { Socket } from 'socket.io';
import { RequestContextService } from '../../../core/context/request-context.service';

@Injectable()
export class WsRequestContextInterceptor implements NestInterceptor {
  constructor(private readonly contextService: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'ws') return next.handle();

    const client: Socket = context.switchToWs().getClient();
    return new Observable((subscriber) =>
      this.contextService.run(
        {
          traceId: randomUUID(),
          clientIp: client.handshake?.address ?? 'unknown',
          userAgent: client.handshake?.headers?.['user-agent'],
          user: client.data?.user,
          startTime: Date.now(),
          isBackgroundJob: false,
          metadata: new Map([['socketId', client.id]]),
        },
        () => next.handle().subscribe(subscriber),
      ),
    );
  }
}
