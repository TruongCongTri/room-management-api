import { SetMetadata, ExecutionContext } from '@nestjs/common';
import { THROTTLE_TIERS, THROTTLE_TIER_METADATA, ThrottleTier } from './throttler.constants';

/**
 * Tầng throttling hiệu lực của route (method ghi đè class, mặc định PUBLIC)
 */
export function resolveThrottleTier(context: ExecutionContext): ThrottleTier {
  return (
    Reflect.getMetadata(THROTTLE_TIER_METADATA, context.getHandler()) ??
    Reflect.getMetadata(THROTTLE_TIER_METADATA, context.getClass()) ??
    THROTTLE_TIERS.PUBLIC
  );
}

/**
 * Giới hạn THROTTLE_LIMIT req/cửa sổ cho các API công khai (mặc định cho mọi route)
 */
export const ThrottlePublic = () => SetMetadata(THROTTLE_TIER_METADATA, THROTTLE_TIERS.PUBLIC);

/**
 * Giới hạn THROTTLE_SEARCH_LIMIT req/cửa sổ cho API tra cứu chuyến bay, phòng khách sạn, giá vé
 */
export const ThrottleSearch = () => SetMetadata(THROTTLE_TIER_METADATA, THROTTLE_TIERS.SEARCH);

/**
 * Giới hạn nghiêm ngặt THROTTLE_SENSITIVE_LIMIT req/cửa sổ chống brute-force cho Login, Đổi mật khẩu, Gửi OTP
 */
export const ThrottleSensitive = () =>
  SetMetadata(THROTTLE_TIER_METADATA, THROTTLE_TIERS.SENSITIVE);

/**
 * Bỏ qua cả 3 tầng rate limit (health probe, /metrics). Khác với @SkipThrottle() của @nestjs/throttler
 * vốn chỉ bỏ qua throttler tên 'default' - không tồn tại trong cấu hình nhiều tầng của hệ thống.
 */
export const SkipAllThrottles = () => SetMetadata(THROTTLE_TIER_METADATA, THROTTLE_TIERS.NONE);
