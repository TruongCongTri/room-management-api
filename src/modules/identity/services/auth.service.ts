/**
 * Điều phối đăng nhập bằng số điện thoại (tài liệu 02, mục 2.0; tài liệu 04, mục 1.4):
 * mật khẩu argon2id → (vai trò tài chính) OTP → phiên + cặp token; refresh xoay vòng; kích hoạt / đặt lại
 * mật khẩu bằng OTP; đổi mật khẩu; đăng xuất; danh sách thiết bị.
 *
 * Chống dò tài khoản: sai mật khẩu, số chưa đăng ký và tài khoản chưa kích hoạt đều trả cùng
 * 401 AUTH_CREDENTIALS_INVALID, cùng thời gian xử lý (so với hash giả) và cùng bị tính vào khóa đăng nhập.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service';
import { EncryptionService } from '../../../core/security/encryption/encryption.service';
import { JwtTokenService } from '../../../core/security/jwt/jwt-token.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { OccupancySelfScopeService } from '../../../core/access-control/occupancy-self-scope';
import { formatPermission } from '../../../core/access-control/rental-permissions';
import { PermissionEffect } from '../../../core/access-control/access-control.types';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { AuditWriterService } from '../../../infrastructure/audit/services/audit-writer.service';
import { AuditAction } from '../../../infrastructure/audit/interfaces/audit.interface';
import { NotificationDispatcherService } from '../../../infrastructure/notification/services/notification-dispatcher.service';
import { NotificationChannel } from '../../../infrastructure/notification/interfaces/notification.interface';
import { NOTIFICATION_TEMPLATES } from '../../../infrastructure/notification/templates/template-renderer.service';
import { User, UserStatus } from '../entities/user.entity';
import { AuthSession, SessionRevokedReason } from '../entities/auth-session.entity';
import { InvalidPhoneNumberError, maskPhoneNumber, normalizePhoneNumber } from '../domain/phone-number';
import { checkPasswordPolicy, PasswordIssue } from '../domain/password-policy';
import { AuthAuditEvent, IDENTITY_AUDIT_RESOURCE, OtpPurpose, SelfServiceOtpPurpose } from '../identity.constants';
import { AccountLockedException, LoginLockService } from './login-lock.service';
import { OtpService } from './otp.service';
import { PasswordHasherService } from './password-hasher.service';
import { SessionClientInfo, SessionService } from './session.service';
import { UserAccess, UserDirectoryService } from './user-directory.service';

export interface ClientDevice {
  deviceId?: string | null;
  deviceName?: string | null;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  user: { id: string; fullName: string; phoneMasked: string; roles: string[]; buildingIds: string[] };
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeId: string;
  otpSentTo: string;
  channel?: NotificationChannel;
  expiresInSeconds: number;
  debugCode?: string;
}

export type LoginResult = { kind: 'TOKENS'; tokens: TokenPair } | { kind: 'MFA_REQUIRED'; challenge: MfaChallenge };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly encryption: EncryptionService,
    private readonly jwt: JwtTokenService,
    private readonly hasher: PasswordHasherService,
    private readonly lock: LoginLockService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly directory: UserDirectoryService,
    private readonly selfScope: OccupancySelfScopeService,
    private readonly audit: AuditWriterService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  // ---------------------------------------------------------------------------
  // Đăng nhập
  // ---------------------------------------------------------------------------

  async login(phone: string, password: string, device: ClientDevice, client: SessionClientInfo): Promise<LoginResult> {
    const phoneE164 = this.normalizePhone(phone);
    const phoneKey = this.phoneKey(phoneE164);
    await this.lock.assertNotLocked(phoneKey);

    const user = await this.directory.findByPhone(phoneE164, { withPasswordHash: true });
    // Chưa kích hoạt (không có mật khẩu) / không tồn tại → so với hash giả, cùng một lỗi
    const valid = await this.hasher.verify(user?.passwordHash, password ?? '');
    if (!user || !valid) {
      const outcome = await this.lock.recordFailure(phoneKey);
      await this.record(outcome.locked ? AuthAuditEvent.LOGIN_LOCKED : AuthAuditEvent.LOGIN_FAILED, {
        userId: user?.id,
        phoneE164,
        lockSeconds: outcome.lockSeconds,
      });
      if (outcome.locked) throw new AccountLockedException(outcome.lockSeconds!);
      throw this.invalidCredentials();
    }

    if (user.status === UserStatus.DISABLED) {
      await this.record(AuthAuditEvent.LOGIN_FAILED, { userId: user.id, phoneE164, reason: 'ACCOUNT_DISABLED' });
      throw new ForbiddenException({ errorCode: SystemErrorCode.AUTH_ACCOUNT_DISABLED, message: 'This account has been disabled.' });
    }

    await this.lock.recordSuccess(phoneKey);
    await this.upgradeHashIfNeeded(user, password);

    const access = await this.directory.getAccess(user.id);
    if (access.roles.some((role) => this.config.auth.mfaRoles.includes(role))) {
      const issued = await this.otp.issue({
        purpose: OtpPurpose.LOGIN_MFA,
        phoneKey,
        recipient: { userId: user.id, phoneE164 },
        deviceId: device.deviceId ?? null,
        deviceName: device.deviceName ?? null,
        ip: client.ipAddress,
      });
      if (!issued.delivered) {
        throw new ServiceUnavailableException({
          errorCode: SystemErrorCode.SYS_SERVICE_UNAVAILABLE,
          message: 'The verification code could not be sent. Please try again shortly.',
        });
      }
      await this.record(AuthAuditEvent.MFA_CHALLENGE_SENT, { userId: user.id, phoneE164, channel: issued.channel });
      return {
        kind: 'MFA_REQUIRED',
        challenge: {
          mfaRequired: true,
          challengeId: issued.challengeId,
          otpSentTo: maskPhoneNumber(phoneE164),
          channel: issued.channel,
          expiresInSeconds: issued.expiresInSeconds,
          ...(issued.debugCode ? { debugCode: issued.debugCode } : {}),
        },
      };
    }

    return { kind: 'TOKENS', tokens: await this.completeLogin(user, access, { ...client, ...device }, null) };
  }

  async verifyLoginMfa(challengeId: string, code: string, device: ClientDevice, client: SessionClientInfo): Promise<TokenPair> {
    const record = await this.otp.verify({ purpose: OtpPurpose.LOGIN_MFA, challengeId }, code, {
      deviceId: device.deviceId ?? null,
      ip: client.ipAddress,
    });
    const user = await this.directory.findById(record.userId);
    if (!user || user.status !== UserStatus.ACTIVE) throw this.invalidCredentials();
    const access = await this.directory.getAccess(user.id);
    return this.completeLogin(user, access, { ...client, deviceId: record.deviceId, deviceName: record.deviceName }, new Date());
  }

  async refresh(refreshToken: string, client: SessionClientInfo): Promise<TokenPair> {
    const outcome = await this.sessions.rotate(refreshToken, client);
    if (outcome.status === 'REUSED') {
      const user = await this.directory.findById(outcome.session.userId);
      await this.record(AuthAuditEvent.REFRESH_TOKEN_REUSED, { userId: outcome.session.userId, phoneE164: user?.phoneE164, sessionId: outcome.session.id });
      if (user) this.securityAlert(user, 'phát hiện phiên đăng nhập bị dùng lại bất thường, phiên đã bị đăng xuất');
    }
    if (outcome.status !== 'ROTATED') throw SessionService.toUnauthorized(outcome);

    const user = await this.directory.findById(outcome.session.userId);
    if (!user || user.status !== UserStatus.ACTIVE) {
      await this.sessions.revoke(outcome.session.userId, outcome.session.id, SessionRevokedReason.ACCOUNT_DISABLED);
      throw SessionService.toUnauthorized({ status: 'REVOKED' });
    }
    const access = await this.directory.getAccess(user.id);
    return this.tokenPair(user, access, outcome.session, outcome.refreshToken);
  }

  // ---------------------------------------------------------------------------
  // OTP: kích hoạt tài khoản / đặt lại mật khẩu
  // ---------------------------------------------------------------------------

  async requestOtp(phone: string, purpose: SelfServiceOtpPurpose, client: SessionClientInfo) {
    const phoneE164 = this.normalizePhone(phone);
    const phoneKey = this.phoneKey(phoneE164);
    const user = await this.directory.findByPhone(phoneE164);
    const eligible =
      !!user &&
      (purpose === OtpPurpose.ACTIVATE_ACCOUNT ? user.status === UserStatus.PENDING_ACTIVATION : user.status === UserStatus.ACTIVE);

    const issued = await this.otp.issue({
      purpose,
      phoneKey,
      recipient: eligible ? { userId: user!.id, phoneE164 } : null,
      ip: client.ipAddress,
    });
    if (eligible) {
      await this.record(AuthAuditEvent.OTP_SENT, { userId: user!.id, phoneE164, purpose, delivered: issued.delivered });
    }
    // Cùng một phản hồi cho mọi số điện thoại
    return {
      expiresInSeconds: issued.expiresInSeconds,
      resendAfterSeconds: issued.resendAfterSeconds,
      ...(issued.debugCode ? { debugCode: issued.debugCode } : {}),
    };
  }

  async activate(phone: string, code: string, newPassword: string, device: ClientDevice, client: SessionClientInfo): Promise<TokenPair> {
    const phoneE164 = this.normalizePhone(phone);
    // Kiểm tra chính sách TRƯỚC khi tiêu thụ OTP: mật khẩu yếu không làm mất mã vừa nhận
    this.assertPasswordPolicy(newPassword, phoneE164);
    const record = await this.otp.verify({ purpose: OtpPurpose.ACTIVATE_ACCOUNT, phoneKey: this.phoneKey(phoneE164) }, code);

    const passwordHash = await this.hasher.hash(newPassword);
    const user = await this.dataSource.transaction(async (manager) => {
      const target = await manager.getRepository(User).findOne({ where: { id: record.userId }, lock: { mode: 'pessimistic_write' } });
      if (!target || target.status !== UserStatus.PENDING_ACTIVATION || target.phoneE164 !== phoneE164) {
        throw this.otpExpired();
      }
      const now = new Date();
      target.passwordHash = passwordHash;
      target.passwordChangedAt = now;
      target.phoneVerifiedAt = now;
      target.status = UserStatus.ACTIVE;
      return manager.getRepository(User).save(target);
    });

    await this.lock.clear(this.phoneKey(phoneE164));
    await this.record(AuthAuditEvent.ACCOUNT_ACTIVATED, { userId: user.id, phoneE164 });
    const access = await this.directory.getAccess(user.id);
    return this.completeLogin(user, access, { ...client, ...device }, null);
  }

  async resetPassword(phone: string, code: string, newPassword: string): Promise<void> {
    const phoneE164 = this.normalizePhone(phone);
    this.assertPasswordPolicy(newPassword, phoneE164);
    const phoneKey = this.phoneKey(phoneE164);
    const record = await this.otp.verify({ purpose: OtpPurpose.RESET_PASSWORD, phoneKey }, code);

    const passwordHash = await this.hasher.hash(newPassword);
    const user = await this.dataSource.transaction(async (manager) => {
      const target = await manager.getRepository(User).findOne({ where: { id: record.userId }, lock: { mode: 'pessimistic_write' } });
      if (!target || target.status !== UserStatus.ACTIVE || target.phoneE164 !== phoneE164) throw this.otpExpired();
      target.passwordHash = passwordHash;
      target.passwordChangedAt = new Date();
      const saved = await manager.getRepository(User).save(target);
      await this.sessions.revokeAll(target.id, SessionRevokedReason.PASSWORD_RESET, undefined, manager);
      return saved;
    });

    await this.lock.clear(phoneKey);
    await this.record(AuthAuditEvent.PASSWORD_RESET, { userId: user.id, phoneE164 });
    this.securityAlert(user, 'mật khẩu đã được đặt lại và mọi thiết bị đã bị đăng xuất');
  }

  async changePassword(actor: RequestUserContext, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.directory.findById(actor.id, { withPasswordHash: true });
    if (!user || user.status !== UserStatus.ACTIVE) throw this.invalidCredentials();
    const phoneKey = this.phoneKey(user.phoneE164);
    await this.lock.assertNotLocked(phoneKey);

    if (!(await this.hasher.verify(user.passwordHash, currentPassword ?? ''))) {
      const outcome = await this.lock.recordFailure(phoneKey);
      await this.record(outcome.locked ? AuthAuditEvent.LOGIN_LOCKED : AuthAuditEvent.LOGIN_FAILED, {
        userId: user.id,
        phoneE164: user.phoneE164,
        reason: 'PASSWORD_CHANGE_WRONG_CURRENT',
      });
      if (outcome.locked) throw new AccountLockedException(outcome.lockSeconds!);
      throw this.invalidCredentials();
    }
    await this.lock.recordSuccess(phoneKey);

    const issues = checkPasswordPolicy(newPassword, { phoneE164: user.phoneE164 });
    if (await this.hasher.verify(user.passwordHash, newPassword ?? '')) issues.push(PasswordIssue.SAME_AS_CURRENT);
    this.throwIfPolicyIssues(issues);

    const passwordHash = await this.hasher.hash(newPassword);
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(User).update({ id: user.id }, { passwordHash, passwordChangedAt: new Date() });
      await this.sessions.revokeAll(user.id, SessionRevokedReason.PASSWORD_CHANGED, actor.sessionId, manager);
    });
    await this.record(AuthAuditEvent.PASSWORD_CHANGED, { userId: user.id, phoneE164: user.phoneE164, sessionId: actor.sessionId });
    this.securityAlert(user, 'mật khẩu đã được thay đổi, các thiết bị khác đã bị đăng xuất');
  }

  // ---------------------------------------------------------------------------
  // Phiên của người dùng hiện tại
  // ---------------------------------------------------------------------------

  async logout(actor: RequestUserContext): Promise<void> {
    if (!actor.sessionId) return;
    await this.sessions.revoke(actor.id, actor.sessionId, SessionRevokedReason.LOGOUT);
    await this.record(AuthAuditEvent.LOGOUT, { userId: actor.id, sessionId: actor.sessionId });
  }

  async logoutAll(actor: RequestUserContext): Promise<void> {
    const revoked = await this.sessions.revokeAll(actor.id, SessionRevokedReason.LOGOUT_ALL);
    // Token không gắn phiên (token dịch vụ) vẫn được đánh dấu thu hồi nếu có sid
    if (actor.sessionId && !revoked.includes(actor.sessionId)) await this.sessions.markRevoked([actor.sessionId]);
    await this.record(AuthAuditEvent.LOGOUT_ALL, { userId: actor.id, revokedSessions: revoked.length });
  }

  async listSessions(actor: RequestUserContext) {
    const sessions = await this.sessions.listActive(actor.id);
    return sessions.map((session) => ({
      id: session.id,
      deviceName: session.deviceName ?? null,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent ?? null,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      current: session.id === actor.sessionId,
    }));
  }

  async revokeSession(actor: RequestUserContext, sessionId: string): Promise<void> {
    if (!(await this.sessions.revoke(actor.id, sessionId, SessionRevokedReason.REVOKED_BY_USER))) {
      throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Session not found.' });
    }
    await this.record(AuthAuditEvent.SESSION_REVOKED, { userId: actor.id, sessionId });
  }

  async me(actor: RequestUserContext) {
    const user = await this.directory.findById(actor.id);
    if (!user) throw new UnauthorizedException({ errorCode: SystemErrorCode.AUTH_UNAUTHORIZED, message: 'Account not found.' });
    const access = await this.directory.getAccess(user.id);
    const activeBuildingId = actor.tenantId ?? null;
    const residence = await this.selfScope.resolve(user.id, actor.tenantId);
    return {
      id: user.id,
      fullName: user.fullName,
      phoneMasked: maskPhoneNumber(user.phoneE164),
      status: user.status,
      roles: access.roles,
      activeBuildingId,
      // Tên tòa nhà được bổ sung khi PropertiesModule (module 1) có bảng buildings
      buildings: access.buildingIds.map((id) => ({ id, name: null })),
      permissions: actor.rules
        .filter((rule) => rule.effect === PermissionEffect.GRANT)
        .map((rule) => formatPermission(rule))
        .sort(),
      residence: residence
        ? {
            tenantId: residence.tenantId,
            contractId: residence.contractId,
            roomId: residence.roomId,
            roomNumber: residence.roomNumber ?? null,
            occupantRole: residence.occupantRole,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Nội bộ
  // ---------------------------------------------------------------------------

  private async completeLogin(
    user: User,
    access: UserAccess,
    client: SessionClientInfo & ClientDevice,
    mfaVerifiedAt: Date | null,
  ): Promise<TokenPair> {
    const { session, refreshToken } = await this.sessions.create(user.id, client, mfaVerifiedAt);
    await this.dataSource.getRepository(User).update({ id: user.id }, { lastLoginAt: new Date() });
    await this.record(AuthAuditEvent.LOGIN_SUCCEEDED, { userId: user.id, phoneE164: user.phoneE164, sessionId: session.id, mfa: !!mfaVerifiedAt });
    return this.tokenPair(user, access, session, refreshToken);
  }

  private async tokenPair(user: User, access: UserAccess, session: AuthSession, refreshToken: string): Promise<TokenPair> {
    const phoneMasked = maskPhoneNumber(user.phoneE164);
    const accessToken = await this.jwt.signAccessToken({
      sub: user.id,
      sid: session.id,
      phoneMasked,
      buildingId: access.buildingIds[0],
      buildingIds: access.buildingIds,
      roles: access.roles,
    });
    return {
      tokenType: 'Bearer',
      accessToken,
      accessTokenExpiresIn: this.config.auth.accessTokenTtlSec,
      refreshToken,
      refreshTokenExpiresAt: session.idleExpiresAt.toISOString(),
      sessionId: session.id,
      user: { id: user.id, fullName: user.fullName, phoneMasked, roles: access.roles, buildingIds: access.buildingIds },
    };
  }

  private async upgradeHashIfNeeded(user: User, password: string): Promise<void> {
    if (user.passwordHash && this.hasher.needsRehash(user.passwordHash)) {
      await this.dataSource.getRepository(User).update({ id: user.id }, { passwordHash: await this.hasher.hash(password) });
    }
  }

  private normalizePhone(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: [{ field: 'phone', message: err.message }],
        });
      }
      throw err;
    }
  }

  private phoneKey(phoneE164: string): string {
    return this.encryption.computeBlindIndex(phoneE164);
  }

  private assertPasswordPolicy(password: string, phoneE164: string): void {
    this.throwIfPolicyIssues(checkPasswordPolicy(password, { phoneE164 }));
  }

  private throwIfPolicyIssues(issues: PasswordIssue[]): void {
    if (issues.length === 0) return;
    throw new UnprocessableEntityException({
      errorCode: SystemErrorCode.AUTH_PASSWORD_POLICY_VIOLATION,
      message: 'The password does not meet the password policy.',
      details: issues.map((issue) => ({ field: 'newPassword', issue })),
    });
  }

  private invalidCredentials() {
    return new UnauthorizedException({ errorCode: SystemErrorCode.AUTH_CREDENTIALS_INVALID, message: 'Incorrect phone number or password.' });
  }

  private otpExpired() {
    return new BadRequestException({
      errorCode: SystemErrorCode.AUTH_OTP_EXPIRED,
      message: 'The verification code has expired or was already used.',
    });
  }

  /** Sự kiện bảo mật → audit WORM (số điện thoại luôn ở dạng đã che) */
  private async record(
    event: AuthAuditEvent,
    data: { userId?: string; phoneE164?: string; [key: string]: unknown },
  ): Promise<void> {
    const { userId, phoneE164, ...extra } = data;
    const phoneMasked = phoneE164 ? maskPhoneNumber(phoneE164) : undefined;
    await this.audit.record({
      resource: IDENTITY_AUDIT_RESOURCE,
      resourceId: userId ?? phoneMasked ?? '-',
      action: AuditAction.EXECUTE,
      explicitActorId: userId ?? 'ANONYMOUS',
      metadata: { event, phoneMasked, ...extra },
    });
  }

  /** Cảnh báo bảo mật qua SMS - không chặn luồng chính */
  private securityAlert(user: User, message: string): void {
    void this.notifications
      .dispatch({
        channels: [NotificationChannel.SMS],
        recipient: { phone: user.phoneE164, name: user.fullName },
        payload: {
          templateName: NOTIFICATION_TEMPLATES.SECURITY_ALERT,
          context: { alert: { message, occurredAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) } },
        },
        priority: 'high',
      })
      .catch((err) => this.logger.warn(`Security alert could not be sent: ${err.message}`));
  }
}
