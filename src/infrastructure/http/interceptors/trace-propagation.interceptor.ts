/**
 * Lan truyền ngữ cảnh truy vết sang API đối tác:
 *  - x-trace-id / x-correlation-id / x-building-id từ RequestContextService (đối tác log cùng mã đối soát).
 *  - W3C traceparent / tracestate (OpenTelemetry) để chuỗi span không bị đứt gãy giữa các hệ thống.
 */
import { InternalAxiosRequestConfig } from 'axios';
import { context as otelContext, propagation } from '@opentelemetry/api';
import { RequestContextService } from '../../../core/context/request-context.service';
import { SYSTEM_HEADERS } from '../../../common/constants/headers.constant';

export function createTracePropagationInterceptor(contextService: RequestContextService) {
  return (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    const traceId = contextService.getTraceId();
    const tenantId = contextService.getTenantId();

    if (traceId) {
      config.headers.set(SYSTEM_HEADERS.TRACE_ID, traceId);
      config.headers.set(SYSTEM_HEADERS.CORRELATION_ID, traceId);
    }
    if (tenantId) {
      config.headers.set(SYSTEM_HEADERS.BUILDING_ID, tenantId);
    }

    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    for (const [key, value] of Object.entries(carrier)) {
      config.headers.set(key, value);
    }
    return config;
  };
}
