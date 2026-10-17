import { Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { RequestContextService } from './request-context.service';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextSyncInterceptor } from './request-context.interceptor';
import { ALL_ROUTES } from '../core.constants';

/**
 * RequestContextSyncInterceptor được export để AppModule đăng ký toàn cục theo thứ tự tường minh
 * (không tự đăng ký APP_INTERCEPTOR tại đây để tránh chạy hai lần / sai thứ tự).
 */
@Global()
@Module({
  providers: [RequestContextService, RequestContextSyncInterceptor],
  exports: [RequestContextService, RequestContextSyncInterceptor],
})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes(ALL_ROUTES);
  }
}
