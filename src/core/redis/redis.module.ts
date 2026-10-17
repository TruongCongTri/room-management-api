/**
 * Kết nối Redis dùng chung cho Throttler, Idempotency, Permission Cache, Cache, Distributed Lock, Feature Flag.
 * Khi REDIS_ENABLED=false (chỉ cho phép ngoài production), REDIS_CLIENT = null
 * và các module tiêu thụ tự động fallback về bộ nhớ trong tiến trình.
 *
 * Cùng một cấu hình chạy được với:
 *  - Redis Docker local:   REDIS_HOST=127.0.0.1 REDIS_PORT=6379
 *  - Redis managed online: REDIS_URL=rediss://default:<password>@<host>:6379 (TLS + SNI)
 */
import { Global, Logger, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { ShutdownRegistry } from '../shutdown/shutdown.registry';
import { ShutdownPhase } from '../shutdown/shutdown.interface';
import { REDIS_CLIENT } from './redis.constants';
import { RedisConnectionFactory } from './redis-connection.factory';

@Global()
@Module({
  providers: [
    RedisConnectionFactory,
    {
      provide: REDIS_CLIENT,
      inject: [RedisConnectionFactory, ShutdownRegistry],
      useFactory: async (
        factory: RedisConnectionFactory,
        shutdownRegistry: ShutdownRegistry,
      ): Promise<Redis | null> => {
        const logger = new Logger('Redis');

        // Đóng mọi client (kể cả client tạo sau bởi Socket.IO adapter...) ở Pha 5, trước DB pool
        shutdownRegistry.register(
          'RedisConnections',
          ShutdownPhase.RELEASE_POOLS,
          () => factory.closeAll(),
          90,
        );

        if (!factory.enabled) {
          logger.warn(
            'REDIS_ENABLED=false: using per-process in-memory stores. Not safe for multi-instance deployments.',
          );
          return null;
        }

        const client = factory.create('shared', 'shared');

        // Chờ kết nối đầu tiên để các module dùng Redis ngay lúc khởi tạo không gặp lỗi offline-queue.
        // Không chặn boot nếu Redis chưa sẵn sàng: readiness probe sẽ báo 503 cho tới khi kết nối được.
        const ready = await factory.waitUntilReady(client, factory.settings.connectTimeoutMs);
        if (!ready) {
          logger.warn(
            `Redis (${factory.target}) is not reachable yet; continuing with fail-open fallbacks while reconnecting.`,
          );
        }
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT, RedisConnectionFactory],
})
export class RedisModule {}
