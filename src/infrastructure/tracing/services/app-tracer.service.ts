import { Injectable } from '@nestjs/common';
import {
  trace,
  Tracer,
  Span,
  SpanStatusCode,
  SpanOptions,
  context,
} from '@opentelemetry/api';
import { TRACER_NAME, SPAN_ATTRIBUTES } from '../constants/tracing.constants';
import { RequestContextService } from '../../../core/context/request-context.service';

@Injectable()
export class AppTracerService {
  private readonly tracer: Tracer;

  constructor(private readonly contextService: RequestContextService) {
    this.tracer = trace.getTracer(TRACER_NAME);
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  /**
   * Khởi tạo và bọc một khối logic bất đồng bộ vào một Trace Span có kiểm soát
   */
  async startActiveSpan<T>(
    spanName: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T> {
    return this.tracer.startActiveSpan(spanName, options || {}, async (span) => {
      // Đính kèm metadata ngữ cảnh
      const tenantId = this.contextService.getTenantId();
      const userId = this.contextService.getUserId();

      if (tenantId) span.setAttribute(SPAN_ATTRIBUTES.TENANT_ID, tenantId);
      if (userId) span.setAttribute(SPAN_ATTRIBUTES.USER_ID, userId);

      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: any) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error?.message || 'Execution failed',
        });
        span.setAttribute(SPAN_ATTRIBUTES.ERROR_TYPE, error?.name || 'Error');
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Lấy Trace ID và Span ID hiện tại
   */
  getCurrentSpanContext(): { traceId?: string; spanId?: string } {
    const activeSpan = trace.getSpan(context.active());
    if (!activeSpan) {
      return { traceId: this.contextService.getTraceId() };
    }
    const ctx = activeSpan.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    };
  }
}