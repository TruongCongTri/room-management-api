/**
 * Pha 2 Graceful Shutdown (PAUSE_CONSUMERS): dừng mọi cron / interval / timeout để Pod đang tắt
 * không khởi động tác vụ định kỳ mới trong lúc drain request và đóng kết nối.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ShutdownRegistry } from '../../../core/shutdown/shutdown.registry';
import { ShutdownPhase } from '../../../core/shutdown/shutdown.interface';

@Injectable()
export class ScheduleLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleLifecycleService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly shutdownRegistry: ShutdownRegistry,
  ) {}

  onModuleInit(): void {
    this.shutdownRegistry.register(
      'SchedulerStop',
      ShutdownPhase.PAUSE_CONSUMERS,
      () => {
        const cronJobs = this.schedulerRegistry.getCronJobs();
        cronJobs.forEach((job) => job.stop());
        this.schedulerRegistry.getIntervals().forEach((name) => this.schedulerRegistry.deleteInterval(name));
        this.schedulerRegistry.getTimeouts().forEach((name) => this.schedulerRegistry.deleteTimeout(name));
        this.logger.log(`[Shutdown] Stopped ${cronJobs.size} cron job(s), intervals and timeouts.`);
      },
      10,
    );
  }
}
