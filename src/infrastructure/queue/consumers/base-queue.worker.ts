/**
 * WorkerHost nền tảng: Bọc logic xử lý bằng RequestContextService.runWithContext() và một span OpenTelemetry
 * nối tiếp traceparent của request gốc. Mọi dòng log hay truy vấn RlsService bên trong Worker đều có đầy đủ
 * ngữ cảnh traceId và tenantId như một HTTP request thông thường.
 *
 * Tạm dừng khi shutdown (Pha 2) và chuyển job kiệt sức sang DLQ được QueueLifecycleService xử lý
 * tự động cho MỌI WorkerHost, không cần code trong lớp con.
 */

import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace } from '@opentelemetry/api';
import { RequestContextService } from '../../../core/context/request-context.service';
import { EnvelopedJobPayload } from '../interfaces/queue.interface';
import { TRACER_NAME } from '../../tracing/constants/tracing.constants';

export abstract class BaseQueueWorker<T = any> extends WorkerHost {
  protected readonly workerLogger = new Logger(this.constructor.name);

  constructor(protected readonly contextService: RequestContextService) {
    super();
  }

  async process(job: Job<EnvelopedJobPayload<T>>): Promise<any> {
    const { metadata, payload } = job.data;

    // Nối span của worker vào trace gốc (no-op khi OTEL_ENABLED=false)
    const parentContext = metadata?.traceparent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: metadata.traceparent, tracestate: metadata.tracestate })
      : ROOT_CONTEXT;
    const tracer = trace.getTracer(TRACER_NAME);

    return tracer.startActiveSpan(
      `queue.process ${job.queueName ?? 'queue'}:${job.name}`,
      { kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'bullmq', 'messaging.message.id': String(job.id) } },
      parentContext,
      async (span) => {
        try {
          // Phục hồi ngữ cảnh thread-local hoàn chỉnh cho tác vụ nền
          return await this.contextService.runWithContext(
            {
              traceId: metadata?.traceId || `job-${job.id}`,
              tenantId: metadata?.tenantId && metadata.tenantId !== 'global' ? metadata.tenantId : undefined,
              locale: metadata?.locale,
              user: metadata?.actorId
                ? {
                    id: metadata.actorId,
                    email: metadata.actorEmail || `${metadata.actorId}@worker.system`,
                    roles: ['BACKGROUND_WORKER'],
                    rules: [],
                  }
                : undefined,
            },
            async () => {
              this.workerLogger.log(
                `[QueueWorker] Processing job #${job.id} [${job.name}] (Attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1})...`,
              );
              return this.handleJob(payload, job);
            },
          );
        } catch (err: any) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Phương thức nghiệp vụ cốt lõi mà các Consumer cụ thể cần cài đặt
   */
  abstract handleJob(payload: T, rawJob: Job<EnvelopedJobPayload<T>>): Promise<any>;
}
