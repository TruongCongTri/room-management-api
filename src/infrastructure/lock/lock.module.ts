import { Global, Module } from '@nestjs/common';
import { DistributedLockService } from './services/distributed-lock.service';

@Global()
@Module({
  providers: [DistributedLockService],
  exports: [DistributedLockService],
})
export class DistributedLockModule {}