/**
 * Quy chuẩn hóa danh mục metric và ngưỡng buckets theo tiêu chuẩn quốc tế:
 *
 */

export const METRICS_METER_NAME = 'room-management-api';

export const METRIC_NAMES = {
  HTTP_REQUEST_DURATION_SECONDS: 'http_request_duration_seconds',
  HTTP_REQUESTS_TOTAL: 'http_requests_total',
  HTTP_ACTIVE_REQUESTS: 'http_active_requests',
  DB_QUERY_DURATION_SECONDS: 'db_query_duration_seconds',
  DB_POOL_CONNECTIONS: 'db_pool_connections',
  EVENT_LOOP_LAG_SECONDS: 'nodejs_eventloop_lag_seconds',
  HEAP_USED_BYTES: 'nodejs_heap_used_bytes',
  HEAP_TOTAL_BYTES: 'nodejs_heap_total_bytes',
  EXTERNAL_MEMORY_BYTES: 'nodejs_external_memory_bytes',
  RESIDENT_MEMORY_BYTES: 'process_resident_memory_bytes',
  CPU_SECONDS_TOTAL: 'process_cpu_seconds_total',
  GC_DURATION_SECONDS: 'nodejs_gc_duration_seconds',
  CIRCUIT_BREAKER_STATE: 'circuit_breaker_state',
  BULKHEAD_ACTIVE: 'bulkhead_active_executions',
  BULKHEAD_QUEUED: 'bulkhead_queued_executions',

  // Business metrics của nền tảng cho thuê
  CONTRACTS_ACTIVATED_TOTAL: 'rental_contracts_activated_total',
  METER_READINGS_TOTAL: 'rental_meter_readings_total',
  INVOICES_GENERATED_TOTAL: 'rental_invoices_generated_total',
  CHECKOUTS_SETTLED_TOTAL: 'rental_checkouts_settled_total',
  DOCUMENT_RENDER_DURATION_SECONDS: 'document_render_duration_seconds',
} as const;

/** Buckets độ trễ (GIÂY): 5ms → 10s, đủ phân giải p95/p99 cho API và lời gọi đối tác */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Buckets thời gian GC (GIÂY): 1ms → 1s */
export const GC_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

/** Nhãn route cho request không khớp handler nào (404) - chống bùng nổ cardinality từ bot quét URL */
export const UNMATCHED_ROUTE = 'UNMATCHED';

/** Không ghi metric HTTP cho chính endpoint hạ tầng (probe mỗi vài giây, Prometheus scrape) */
export const METRICS_IGNORED_PATHS = [/^\/health(\/|$)/, /^\/metrics(\/|$)/];
