export interface BulkheadOptions {
  maxConcurrent: number; // Số request tối đa được phép gọi đồng thời sang đối tác này
  maxQueue?: number; // Số request tối đa được xếp hàng chờ (vượt quá sẽ reject fail-fast)
  queueTimeoutMs?: number; // Thời gian chờ slot tối đa trong hàng đợi
}

export interface RetryOptions {
  maxAttempts: number; // Tổng số lần gọi tối đa (bao gồm lần đầu), ví dụ: 3
  delayMs: number; // Khoảng thời gian cơ sở (ví dụ: 200ms)
  backoffMultiplier?: number; // Hệ số nhân lũy thừa (ví dụ: 2)
  maxDelayMs?: number; // Thời gian chờ tối đa giữa các lần thử (ví dụ: 3000ms)
  /**
   * Chỉ retry lỗi tạm thời. Mặc định: không retry lỗi 4xx (lỗi nghiệp vụ / dữ liệu client).
   */
  retryOn?: (error: unknown) => boolean;
}

export interface CircuitBreakerOptions {
  timeout?: number; // Timeout cho mỗi lần gọi (mili-giây)
  errorThresholdPercentage?: number; // Tỷ lệ lỗi kích hoạt ngắt mạch (%)
  resetTimeout?: number; // Thời gian chờ ở trạng thái OPEN trước khi thử lại (mili-giây)
  volumeThreshold?: number; // Số request tối thiểu trước khi tính toán tỷ lệ lỗi
}

/**
 * Lưu ý: cấu hình circuitBreaker/bulkhead được cố định ở lần gọi ĐẦU TIÊN cho mỗi serviceName.
 */
export interface ResiliencePolicyOptions {
  circuitBreaker?: CircuitBreakerOptions;
  bulkhead?: BulkheadOptions;
  retry?: RetryOptions;
}

export type CircuitState = 'OPEN' | 'HALF_OPEN' | 'CLOSED';

export interface BreakerMetrics {
  name: string;
  state: CircuitState;
  activeExecutions: number;
  queuedExecutions: number;
  stats: {
    failures: number;
    successes: number;
    timeouts: number;
    rejects: number;
    fallbacks: number;
  };
}
