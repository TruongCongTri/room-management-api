/**
 * 3 tầng Rate Limit nghiệp vụ. Mỗi route chỉ thuộc DUY NHẤT một tầng
 * (mặc định PUBLIC); giới hạn cụ thể lấy từ cấu hình (THROTTLE_*).
 */
export const THROTTLE_TIERS = {
  // 1. API công khai (Public): mặc định 60 request / 60 giây
  PUBLIC: 'public',
  // 2. API tra cứu giá (Search / Pricing): mặc định 100 request / 60 giây
  SEARCH: 'search',
  // 3. API nhạy cảm chống Brute-Force (Login, OTP, Payment): mặc định 5 request / 60 giây
  SENSITIVE: 'sensitive',
  // 4. Hạ tầng nội bộ (health probe của kubelet, Prometheus scraper): bỏ qua mọi tầng
  NONE: 'none',
} as const;

export type ThrottleTier = (typeof THROTTLE_TIERS)[keyof typeof THROTTLE_TIERS];

export const THROTTLE_TIER_METADATA = 'security:throttle_tier';
