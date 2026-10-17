/**
 * Kiểm thử với SDK OpenTelemetry thật (exporter in-memory) thay vì API no-op:
 *  - Span được tạo, đóng, ghi exception/status ERROR.
 *  - @TraceSpan hoạt động không cần inject service, giữ context cha qua await.
 *  - W3C traceparent được inject/extract đúng chuẩn và trace-id đồng nhất với RequestContext.
 */
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AppTracerService } from './services/app-tracer.service';
import { TracePropagatorService } from './services/trace-propagator.service';
import { TraceSpan } from './decorators/trace-span.decorator';
import { RequestContextService } from '../../core/context/request-context.service';
import { activeOtelTraceId } from '../../core/context/trace-id.util';

class EInvoiceAdapter {
  @TraceSpan('billing.calculateInvoice')
  async searchFares(fail = false) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (fail) throw new Error('PARTNER timeout');
    return ['VN123'];
  }
}

describe('TracingModule (OpenTelemetry Tracing Suite)', () => {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();
  let tracerService: AppTracerService;
  let propagator: TracePropagatorService;
  let contextService: RequestContextService;

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  afterAll(() => {
    trace.disable();
    propagation.disable();
    context.disable();
  });

  beforeEach(() => {
    exporter.reset();
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_sg');
    tracerService = new AppTracerService(contextService);
    propagator = new TracePropagatorService();
  });

  it('should execute operation inside an active span and return result', async () => {
    const result = await tracerService.startActiveSpan('activate_contract_operation', async (span) => {
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      return { success: true };
    });

    expect(result).toEqual({ success: true });
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('activate_contract_operation');
    expect(span.attributes['app.building_id']).toBe('tenant_sg');
  });

  it('should capture exception and record it into the active span before re-throwing', async () => {
    await expect(
      tracerService.startActiveSpan('failing_sql_operation', async () => {
        throw new Error('Database Deadlock');
      }),
    ).rejects.toThrow('Database Deadlock');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('@TraceSpan should create child spans without DI and always end them (also on error)', async () => {
    const adapter = new EInvoiceAdapter();

    await tracerService.startActiveSpan('http.request', async () => {
      await adapter.searchFares();
      await expect(adapter.searchFares(true)).rejects.toThrow('PARTNER timeout');
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'http.request')!;
    const children = spans.filter((s) => s.name === 'billing.calculateInvoice');
    expect(children).toHaveLength(2);
    children.forEach((child) => expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId));
    expect(children[1].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('should inject a valid W3C traceparent and extract it into a continued trace', async () => {
    await tracerService.startActiveSpan('outbound', async (span) => {
      const carrier = propagator.inject<Record<string, string>>({});
      expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(carrier.traceparent).toContain(span.spanContext().traceId);

      // Phía consumer (worker / service khác) tiếp tục cùng trace-id
      const continued = propagator.runWithExtractedContext(carrier, () =>
        trace.getTracer('consumer').startActiveSpan('consume', (child) => {
          child.end();
          return child.spanContext().traceId;
        }),
      );
      expect(continued).toBe(span.spanContext().traceId);
    });
  });

  it('should align RequestContext traceId with the active OpenTelemetry trace id', async () => {
    await tracerService.startActiveSpan('incoming', async (span) => {
      expect(activeOtelTraceId()).toBe(span.spanContext().traceId);
    });
    expect(activeOtelTraceId()).toBeUndefined();
  });
});

// npx jest src/infrastructure/tracing/tracing.spec.ts
