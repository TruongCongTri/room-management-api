import { Global, Module } from '@nestjs/common';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { DistributedCronRegistrar } from './services/distributed-cron.registrar';
import { ScheduleLifecycleService } from './services/schedule-lifecycle.service';

@Global()
@Module({
  imports: [NestScheduleModule.forRoot()],
  providers: [DistributedCronRegistrar, ScheduleLifecycleService],
  exports: [NestScheduleModule, DistributedCronRegistrar],
})
export class AppScheduleModule {}
