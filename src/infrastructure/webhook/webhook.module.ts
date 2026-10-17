import { Global, Module } from '@nestjs/common';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WebhookDispatchWorker } from './services/webhook-dispatch.worker';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';

/**
 * WebhookDispatchWorker chỉ thực sự tạo BullMQ Worker khi QueueModule được nạp (REDIS_ENABLED=true);
 * ngược lại nó chỉ là provider thường và dispatchReliable() tự chuyển sang gửi đồng bộ.
 */
@Global()
@Module({
  providers: [WebhookDispatcherService, WebhookSignatureGuard, WebhookDispatchWorker],
  exports: [WebhookDispatcherService, WebhookSignatureGuard],
})
export class WebhookModule {}
