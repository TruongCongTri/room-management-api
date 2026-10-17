/**
 * Đăng ký cron có biểu thức lấy từ CẤU HÌNH (OUTBOX_CLEANUP_CRON, AUDIT_TIERING_CRON...) - điều mà decorator
 * tĩnh @Cron() không làm được - với cùng cơ chế khóa phân tán / ngữ cảnh hệ thống như @DistributedCron.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DistributedLockService } from '../../lock/services/distributed-lock.service';
import {
  DistributedJobOptions,
  resolveMinHoldMs,
  runDistributedJob,
} from './distributed-job.runner';

@Injectable()
export class DistributedCronRegistrar {
  private readonly logger = new Logger(DistributedCronRegistrar.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly lockService: DistributedLockService,
  ) {}

  register(
    name: string,
    cronExpression: string,
    task: () => Promise<unknown> | unknown,
    options: DistributedJobOptions = {},
  ): void {
    const minHoldMs = resolveMinHoldMs(cronExpression, options);
    const job = CronJob.from({
      cronTime: cronExpression,
      onTick: () =>
        runDistributedJob(name, task, { ttlMs: options.ttlMs, minHoldMs }, this.lockService),
      start: false,
      waitForCompletion: true, // không chạy chồng tick mới khi tick trước chưa xong trong cùng Pod
    });

    this.schedulerRegistry.addCronJob(name, job);
    job.start();
    this.logger.log(`Registered distributed cron '${name}' (${cronExpression})`);
  }
}
