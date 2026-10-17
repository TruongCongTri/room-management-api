/**
 * Khởi động OpenTelemetry Tracing TRƯỚC khi NestJS, http, express, pg, ioredis được nạp
 * (import đầu tiên trong main.ts) để instrumentation kịp vá các module.
 *
 *  - Propagator W3C TraceContext + Baggage (header `traceparent` / `tracestate`).
 *  - Sampler ParentBased(TraceIdRatio): tôn trọng quyết định lấy mẫu của upstream.
 *  - Exporter OTLP/HTTP → Jaeger / Grafana Tempo / Datadog / Honeycomb / OTel Collector.
 *  - Bỏ qua span của /health và /metrics (probe/scrape định kỳ, chỉ gây nhiễu).
 *  - Tên span server được bổ sung route template (GET /api/v1/properties/rooms/:id) bởi RequestContextSyncInterceptor
 *    (NestJS 12 nạp Express dạng ESM nên instrumentation-express không vá được).
 *
 * Đọc trực tiếp process.env (sau khi nạp file .env) vì chạy trước AppConfigModule;
 * cùng các biến này được xác thực lại bởi env.schema khi ứng dụng boot.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { loadEnvFiles } from '../../core/config/env-loader';

const IGNORED_INCOMING_PATHS = /^\/(health|metrics)(\/|\?|$)/;
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', 'n', 'disabled', '']);

let tracerProvider: NodeTracerProvider | undefined;

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf('=');
        return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())];
      }),
  );
}

export function startTracing(): NodeTracerProvider | undefined {
  if (tracerProvider) return tracerProvider;

  loadEnvFiles();
  const enabled = !FALSE_VALUES.has((process.env.OTEL_ENABLED ?? 'false').trim().toLowerCase());
  if (!enabled) return undefined;

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '');
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_RATIO ?? '1');
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.APP_NAME || 'room-management-api';

  tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || process.env.npm_package_version || '0.0.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
        }),
      ),
    ],
  });

  // Đăng ký global: AsyncLocalStorage context manager + W3C TraceContext/Baggage propagator
  tracerProvider.register();

  registerInstrumentations({
    tracerProvider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => IGNORED_INCOMING_PATHS.test(request.url ?? ''),
      }),
      // requireParentSpan: chỉ trace query/lệnh phát sinh trong một request/job (bỏ qua health ping nền)
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });

  return tracerProvider;
}

export function getTracerProvider(): NodeTracerProvider | undefined {
  return tracerProvider;
}

/** Đẩy toàn bộ span còn trong buffer rồi tắt exporter (Pha 4 Graceful Shutdown) */
export async function shutdownTracing(): Promise<void> {
  if (!tracerProvider) return;
  await tracerProvider.forceFlush();
  await tracerProvider.shutdown();
  tracerProvider = undefined;
  trace.disable();
  propagation.disable();
  context.disable();
}
