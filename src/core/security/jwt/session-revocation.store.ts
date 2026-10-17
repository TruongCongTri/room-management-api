/**
 * Danh sách phiên đăng nhập đã bị thu hồi (denylist) cho access token CÒN HẠN:
 * access token là JWT không trạng thái (15 phút), nên khi đăng xuất / đổi mật khẩu / phát hiện dùng lại
 * refresh token, `sid` của phiên được ghi vào `auth:revoked-sid:{sid}` với TTL = thời hạn access token.
 * JwtTokenService kiểm tra khóa này ở MỌI request → token của phiên bị thu hồi mất hiệu lực ngay lập tức.
 *
 * Redis khi được bật (chia sẻ giữa các Pod); fallback bộ nhớ trong tiến trình (một Pod / kiểm thử).
 * Redis lỗi khi kiểm tra → fail-closed (503) thay vì chấp nhận một token có thể đã bị thu hồi.
 */
import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';

export const REVOKED_SESSION_KEY_PREFIX = 'auth:revoked-sid:';

@Injectable()
export class SessionRevocationStore {
  private readonly logger = new Logger(SessionRevocationStore.name);
  private readonly memory = new Map<string, number>();

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null) {}

  async markRevoked(sessionIds: readonly string[], ttlSec: number): Promise<void> {
    if (sessionIds.length === 0) return;
    const ttl = Math.max(1, Math.ceil(ttlSec));
    if (this.redis) {
      const pipeline = this.redis.pipeline();
      for (const sid of sessionIds) pipeline.set(this.key(sid), '1', 'EX', ttl);
      await pipeline.exec();
      return;
    }
    const expiresAt = Date.now() + ttl * 1000;
    for (const sid of sessionIds) this.memory.set(sid, expiresAt);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    if (this.redis) {
      try {
        return (await this.redis.exists(this.key(sessionId))) === 1;
      } catch (err: any) {
        this.logger.error(`Session revocation check failed: ${err.message}`);
        throw new ServiceUnavailableException({
          errorCode: SystemErrorCode.SYS_SERVICE_UNAVAILABLE,
          message: 'Session verification is temporarily unavailable.',
        });
      }
    }
    const expiresAt = this.memory.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.memory.delete(sessionId);
      return false;
    }
    return true;
  }

  private key(sessionId: string): string {
    return `${REVOKED_SESSION_KEY_PREFIX}${sessionId}`;
  }
}
