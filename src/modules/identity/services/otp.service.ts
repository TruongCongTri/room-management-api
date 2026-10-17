/**
 * Mã OTP 6 chữ số (tài liệu 04, mục 1.4):
 *  - Sinh bằng crypto.randomInt, chỉ lưu HMAC-SHA256(challengeId:code) trong Redis; so sánh timingSafeEqual.
 *  - Hết hạn AUTH_OTP_TTL_SEC; sai AUTH_OTP_MAX_ATTEMPTS lần → hủy challenge.
 *  - Chờ AUTH_OTP_RESEND_COOLDOWN_SEC giữa hai lần gửi và giới hạn số lần gửi / ngày (giờ Việt Nam) cho MỖI số,
 *    áp dụng cả với số chưa đăng ký (không lộ số nào có tài khoản).
 *  - Tiêu thụ đúng một lần: hai request đồng thời cùng mã đúng → chỉ request xóa được khóa mới thắng.
 *  - Gửi qua NotificationModule: Zalo khi tài khoản đã liên kết Zalo, dự phòng SMS.
 *  - AUTH_OTP_DEBUG_ECHO (cấm trên production): trả mã trong response để kiểm thử bằng Postman.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { AppConfigService } from '../../../core/config/app-config.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { NotificationDispatcherService } from '../../../infrastructure/notification/services/notification-dispatcher.service';
import { NotificationChannel } from '../../../infrastructure/notification/interfaces/notification.interface';
import { NOTIFICATION_TEMPLATES } from '../../../infrastructure/notification/templates/template-renderer.service';
import { IDENTITY_KEYS, OtpPurpose } from '../identity.constants';
import { IDENTITY_STATE_STORE, IdentityStateStore } from './identity-state.store';

const VN_UTC_OFFSET_MS = 7 * 3600 * 1000;

export interface OtpRecord {
  challengeId: string;
  purpose: OtpPurpose;
  codeHash: string;
  userId: string;
  phoneKey: string;
  /** LOGIN_MFA: challenge gắn với thiết bị & IP đã vượt bước mật khẩu */
  deviceId?: string | null;
  deviceName?: string | null;
  ip?: string;
}

export interface OtpRecipient {
  userId: string;
  phoneE164: string;
  zaloUserId?: string;
}

export interface IssueOtpInput {
  purpose: OtpPurpose;
  phoneKey: string;
  /** null = số không có tài khoản phù hợp: vẫn tính cooldown / hạn mức, nhưng không sinh và không gửi mã */
  recipient: OtpRecipient | null;
  deviceId?: string | null;
  deviceName?: string | null;
  ip?: string;
}

export interface IssuedOtp {
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  channel?: NotificationChannel;
  delivered: boolean;
  /** Chỉ khi AUTH_OTP_DEBUG_ECHO=true (local / test) */
  debugCode?: string;
}

export type OtpLookup = { purpose: OtpPurpose.LOGIN_MFA; challengeId: string } | { purpose: Exclude<OtpPurpose, OtpPurpose.LOGIN_MFA>; phoneKey: string };

export class OtpRateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        errorCode: SystemErrorCode.AUTH_OTP_RATE_LIMITED,
        message: 'Too many verification codes requested for this phone number.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Ngày hiện tại theo giờ Việt Nam (YYYYMMDD) và số giây tới nửa đêm */
export function vietnamDay(now = Date.now()): { day: string; secondsToMidnight: number } {
  const local = new Date(now + VN_UTC_OFFSET_MS);
  const day = local.toISOString().slice(0, 10).replace(/-/g, '');
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return { day, secondsToMidnight: Math.ceil((midnightLocal - (now + VN_UTC_OFFSET_MS)) / 1000) };
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(IDENTITY_STATE_STORE) private readonly store: IdentityStateStore,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  async issue(input: IssueOtpInput): Promise<IssuedOtp> {
    const { ttlSec, resendCooldownSec, dailyLimit, mfaDailyLimit, debugEcho } = this.config.auth.otp;
    const { phoneKey, purpose } = input;

    // 1. Cooldown dùng chung mọi mục đích của một số điện thoại
    const cooldownKey = IDENTITY_KEYS.otpCooldown(phoneKey);
    if (!(await this.store.setIfAbsent(cooldownKey, '1', resendCooldownSec))) {
      throw new OtpRateLimitedException(await this.store.ttl(cooldownKey));
    }

    // 2. Hạn mức theo ngày, theo mục đích (đăng nhập 2 bước được nhiều lượt hơn kích hoạt / đặt lại)
    const { day, secondsToMidnight } = vietnamDay();
    const dailyKey = IDENTITY_KEYS.otpDaily(purpose, phoneKey, day);
    const sent = await this.store.increment(dailyKey, secondsToMidnight);
    const limit = purpose === OtpPurpose.LOGIN_MFA ? mfaDailyLimit : dailyLimit;
    if (sent > limit) {
      throw new OtpRateLimitedException(await this.store.ttl(dailyKey));
    }

    const challengeId = randomUUID();
    const base = { challengeId, expiresInSeconds: ttlSec, resendAfterSeconds: resendCooldownSec };
    if (!input.recipient) {
      return { ...base, delivered: false };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const record: OtpRecord = {
      challengeId,
      purpose,
      codeHash: this.hashCode(challengeId, code),
      userId: input.recipient.userId,
      phoneKey,
      deviceId: input.deviceId ?? null,
      deviceName: input.deviceName ?? null,
      ip: input.ip,
    };
    // Mã mới thay thế mã cũ cùng mục đích (mã cũ hết hiệu lực ngay)
    await this.store.set(this.recordKey(record), JSON.stringify(record), ttlSec);

    const channel = await this.deliver(input.recipient, code, ttlSec);
    return { ...base, channel, delivered: !!channel, ...(debugEcho ? { debugCode: code } : {}) };
  }

  /**
   * Xác thực & tiêu thụ OTP. Ném:
   *  - 400 AUTH_OTP_EXPIRED: không có challenge (hết hạn, đã dùng, đã bị hủy)
   *  - 400 AUTH_OTP_INVALID: sai mã (details.attemptsRemaining)
   *  - 429 AUTH_OTP_TOO_MANY_ATTEMPTS: hết lượt → challenge bị hủy
   */
  async verify(lookup: OtpLookup, code: string, binding: { deviceId?: string | null; ip?: string } = {}): Promise<OtpRecord> {
    const key =
      lookup.purpose === OtpPurpose.LOGIN_MFA
        ? IDENTITY_KEYS.otpByChallenge(lookup.challengeId)
        : IDENTITY_KEYS.otpByPhone(lookup.purpose, lookup.phoneKey);
    const raw = await this.store.get(key);
    if (!raw) throw this.expired();
    const record = JSON.parse(raw) as OtpRecord;

    const { maxAttempts, ttlSec } = this.config.auth.otp;
    const attempts = await this.store.increment(IDENTITY_KEYS.otpAttempts(record.challengeId), ttlSec);
    if (attempts > maxAttempts) {
      await this.store.delete(key);
      throw this.tooManyAttempts();
    }

    const bindingOk =
      lookup.purpose !== OtpPurpose.LOGIN_MFA ||
      ((record.deviceId ?? null) === (binding.deviceId ?? null) && record.ip === binding.ip);
    if (!bindingOk || !this.matches(record, code)) {
      if (attempts >= maxAttempts) {
        await this.store.delete(key);
        throw this.tooManyAttempts();
      }
      throw new BadRequestException({
        errorCode: SystemErrorCode.AUTH_OTP_INVALID,
        message: 'The verification code is incorrect.',
        details: [{ field: 'code', issue: 'INVALID', attemptsRemaining: maxAttempts - attempts }],
      });
    }

    // Tiêu thụ đúng một lần (request đồng thời cùng mã đúng: chỉ một request xóa được khóa)
    if ((await this.store.delete(key)) !== 1) throw this.expired();
    await this.store.delete(IDENTITY_KEYS.otpAttempts(record.challengeId));
    return record;
  }

  private recordKey(record: Pick<OtpRecord, 'purpose' | 'phoneKey' | 'challengeId'>): string {
    return record.purpose === OtpPurpose.LOGIN_MFA
      ? IDENTITY_KEYS.otpByChallenge(record.challengeId)
      : IDENTITY_KEYS.otpByPhone(record.purpose, record.phoneKey);
  }

  private hashCode(challengeId: string, code: string): string {
    return createHmac('sha256', this.config.security.blindIndexPepper as string)
      .update(`otp|${challengeId}|${code}`)
      .digest('hex');
  }

  private matches(record: OtpRecord, code: string): boolean {
    if (!/^[0-9]{6}$/.test(code ?? '')) return false;
    const expected = Buffer.from(record.codeHash, 'hex');
    const actual = Buffer.from(this.hashCode(record.challengeId, code), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Zalo (nếu tài khoản đã liên kết Zalo) rồi SMS; trả kênh gửi thành công hoặc undefined */
  private async deliver(recipient: OtpRecipient, code: string, ttlSec: number): Promise<NotificationChannel | undefined> {
    const channels = [
      ...(recipient.zaloUserId ? [NotificationChannel.ZALO] : []),
      NotificationChannel.SMS,
    ];
    for (const channel of channels) {
      try {
        const result = await this.notifications.dispatch({
          channels: [channel],
          recipient: { phone: recipient.phoneE164, zaloUserId: recipient.zaloUserId },
          payload: {
            templateName: NOTIFICATION_TEMPLATES.OTP_VERIFICATION,
            context: { otp: code, expiresInMinutes: Math.round(ttlSec / 60) },
          },
          priority: 'high',
        });
        if (result.success) return channel;
      } catch (err: any) {
        this.logger.warn(`OTP delivery through ${channel} failed: ${err.message}`);
      }
    }
    this.logger.error('OTP could not be delivered through any channel.');
    return undefined;
  }

  private expired() {
    return new BadRequestException({
      errorCode: SystemErrorCode.AUTH_OTP_EXPIRED,
      message: 'The verification code has expired or was already used.',
    });
  }

  private tooManyAttempts() {
    return new HttpException(
      { errorCode: SystemErrorCode.AUTH_OTP_TOO_MANY_ATTEMPTS, message: 'Too many wrong verification codes.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
