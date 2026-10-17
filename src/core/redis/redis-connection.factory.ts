/**
 * Nhà máy kết nối Redis duy nhất của ứng dụng.
 * Mọi client (dùng chung, Socket.IO pub/sub, kết nối phụ) đều được tạo từ cùng một cấu hình
 * (TLS / IP family / Sentinel / timeout) và được đóng tập trung ở Pha 5 của Graceful Shutdown.
 */
import { Injectable, Logger } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import {
  buildRedisOptions,
  describeRedisTarget,
  RedisClientRole,
  RedisConnectionConfig,
} from '../config/resolvers/redis.resolver';

const ERROR_LOG_INTERVAL_MS = 30_000;
const QUIT_TIMEOUT_MS = 2_000;

@Injectable()
export class RedisConnectionFactory {
  private readonly logger = new Logger('Redis');
  private readonly clients = new Map<string, Redis>();

  constructor(private readonly config: AppConfigService) {}

  get settings(): RedisConnectionConfig {
    return this.config.redis;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get target(): string {
    return describeRedisTarget(this.settings);
  }

  /** ioredis options theo vai trò (dùng cho thư viện tự quản lý kết nối như BullMQ) */
  options(role: RedisClientRole, connectionName: string): RedisOptions {
    return buildRedisOptions(this.settings, role, `${this.config.app.name}:${connectionName}`);
  }

  /**
   * Tạo client mới và đăng ký vào danh sách đóng khi shutdown.
   * Tên client là duy nhất: tạo lại cùng tên sẽ trả về client cũ.
   */
  create(name: string, role: RedisClientRole): Redis {
    const existing = this.clients.get(name);
    if (existing) return existing;

    const client = new Redis(this.options(role, name));
    this.attachLogging(name, client);
    this.clients.set(name, client);
    return client;
  }

  /** Nhân bản client (Socket.IO subscriber) - vẫn được theo dõi để đóng khi shutdown */
  duplicate(source: Redis, name: string): Redis {
    const client = source.duplicate();
    this.attachLogging(name, client);
    this.clients.set(name, client);
    return client;
  }

  /** Chờ kết nối sẵn sàng (không ném lỗi): trả về false nếu quá hạn */
  async waitUntilReady(client: Redis, timeoutMs: number): Promise<boolean> {
    if (client.status === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        client.off('ready', onReady);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      client.once('ready', onReady);
    });
  }

  async closeAll(): Promise<void> {
    const entries = [...this.clients.entries()].reverse();
    this.clients.clear();
    await Promise.all(
      entries.map(async ([name, client]) => {
        if (client.status === 'end') return;
        try {
          await Promise.race([
            client.quit(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), QUIT_TIMEOUT_MS).unref()),
          ]);
        } catch {
          client.disconnect();
        }
        this.logger.log(`Redis client '${name}' closed`);
      }),
    );
  }

  private attachLogging(name: string, client: Redis): void {
    let lastErrorAt = 0;
    let lastMessage = '';

    client.on('ready', () => {
      lastMessage = '';
      this.logger.log(`Redis client '${name}' ready (${this.target})`);
    });

    // ioredis phát 'error' ở MỖI lần thử kết nối lại → giới hạn tần suất log để không làm ngập log shipper
    client.on('error', (err: Error) => {
      const now = Date.now();
      if (err.message !== lastMessage || now - lastErrorAt > ERROR_LOG_INTERVAL_MS) {
        lastErrorAt = now;
        lastMessage = err.message;
        this.logger.error(`Redis client '${name}' error (${this.target}): ${err.message}`);
      }
    });
  }
}
