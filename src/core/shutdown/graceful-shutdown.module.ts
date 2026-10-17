import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ShutdownRegistry } from './shutdown.registry';
import { GracefulShutdownService } from './graceful-shutdown.service';
import { InFlightRequestMiddleware } from './in-flight-request.middleware';
import { ALL_ROUTES } from '../core.constants';

@Global()
@Module({
  providers: [ShutdownRegistry, GracefulShutdownService],
  exports: [ShutdownRegistry, GracefulShutdownService],
})
export class GracefulShutdownModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(InFlightRequestMiddleware).forRoutes(ALL_ROUTES);
  }
}
