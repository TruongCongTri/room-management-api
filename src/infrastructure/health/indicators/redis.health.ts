/**
 * Kiểm tra phản hồi sống còn của máy chủ Redis thông qua lệnh PING (kèm đo độ trễ).
 * REDIS_ENABLED=false (dev/test) → báo 'up' kèm mode=disabled để readiness không chặn traffic.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../core/redis/redis.constants';

const PING_TIMEOUT_MS = 2000;

@Injectable()
export class RedisHealthIndicator {
  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    if (!this.redis) {
      return { [key]: { status: 'up', mode: 'disabled' } };
    }

    const startTime = Date.now();
    try {
      if (this.redis.status !== 'ready') {
        throw new Error(`Redis connection is '${this.redis.status}'`);
      }

      const response = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`PING timed out after ${PING_TIMEOUT_MS}ms`)), PING_TIMEOUT_MS).unref(),
        ),
      ]);
      if (response !== 'PONG') {
        throw new Error(`Unexpected Redis PING response: '${response}'`);
      }

      return { [key]: { status: 'up', latencyMs: Date.now() - startTime } };
    } catch (err: any) {
      return {
        [key]: { status: 'down', message: err.message, latencyMs: Date.now() - startTime },
      };
    }
  }
}
