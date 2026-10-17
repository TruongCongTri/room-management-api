/**
 * Khóa đăng nhập theo SỐ ĐIỆN THOẠI (bổ sung cho @ThrottleSensitive theo IP): kẻ tấn công xoay IP vẫn bị chặn.
 *  - AUTH_LOGIN_MAX_FAILURES lần sai trong AUTH_LOGIN_FAILURE_WINDOW_SEC → khóa AUTH_LOCK_BASE_SEC,
 *    mỗi lần bị khóa tiếp theo gấp đôi, tối đa AUTH_LOCK_MAX_SEC; cấp khóa về 0 sau 24 giờ kể từ khi khóa gần nhất kết thúc.
 *  - Đếm cả số CHƯA đăng ký → phản hồi không tiết lộ số nào có tài khoản.
 */
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../core/config/app-config.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { IDENTITY_KEYS, LOCK_LEVEL_DECAY_SEC } from '../identity.constants';
import { IDENTITY_STATE_STORE, IdentityStateStore } from './identity-state.store';

export interface LoginFailureOutcome {
  locked: boolean;
  lockSeconds?: number;
}

export class AccountLockedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        errorCode: SystemErrorCode.AUTH_ACCOUNT_LOCKED,
        message: 'Too many wrong passwords for this phone number. Try again later.',
        retryAfterSeconds,
      },
      HttpStatus.LOCKED,
    );
  }
}

@Injectable()
export class LoginLockService {
  constructor(
    @Inject(IDENTITY_STATE_STORE) private readonly store: IdentityStateStore,
    private readonly config: AppConfigService,
  ) {}

  /** Ném 423 (kèm Retry-After) khi số điện thoại đang bị khóa - kiểm tra TRƯỚC khi so mật khẩu */
  async assertNotLocked(phoneKey: string): Promise<void> {
    const remaining = await this.store.ttl(IDENTITY_KEYS.loginLock(phoneKey));
    if (remaining > 0) throw new AccountLockedException(remaining);
  }

  async recordFailure(phoneKey: string): Promise<LoginFailureOutcome> {
    const { maxFailures, failureWindowSec, lockBaseSec, lockMaxSec } = this.config.auth.login;
    const failures = await this.store.increment(IDENTITY_KEYS.loginFailures(phoneKey), failureWindowSec);
    if (failures < maxFailures) return { locked: false };

    const levelKey = IDENTITY_KEYS.loginLockLevel(phoneKey);
    const level = await this.store.increment(levelKey, LOCK_LEVEL_DECAY_SEC);
    const lockSeconds = Math.min(lockBaseSec * 2 ** (level - 1), lockMaxSec);
    // Cấp khóa chỉ "nguội" 24 giờ SAU KHI khóa kết thúc (nếu tính từ lúc bắt đầu, khóa 24 giờ tự xóa lịch sử của nó)
    await this.store.expire(levelKey, lockSeconds + LOCK_LEVEL_DECAY_SEC);
    await this.store.set(IDENTITY_KEYS.loginLock(phoneKey), String(level), lockSeconds);
    await this.store.delete(IDENTITY_KEYS.loginFailures(phoneKey));
    return { locked: true, lockSeconds };
  }

  /** Đăng nhập đúng: xóa bộ đếm sai (giữ cấp khóa để lần bị khóa kế tiếp trong 24 giờ vẫn gấp đôi) */
  async recordSuccess(phoneKey: string): Promise<void> {
    await this.store.delete(IDENTITY_KEYS.loginFailures(phoneKey));
  }

  /** Đặt lại mật khẩu bằng OTP chứng minh quyền sở hữu số điện thoại → gỡ khóa hoàn toàn */
  async clear(phoneKey: string): Promise<void> {
    await this.store.delete(
      IDENTITY_KEYS.loginFailures(phoneKey),
      IDENTITY_KEYS.loginLock(phoneKey),
      IDENTITY_KEYS.loginLockLevel(phoneKey),
    );
  }
}
