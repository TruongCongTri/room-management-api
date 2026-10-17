/**
 * Tập hợp danh mục Header dùng xuyên suốt tầng Gateway, Middleware, Interceptors và HttpClient
 * 
 * */

export const SYSTEM_HEADERS = {
  // Distributed Tracing
  TRACE_ID: 'x-trace-id',
  CORRELATION_ID: 'x-correlation-id',
  REQUEST_ID: 'x-request-id',

  // Multi-Tenancy & Access Context: phạm vi cô lập dữ liệu là TÒA NHÀ (building_id)
  BUILDING_ID: 'x-building-id',
  DEPARTMENT_ID: 'x-department-id',

  // Security & Idempotency
  IDEMPOTENCY_KEY: 'idempotency-key',
  API_KEY: 'x-api-key',

  // Performance & Caching
  CACHE_LOOKUP: 'x-cache-lookup',
  RESPONSE_TIME: 'x-response-time-ms',

  // Internationalization
  ACCEPT_LANGUAGE: 'accept-language',
} as const;
