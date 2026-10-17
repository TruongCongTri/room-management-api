import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MetricsService } from './services/metrics.service';
import { MetricsController } from './controllers/metrics.controller';
import { HttpMetricsMiddleware } from './middleware/http-metrics.middleware';
import { ALL_ROUTES } from '../../core/core.constants';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes(ALL_ROUTES);
  }
}
