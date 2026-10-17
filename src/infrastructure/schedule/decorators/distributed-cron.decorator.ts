import { applyDecorators } from '@nestjs/common';
import { Cron, CronOptions } from '@nestjs/schedule';
import { DistributedLockService } from '../../lock/services/distributed-lock.service';
import {
  DistributedJobOptions,
  resolveMinHoldMs,
  runDistributedJob,
} from '../services/distributed-job.runner';

export type DistributedCronOptions = CronOptions & DistributedJobOptions;

/**
 * Decorator kết hợp @Cron của NestJS với Khóa phân tán (Redis):
 * đảm bảo chỉ duy nhất 1 Pod thực thi tác vụ khi triển khai cụm nhiều Pod.
 * Không bắt buộc inject `lockService`: dùng instance toàn cục của DistributedLockService.
 *
 * @example
 * const { cron, lockKey, timeZone, ttlMs } = RENTAL_SCHEDULES.MONTHLY_BILLING;
 * @DistributedCron(cron, lockKey, { timeZone, ttlMs })
 * async runMonthlyBilling() { ... }
 */
export function DistributedCron(
  cronTime: string | Date,
  lockKey: string,
  options: DistributedCronOptions = {},
) {
  const minHoldMs = resolveMinHoldMs(cronTime, options);

  return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const lockService: DistributedLockService | undefined =
        (this as any).lockService ?? DistributedLockService.getInstance();
      return runDistributedJob(
        lockKey,
        () => originalMethod.apply(this, args),
        { ttlMs: options.ttlMs, minHoldMs },
        lockService,
      );
    };

    // Áp dụng cron schedule gốc của NestJS (đặt tên mặc định theo lockKey để quản trị qua SchedulerRegistry)
    return applyDecorators(Cron(cronTime, { name: lockKey, ...options }))(_target, propertyKey, descriptor);
  };
}
