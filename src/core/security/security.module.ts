/**
 * Phòng thủ chiều sâu: JWT verification, Rate limiting 3 tầng (Redis), Field-Level Encryption, Idempotency.
 * Guard toàn cục được đăng ký TẬP TRUNG ở AppModule (thứ tự: JwtAuth → Throttler → Roles → Permissions)
 * để tránh một guard bị đăng ký hai lần (đếm rate limit gấp đôi) hoặc chạy sai thứ tự.
 */
import { Global, Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { EncryptionService } from './encryption/encryption.service';
import { CustomThrottlerGuard } from './throttler/custom-throttler.guard';
import { THROTTLE_TIERS } from './throttler/throttler.constants';
import { resolveThrottleTier } from './throttler/throttler.decorators';
import { createThrottlerStorage } from './throttler/throttler-storage.provider';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { JwtTokenService } from './jwt/jwt-token.service';

export function buildJwtOptions(config: AppConfigService): JwtModuleOptions {
  const jwt = config.security.jwt;
  const hmac = jwt.algorithm.startsWith('HS');
  // jsonwebtoken từ chối khóa có giá trị undefined trong options → chỉ thêm claim khi được cấu hình
  const common = {
    ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
    ...(jwt.audience ? { audience: jwt.audience } : {}),
  };

  return {
    ...(hmac ? { secret: jwt.verifyKey } : { publicKey: jwt.verifyKey, privateKey: jwt.signKey }),
    signOptions: { algorithm: jwt.algorithm, expiresIn: jwt.expiresIn as any, ...common },
    verifyOptions: {
      // Ghim thuật toán: không bao giờ chấp nhận thuật toán do token tự khai báo
      algorithms: [jwt.algorithm],
      clockTolerance: jwt.clockToleranceSec,
      ...common,
    },
  };
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: buildJwtOptions,
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, REDIS_CLIENT],
      useFactory: (config: AppConfigService, redis: Redis | null) => {
        const { ttl, limit, searchLimit, sensitiveLimit } = config.throttler;
        return {
          // Mỗi route chỉ bị tính bởi đúng một tầng (mặc định PUBLIC);
          // nếu không có skipIf, cả 3 tầng cùng áp dụng và mọi API bị giới hạn ở mức SENSITIVE.
          throttlers: [
            {
              name: THROTTLE_TIERS.PUBLIC,
              ttl,
              limit,
              skipIf: (ctx) => resolveThrottleTier(ctx) !== THROTTLE_TIERS.PUBLIC,
            },
            {
              name: THROTTLE_TIERS.SEARCH,
              ttl,
              limit: searchLimit,
              skipIf: (ctx) => resolveThrottleTier(ctx) !== THROTTLE_TIERS.SEARCH,
            },
            {
              name: THROTTLE_TIERS.SENSITIVE,
              ttl,
              limit: sensitiveLimit,
              skipIf: (ctx) => resolveThrottleTier(ctx) !== THROTTLE_TIERS.SENSITIVE,
            },
          ],
          storage: createThrottlerStorage(redis),
        };
      },
    }),
    IdempotencyModule,
  ],
  providers: [EncryptionService, CustomThrottlerGuard, JwtTokenService],
  exports: [
    IdempotencyModule,
    EncryptionService,
    CustomThrottlerGuard,
    ThrottlerModule,
    JwtModule,
    JwtTokenService,
  ],
})
export class SecurityModule {}
