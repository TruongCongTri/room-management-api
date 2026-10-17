/**
 * PHẢI là import đầu tiên của main.ts: OpenTelemetry cần vá http / express / pg / ioredis
 * TRƯỚC khi các module này được nạp (no-op khi OTEL_ENABLED=false).
 */
import { startTracing } from './infrastructure/tracing/otel.bootstrap';

startTracing();
