import { Injectable } from '@nestjs/common';
import { context, Context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

/**
 * Inject / Extract ngữ cảnh W3C (traceparent, tracestate, baggage) cho kênh truyền không phải HTTP tự động
 * (message queue, webhook tự viết, gRPC metadata...). HTTP ra ngoài qua AppHttpClient đã tự inject.
 */
@Injectable()
export class TracePropagatorService {
  /**
   * Inject W3C Traceparent vào carrier (header của request gọi đi hoặc metadata của job)
   */
  inject<T extends Record<string, any>>(carrier: T): T {
    propagation.inject(context.active(), carrier);
    return carrier;
  }

  /**
   * Trích xuất ngữ cảnh phân tán từ carrier gửi đến (bắt đầu từ ROOT để không dính trace đang chạy)
   */
  extract(carrier: Record<string, any>): Context {
    return propagation.extract(ROOT_CONTEXT, carrier);
  }

  /** Chạy fn bên trong ngữ cảnh đã trích xuất (span con sẽ nối vào trace của upstream) */
  runWithExtractedContext<T>(carrier: Record<string, any>, fn: () => T): T {
    return context.with(this.extract(carrier), fn);
  }
}
