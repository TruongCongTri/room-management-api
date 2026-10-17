/**
 * Worker của hàng đợi webhook-dispatch: mỗi lần thử gửi một lần (không retry lồng trong HTTP client),
 * thất bại → ném lỗi để BullMQ lên lịch retry theo backoff; kiệt sức → DLQ (QueueLifecycleService).
 */
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseQueueWorker } from '../../queue/consumers/base-queue.worker';
import { EnvelopedJobPayload } from '../../queue/interfaces/queue.interface';
import { QUEUE_NAMES } from '../../queue/constants/queue.constant';
import { RequestContextService } from '../../../core/context/request-context.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDispatchJob } from '../interfaces/webhook.interface';

@Processor(QUEUE_NAMES.WEBHOOK_DISPATCH, { concurrency: 10 })
export class WebhookDispatchWorker extends BaseQueueWorker<WebhookDispatchJob> {
  constructor(
    contextService: RequestContextService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {
    super(contextService);
  }

  async handleJob(job: WebhookDispatchJob, rawJob: Job<EnvelopedJobPayload<WebhookDispatchJob>>): Promise<unknown> {
    const result = await this.dispatcher.dispatch(job.payload, { ...job.options, maxRetries: 0 });
    if (!result.success) {
      throw new Error(
        `Webhook ${job.payload.id} to ${job.options.url} failed (attempt ${rawJob.attemptsMade + 1}): ${result.error}`,
      );
    }
    return result;
  }
}
