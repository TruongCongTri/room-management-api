import { Global, Module } from '@nestjs/common';
import { TenancyContextInterceptor } from './tenancy-context.interceptor';
import { TenancySubscriber } from './tenancy.subscriber';
import { RlsService } from './rls.service';

/**
 * TenancyContextInterceptor được AppModule đăng ký toàn cục (ngay sau RequestContextSyncInterceptor).
 */
@Global()
@Module({
  providers: [TenancySubscriber, RlsService, TenancyContextInterceptor],
  exports: [TenancySubscriber, RlsService, TenancyContextInterceptor],
})
export class MultiTenancyModule {}
