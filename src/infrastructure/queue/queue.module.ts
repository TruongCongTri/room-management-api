/**
 * Khởi tạo BullMQ trên CÙNG cấu hình mạng Redis của ứng dụng (TLS / IP family / Sentinel) qua
 * RedisConnectionFactory, tách namespace bằng QUEUE_PREFIX (BullMQ không cho phép keyPrefix của ioredis).
 *
 * Module chỉ được nạp khi REDIS_ENABLED=true (ConditionalModule trong InfrastructureModule).
 */

import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import type { ConnectionOptions } from 'bullmq';
import { AppConfigService } from '../../core/config/app-config.service';
import { RedisConnectionFactory } from '../../core/redis/redis-connection.factory';
import { DlqMonitorService } from './consumers/dlq-monitor.service';
import { QueueLifecycleService } from './consumers/queue-lifecycle.service';
import { DLQ_SUFFIX, FAILED_JOB_RETENTION_SECONDS, QUEUE_NAMES } from './constants/queue.constant';

const QUEUE_REGISTRATIONS = Object.values(QUEUE_NAMES).flatMap((name) => [
  { name },
  { name: `${name}${DLQ_SUFFIX}` },
]);

@Global()
@Module({
  imports: [
    DiscoveryModule,
    BullModule.forRootAsync({
      inject: [RedisConnectionFactory, AppConfigService],
      useFactory: (redisFactory: RedisConnectionFactory, config: AppConfigService) => {
        const queue = config.queue;
        return {
          // BullMQ chuyển nguyên options này cho ioredis khi tạo kết nối Queue/Worker/QueueEvents
          connection: redisFactory.options('bullmq', 'bullmq') as ConnectionOptions,
          prefix: queue.prefix,
          defaultJobOptions: {
            attempts: queue.defaultAttempts,
            // Exponential backoff kèm jitter: tránh các job cùng retry đồng loạt (Thundering Herd)
            backoff: { type: 'exponential', delay: queue.backoffDelayMs, jitter: 1 },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
          },
        };
      },
    }),
    BullModule.registerQueue(...QUEUE_REGISTRATIONS),
  ],
  providers: [DlqMonitorService, QueueLifecycleService],
  exports: [BullModule, DlqMonitorService],
})
export class QueueModule {}
