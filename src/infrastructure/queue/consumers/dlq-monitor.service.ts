/**
 * Dead-Letter Queue: job kiệt sức retry (hoặc UnrecoverableError) được chuyển nguyên vẹn
 * (payload, metadata truy vết, stack trace, lý do) sang `<queueName>-dlq` để phân tích / retry thủ công.
 *
 * Được gọi từ sự kiện 'failed' CỤC BỘ của Worker (chỉ Pod đã xử lý job nhận được) thay vì QueueEvents
 * toàn cục (mọi Pod cùng nhận → chuyển DLQ trùng lặp). jobId DLQ cố định `<queue>:<jobId>` → idempotent.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { ConnectionOptions, Job, Queue } from 'bullmq';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RedisConnectionFactory } from '../../../core/redis/redis-connection.factory';
import { DLQ_SUFFIX } from '../constants/queue.constant';
import { DeadLetterRecord } from '../interfaces/queue.interface';

@Injectable()
export class DlqMonitorService implements OnApplicationShutdown {
  private readonly logger = new Logger(DlqMonitorService.name);
  /** DLQ của queue không đăng ký sẵn qua BullModule.registerQueue (tự tạo & tự đóng) */
  private readonly ownedQueues = new Map<string, Queue>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly redisFactory: RedisConnectionFactory,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Job đã hết lượt retry hay chưa (attemptsMade được BullMQ tăng sau mỗi lần thất bại)
   */
  isExhausted(job: Job, error?: Error): boolean {
    const maxAttempts = job.opts?.attempts ?? 1;
    return error?.name === 'UnrecoverableError' || job.attemptsMade >= maxAttempts;
  }

  async moveToDeadLetter(queueName: string, job: Job, error?: Error): Promise<void> {
    const dlq = this.getDeadLetterQueue(queueName);
    const record: DeadLetterRecord = {
      originalQueue: queueName,
      originalJobId: String(job.id),
      jobName: job.name,
      failedReason: error?.message ?? job.failedReason ?? 'unknown',
      stackTrace: job.stacktrace?.join('\n') || error?.stack,
      attemptsMade: job.attemptsMade,
      exhaustedAt: new Date().toISOString(),
      jobData: job.data,
    };

    await dlq.add(`dlq:${job.name}`, record, {
      jobId: `${queueName}:${job.id}`,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });

    this.logger.error(
      `[DLQ Alert] Job #${job.id} from '${queueName}' exhausted ${job.attemptsMade} attempt(s). ` +
        `Moved to '${dlq.name}'. Reason: ${record.failedReason} (traceId=${job.data?.metadata?.traceId ?? 'n/a'})`,
    );
  }

  getDeadLetterQueue(queueName: string): Queue {
    const dlqName = `${queueName}${DLQ_SUFFIX}`;
    try {
      return this.moduleRef.get<Queue>(getQueueToken(dlqName), { strict: false });
    } catch {
      let queue = this.ownedQueues.get(dlqName);
      if (!queue) {
        queue = new Queue(dlqName, {
          connection: this.redisFactory.options('bullmq', `dlq:${dlqName}`) as ConnectionOptions,
          prefix: this.config.queue.prefix,
        });
        this.ownedQueues.set(dlqName, queue);
      }
      return queue;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.ownedQueues.values()].map((queue) => queue.close().catch(() => undefined)));
    this.ownedQueues.clear();
  }
}
