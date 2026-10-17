/**
 * Socket.IO adapter đồng bộ Multi-Pod qua Redis Pub/Sub (@socket.io/redis-adapter).
 *  - Kết nối pub/sub tạo từ RedisConnectionFactory: cùng TLS / IP family / Sentinel với phần còn lại,
 *    đóng tập trung ở Pha 5 graceful shutdown.
 *  - CORS dùng chung whitelist ALLOWED_ORIGINS với HTTP (không bao giờ '*' kèm credentials).
 *  - REDIS_ENABLED=false → adapter in-memory mặc định (một instance).
 */
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RedisConnectionFactory } from '../../../core/redis/redis-connection.factory';
import { buildCorsConfig } from '../../../core/security/headers/security-headers.config';

export class RedisIoAdapter extends IoAdapter {
  private readonly adapterLogger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(
    app: INestApplicationContext,
    private readonly configService: AppConfigService,
    private readonly redisFactory: RedisConnectionFactory,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    if (!this.redisFactory.enabled) {
      this.adapterLogger.warn('REDIS_ENABLED=false: Socket.IO uses the in-memory adapter (single instance only).');
      return;
    }

    const pubClient = this.redisFactory.create('socketio-pub', 'pubsub');
    const subClient = this.redisFactory.duplicate(pubClient, 'socketio-sub');

    await Promise.all([
      this.redisFactory.waitUntilReady(pubClient, this.redisFactory.settings.connectTimeoutMs),
      this.redisFactory.waitUntilReady(subClient, this.redisFactory.settings.connectTimeoutMs),
    ]);

    this.adapterConstructor = createAdapter(pubClient, subClient, {
      key: `${this.configService.redis.keyPrefix}socket.io`,
    });
    this.adapterLogger.log(`Redis Socket.IO adapter configured for multi-pod broadcasting (${this.redisFactory.target}).`);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const cors = buildCorsConfig(this.configService.allowedOrigins);
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: cors.origin, credentials: true, methods: ['GET', 'POST'] },
    } as ServerOptions);

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
