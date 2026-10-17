/**
 * Nhóm biến: Health probes, Prometheus metrics và OpenTelemetry tracing.
 * Các biến OTEL_* theo đúng tên chuẩn của OpenTelemetry SDK.
 */
import { z } from 'zod';
import {
  addIssue,
  envBool,
  envInt,
  envNumber,
  envOptionalString,
  envString,
  parseUrlSafe,
  ZodRefineCtx,
} from './env.helpers';

export const observabilityEnvShape = {
  // Health probes (K8s liveness/readiness)
  HEALTH_HEAP_LIMIT_MB: envInt(1024, 64),
  HEALTH_RSS_LIMIT_MB: envInt(1536, 64),
  // Bỏ trống: '/' trên Linux/macOS, ổ hệ thống (C:\) trên Windows
  HEALTH_DISK_PATH: envOptionalString(),
  HEALTH_DISK_THRESHOLD_PERCENT: envNumber(0.95, 0.1, 1),

  // Prometheus scrape endpoint
  METRICS_ENABLED: envBool(true),
  // Bảo vệ /metrics khi cổng HTTP lộ ra Internet (Prometheus gửi "Authorization: Bearer <token>")
  METRICS_BEARER_TOKEN: envOptionalString(),

  // OpenTelemetry distributed tracing (OTLP/HTTP → Jaeger / Tempo / Datadog / Honeycomb...)
  OTEL_ENABLED: envBool(false),
  OTEL_SERVICE_NAME: envOptionalString(),
  OTEL_EXPORTER_OTLP_ENDPOINT: envString('http://localhost:4318'),
  // "key1=value1,key2=value2" (vd: API key của nhà cung cấp APM)
  OTEL_EXPORTER_OTLP_HEADERS: envOptionalString(),
  OTEL_TRACES_SAMPLER_RATIO: envNumber(1, 0, 1),
};

type ObservabilityEnv = z.infer<z.ZodObject<typeof observabilityEnvShape>>;

export function refineObservabilityEnv(env: ObservabilityEnv, ctx: ZodRefineCtx): void {
  if (env.OTEL_ENABLED) {
    const url = parseUrlSafe(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      addIssue(ctx, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL');
    }
  }

  if (env.OTEL_EXPORTER_OTLP_HEADERS) {
    const valid = env.OTEL_EXPORTER_OTLP_HEADERS.split(',').every((pair) => /^[^=\s]+=.+$/.test(pair.trim()));
    if (!valid) {
      addIssue(ctx, 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS must look like "key1=value1,key2=value2"');
    }
  }
}
