import { Global, Module } from '@nestjs/common';
import { AppEventsGateway } from './gateways/app-events.gateway';
import { RealtimeEmitterService } from './services/realtime-emitter.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsRequestContextInterceptor } from './interceptors/ws-request-context.interceptor';

/**
 * JwtTokenService (xác thực token) được cung cấp toàn cục bởi SecurityModule.
 * Redis adapter được gắn trong main.ts (app.useWebSocketAdapter).
 */
@Global()
@Module({
  providers: [AppEventsGateway, RealtimeEmitterService, WsJwtGuard, WsRequestContextInterceptor],
  exports: [RealtimeEmitterService, AppEventsGateway, WsJwtGuard],
})
export class RealtimeWebSocketModule {}
