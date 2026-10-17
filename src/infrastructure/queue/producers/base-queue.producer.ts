/**
 * Producer trừu tượng:
 *  Tự động trích xuất ngữ cảnh thực thi (traceId, tenantId, actorId, W3C traceparent) từ RequestContextService
 *  để gắn vào payload mà không cần lập trình viên phải truyền thủ công.
 *  Retry/backoff mặc định lấy từ cấu hình BullModule (QUEUE_DEFAULT_ATTEMPTS, QUEUE_BACKOFF_DELAY_MS).
 */

import { Queue, JobsOptions } from 'bullmq';
import { context as otelContext, propagation } from '@opentelemetry/api';
import { RequestContextService } from '../../../core/context/request-context.service';
import { EnvelopedJobPayload } from '../interfaces/queue.interface';

export abstract class BaseQueueProducer<T = any> {
  constructor(
    protected readonly queue: Queue,
    protected readonly contextService: RequestContextService,
  ) {}

  /**
   * Đẩy job vào hàng đợi kèm theo toàn bộ Metadata phân tán.
   * Truyền options.jobId (vd: id nghiệp vụ) để BullMQ tự loại bỏ job trùng lặp.
   */
  async addJob(jobName: string, data: T, options?: JobsOptions): Promise<string> {
    const currentUser = this.contextService.getCurrentUser();
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);

    const envelopedData: EnvelopedJobPayload<T> = {
      metadata: {
        traceId: this.contextService.getTraceId(),
        tenantId: this.contextService.getTenantId() || 'global',
        actorId: this.contextService.getUserId(),
        actorEmail: currentUser?.email,
        locale: this.contextService.getLocale(),
        enqueuedAt: new Date().toISOString(),
        traceparent: carrier.traceparent,
        tracestate: carrier.tracestate,
      },
      payload: data,
    };

    const job = await this.queue.add(jobName, envelopedData, options);
    return String(job.id);
  }
}
