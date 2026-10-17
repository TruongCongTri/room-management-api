import { Module } from '@nestjs/common';
import { AccessControlModule } from './access-control/access-control.module';
import { AppConfigModule } from './config/app-config.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { LoggerModule } from './logger/logger.module';
import { ResilienceModule } from './resilience/resilience.module';
import { SecurityModule } from './security/security.module';
import { GracefulShutdownModule } from './shutdown/graceful-shutdown.module';
import { MultiTenancyModule } from './multitenancy/multitenancy.module';
import { RedisModule } from './redis/redis.module';
import { I18nModule } from './i18n/i18n.module';
import { FeatureFlagModule } from './feature-flag/feature-flag.module';

/**
 * Các module lõi (Global Singletons / Lifecycle) - BẮT BUỘC khởi tạo đầu tiên.
 * Thứ tự import quyết định thứ tự đăng ký middleware toàn cục:
 *  - GracefulShutdown trước RequestContext: đếm in-flight cho mọi request.
 *  - RequestContext trước Logger: AsyncLocalStorage đã sẵn sàng khi pino-http ghi log.
 *  - Redis trước Security / AccessControl / FeatureFlag: REDIS_CLIENT sẵn sàng cho Throttler, Idempotency...
 */
const CORE_MODULES = [
  AppConfigModule,
  GracefulShutdownModule,
  RequestContextModule,
  LoggerModule,
  RedisModule,
  DatabaseModule,
  MultiTenancyModule,
  AccessControlModule,
  ResilienceModule,
  SecurityModule,
  I18nModule,
  FeatureFlagModule,
];

@Module({
  imports: CORE_MODULES,
  exports: CORE_MODULES,
})
export class CoreModule {}
