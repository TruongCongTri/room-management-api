import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { context as otelContext, isSpanContextValid, trace } from '@opentelemetry/api';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const INCOMING_TRACE_HEADERS = [CORRELATION_ID_HEADER, 'x-request-id', 'x-trace-id'] as const;

/** Chỉ chấp nhận trace id ngắn, an toàn: chống log injection / header injection */
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** W3C Trace Context: version-traceid(32 hex)-parentid(16 hex)-flags */
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
const INVALID_W3C_TRACE_ID = '0'.repeat(32);
const TRACE_ID_SYMBOL = Symbol.for('app.traceId');

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Trace ID của span OpenTelemetry đang hoạt động (do HTTP instrumentation tạo từ `traceparent`
 * hoặc khởi tạo mới). Trả về undefined khi tracing tắt (API no-op).
 */
export function activeOtelTraceId(): string | undefined {
  const spanContext = trace.getSpan(otelContext.active())?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

/**
 * Nguồn duy nhất xác định traceId cho một request.
 * Thứ tự ưu tiên để log và distributed trace luôn dùng CHUNG một id:
 *   1. Trace ID của span OpenTelemetry đang hoạt động (khi OTEL_ENABLED=true)
 *   2. trace-id trong header W3C `traceparent` của upstream
 *   3. x-correlation-id / x-request-id / x-trace-id hợp lệ
 *   4. UUID mới
 * Được memo trên request object để RequestContextMiddleware và pino-http (genReqId)
 * luôn dùng cùng một giá trị bất kể middleware nào chạy trước.
 */
export function resolveTraceId(req: IncomingMessage, res?: ServerResponse): string {
  const memo = (req as any)[TRACE_ID_SYMBOL] as string | undefined;
  if (memo) return memo;

  let traceId = activeOtelTraceId();

  if (!traceId) {
    const traceparent = TRACEPARENT.exec(headerValue(req, 'traceparent')?.trim().toLowerCase() ?? '');
    if (traceparent && traceparent[1] !== INVALID_W3C_TRACE_ID) {
      traceId = traceparent[1];
    }
  }

  if (!traceId) {
    for (const header of INCOMING_TRACE_HEADERS) {
      const value = headerValue(req, header);
      if (value && SAFE_TRACE_ID.test(value)) {
        traceId = value;
        break;
      }
    }
  }

  traceId ??= randomUUID();

  (req as any)[TRACE_ID_SYMBOL] = traceId;
  if (res && !res.headersSent) {
    res.setHeader(CORRELATION_ID_HEADER, traceId);
  }
  return traceId;
}

/** Trace ID đã phân giải cho request (không tạo mới) */
export function getResolvedTraceId(req: unknown): string | undefined {
  return (req as any)?.[TRACE_ID_SYMBOL];
}
