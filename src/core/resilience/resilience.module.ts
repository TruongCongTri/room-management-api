import { Global, Module } from '@nestjs/common';
import { ResilienceService } from './resilience.service';

@Global()
@Module({
  providers: [ResilienceService],
  exports: [ResilienceService],
})
export class ResilienceModule {}
