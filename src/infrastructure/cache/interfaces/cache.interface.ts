/**
 * Khai báo tham số điều khiển bộ nhớ đệm, thuật toán chống sập và gắn thẻ:   
 * 
 * */ 
export interface CacheSetOptions {
  ttlSeconds?: number;
  tags?: string[];
  /**
   * Thời gian tính toán để lấy dữ liệu gốc (mili-giây) - dùng cho thuật toán XFetch
   */
  computeDeltaMs?: number;
}

export interface CachedEnvelope<T> {
  value: T;
  /**
   * Thời điểm hết hạn tuyệt đối (Epoch timestamp tính bằng mili-giây)
   */
  expiresAt: number;
  /**
   * Thời gian thực thi tạo ra dữ liệu này (mili-giây)
   */
  delta: number;
}