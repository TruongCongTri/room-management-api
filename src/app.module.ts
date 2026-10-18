import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { CoreModule } from './core/core.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { IdentityModule } from './modules/identity/identity.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { AssetsModule } from './modules/assets/assets.module';
import { TenantsModule } from './modules/tenants/tenants.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { CustomThrottlerGuard } from './core/security/throttler/custom-throttler.guard';
import { PermissionsGuard } from './core/access-control/permissions.guard';
import { FeatureFlagGuard } from './core/feature-flag/feature-flag.guard';
import { RequestContextSyncInterceptor } from './core/context/request-context.interceptor';
import { TenancyContextInterceptor } from './core/multitenancy/tenancy-context.interceptor';
import { DeprecationInterceptor } from './infrastructure/versioning/deprecation.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpCacheInterceptor } from './infrastructure/cache/interceptors/http-cache.interceptor';
import { IdempotencyInterceptor } from './core/security/idempotency/idempotency.interceptor';
import { CustomValidationPipe } from './common/pipes/validation.pipe';

/**
 * Điểm đăng ký DUY NHẤT của các enhancer toàn cục - thứ tự khai báo chính là thứ tự thực thi
 * (các feature module không tự đăng ký APP_* để tránh chạy hai lần / sai thứ tự).
 *
 * Guards:       JwtAuth → Throttler (theo user đã xác thực, fallback IP) → Roles → Permissions → FeatureFlag
 * Interceptors: (ngoài → trong) ContextSync → Tenancy → Deprecation → Audit → Timeout → Transform
 *               → HttpCache → Idempotency → handler
 *   - Audit bọc ngoài Timeout để ghi nhận cả request bị timeout.
 *   - Idempotency ở trong cùng: cache dữ liệu thô của handler; khóa IN_PROGRESS vẫn giữ khi timeout
 *     (tránh thực thi trùng lặp nếu handler còn chạy nền).
 * Filters:      kiểm tra theo thứ tự ngược - HttpExceptionFilter trước, AllExceptionsFilter là lưới an toàn cuối.
 */
@Module({
  imports: [
    CoreModule,
    InfrastructureModule,
    // Domain Business Modules (tài liệu 02, thứ tự build: tài liệu 06)
    IdentityModule,
    PropertiesModule,
    AssetsModule,
    TenantsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },

    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: CustomThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useExisting: PermissionsGuard },
    { provide: APP_GUARD, useExisting: FeatureFlagGuard },

    { provide: APP_INTERCEPTOR, useExisting: RequestContextSyncInterceptor },
    { provide: APP_INTERCEPTOR, useExisting: TenancyContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useExisting: HttpCacheInterceptor },
    { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },

    { provide: APP_PIPE, useClass: CustomValidationPipe },
  ],
})
export class AppModule {}
