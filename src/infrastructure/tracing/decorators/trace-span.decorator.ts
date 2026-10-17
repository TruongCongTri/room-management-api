import { Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SPAN_ATTRIBUTES, TRACER_NAME } from '../constants/tracing.constants';
import { RequestContextService } from '../../../core/context/request-context.service';

/**
 * Method decorator tạo span con cho hàm (sync hoặc async): tự ghi thời gian, gắn tenant/user,
 * ghi nhận exception (status ERROR) và LUÔN đóng span. Không cần inject AppTracerService.
 * Khi OTEL_ENABLED=false, API OpenTelemetry là no-op (chi phí gần như bằng 0).
 *
 * @example
 * @TraceSpan('billing.checkout.settle')
 * async executeCheckout(dto: CheckoutDto) { ... }
 */
export function TraceSpan(customSpanName?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const spanName = customSpanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = function (this: unknown, ...args: any[]) {
      const tracer = trace.getTracer(TRACER_NAME);
      return tracer.startActiveSpan(spanName, (span: Span) => {
        const store = RequestContextService.current();
        const tenantId = store?.tenantOverride ?? store?.user?.tenantId;
        if (tenantId) span.setAttribute(SPAN_ATTRIBUTES.TENANT_ID, tenantId);
        if (store?.user?.id) span.setAttribute(SPAN_ATTRIBUTES.USER_ID, store.user.id);

        const fail = (error: any) => {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message || 'Execution failed' });
          span.setAttribute(SPAN_ATTRIBUTES.ERROR_TYPE, error?.name || 'Error');
          span.end();
        };

        try {
          const result = originalMethod.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then(
              (value: unknown) => {
                span.end();
                return value;
              },
              (error: unknown) => {
                fail(error);
                throw error;
              },
            );
          }
          span.end();
          return result;
        } catch (error) {
          fail(error);
          throw error;
        }
      });
    };

    // Giữ metadata của decorator khác (vd: @OnEvent, @Cron) đã gắn lên method gốc
    for (const key of Reflect.getMetadataKeys(originalMethod)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, originalMethod), descriptor.value);
    }
    return descriptor;
  };
}
