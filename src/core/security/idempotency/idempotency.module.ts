import { Global, Module } from '@nestjs/common';
import { IdempotencyStorageService } from './idempotency-storage.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * IdempotencyInterceptor được AppModule đăng ký toàn cục ở vị trí TRONG CÙNG của chuỗi interceptor
 * (bên trong TimeoutInterceptor) để @Idempotent() hoạt động khai báo, không cần @UseInterceptors.
 */
@Global()
@Module({
  providers: [IdempotencyStorageService, IdempotencyInterceptor],
  exports: [IdempotencyStorageService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
