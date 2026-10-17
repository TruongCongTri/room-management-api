/**
 * Custom Guard định danh tracker:
 * Nếu user đã đăng nhập (JwtAuthGuard chạy TRƯỚC trong chuỗi guard toàn cục), tính giới hạn theo user:<userId>
 * → nhân viên dùng chung NAT văn phòng không bị chặn oan.
 * Nếu là khách vãng lai, tính giới hạn theo ip:<clientIp> lấy từ req.ip
 * (đã tôn trọng TRUST_PROXY; KHÔNG đọc thẳng X-Forwarded-For vì có thể bị giả mạo).
 */
import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException, ThrottlerLimitDetail, normalizeIp } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // 1. Nếu request đã được xác thực, định danh theo User ID
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }

    // 2. Fallback về địa chỉ IP thực (IPv6 được gom theo subnet để chống xoay địa chỉ)
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${normalizeIp(ip, this.ipv6SubnetPrefix)}`;
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    // Header chuẩn RFC 9110 (thư viện chỉ gửi Retry-After-<tên tầng>) để client / SDK tự backoff
    if (context.getType() === 'http') {
      context.switchToHttp().getResponse()?.setHeader?.('Retry-After', String(detail.timeToBlockExpire));
    }
    throw new ThrottlerException(
      `Too many requests. Rate limit exceeded. Retry after ${detail.timeToBlockExpire}s.`,
    );
  }
}
