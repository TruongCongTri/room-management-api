/**
 * Khai báo các tham số cấu hình vòng đời của khóa:
 *
 * */

export interface LockOptions {
  /**
   * Thời gian sống tối đa của lock (TTL tính bằng mili-giây). Mặc định: LOCK_DEFAULT_TTL_MS
   */
  ttlMs?: number;

  /**
   * Số lần thử lại tối đa nếu lock đang bị giữ bởi tiến trình khác. Mặc định: LOCK_RETRY_COUNT
   */
  retryCount?: number;

  /**
   * Thời gian chờ cơ sở giữa các lần thử lại (mili-giây), tăng lũy thừa kèm Full Jitter.
   * Mặc định: LOCK_RETRY_DELAY_MS
   */
  retryDelayMs?: number;

  /**
   * Tự động bật Watchdog để gia hạn TTL định kỳ (mỗi 50% TTL) khi tác vụ chạy lâu
   * Mặc định: false
   */
  autoRenew?: boolean;
}

export interface LockReleaseOptions {
  /**
   * Giữ khóa tối thiểu N mili-giây tính từ lúc lấy khóa (chống chạy lặp do lệch đồng hồ giữa các Pod
   * khi tác vụ hoàn thành quá nhanh). Khóa tự hết hạn thay vì bị xóa ngay.
   */
  minHoldMs?: number;
}

export interface LockHandle {
  key: string;
  token: string;
  ttlMs: number;
  acquiredAt: number;
  /** true khi watchdog không gia hạn được (khóa đã hết hạn và có thể đã thuộc về tiến trình khác) */
  lost?: boolean;
  /** Bị abort khi mất khóa: tác vụ dài nên kiểm tra signal.aborted để dừng an toàn */
  signal?: AbortSignal;
}
