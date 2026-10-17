/**
 * Hằng số & khóa Redis của IdentityModule (tài liệu 03, mục 3.0 I-5).
 * `phoneKey` = blind index HMAC của số E.164 → số điện thoại thật không bao giờ xuất hiện trong khóa Redis.
 */
import { RentalRole } from '../../core/access-control/rental-permissions';

export enum OtpPurpose {
  LOGIN_MFA = 'LOGIN_MFA',
  ACTIVATE_ACCOUNT = 'ACTIVATE_ACCOUNT',
  RESET_PASSWORD = 'RESET_PASSWORD',
}

/** Mục đích client được tự yêu cầu qua POST /auth/otp/request (LOGIN_MFA chỉ sinh ra từ bước mật khẩu) */
export const SELF_SERVICE_OTP_PURPOSES = [OtpPurpose.ACTIVATE_ACCOUNT, OtpPurpose.RESET_PASSWORD] as const;
export type SelfServiceOtpPurpose = (typeof SELF_SERVICE_OTP_PURPOSES)[number];

/** Vai trò nhân viên do chủ nhà cấp qua /users - TENANT chỉ sinh ra từ việc ở thực tế */
export const STAFF_ROLES = [
  RentalRole.LANDLORD,
  RentalRole.PROPERTY_MANAGER,
  RentalRole.ACCOUNTANT,
  RentalRole.GUARD,
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const IDENTITY_KEYS = {
  /** OTP kích hoạt / đặt lại mật khẩu: tra theo số điện thoại (body chứa phone) */
  otpByPhone: (purpose: OtpPurpose, phoneKey: string) => `otp:${purpose}:${phoneKey}`,
  /** OTP đăng nhập 2 bước: tra theo challengeId (body chỉ chứa challengeId) */
  otpByChallenge: (challengeId: string) => `otp:${OtpPurpose.LOGIN_MFA}:${challengeId}`,
  otpAttempts: (challengeId: string) => `otp:attempts:${challengeId}`,
  otpCooldown: (phoneKey: string) => `otp:cooldown:${phoneKey}`,
  otpDaily: (purpose: OtpPurpose, phoneKey: string, day: string) => `otp:daily:${purpose}:${phoneKey}:${day}`,
  loginFailures: (phoneKey: string) => `auth:login-fail:${phoneKey}`,
  loginLock: (phoneKey: string) => `auth:lock:${phoneKey}`,
  loginLockLevel: (phoneKey: string) => `auth:lock-level:${phoneKey}`,
} as const;

/** Cấp khóa đăng nhập "nguội" sau 24 giờ không bị khóa thêm */
export const LOCK_LEVEL_DECAY_SEC = 86_400;

export const IDENTITY_AUDIT_RESOURCE = 'auth';

export enum AuthAuditEvent {
  LOGIN_SUCCEEDED = 'LOGIN_SUCCEEDED',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_LOCKED = 'LOGIN_LOCKED',
  MFA_CHALLENGE_SENT = 'MFA_CHALLENGE_SENT',
  OTP_SENT = 'OTP_SENT',
  ACCOUNT_ACTIVATED = 'ACCOUNT_ACTIVATED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  SESSION_REVOKED = 'SESSION_REVOKED',
  REFRESH_TOKEN_REUSED = 'REFRESH_TOKEN_REUSED',
}
