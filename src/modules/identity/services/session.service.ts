/**
 * Phiên đăng nhập & refresh token xoay vòng (tài liệu 02, mục 2.0.1):
 *  - Refresh token = `<sessionId>.<secret 256-bit base64url>`; DB chỉ lưu HMAC-SHA256(secret, JWT_REFRESH_SECRET)
 *    → lộ bảng auth_sessions cũng không dùng được token.
 *  - Mỗi lần refresh: khóa dòng phiên (FOR UPDATE), thay hash, hash cũ → previous_refresh_token_hash.
 *    Token cũ bị dùng lại = token đã bị đánh cắp → thu hồi CẢ phiên (ROTATION_REUSE_DETECTED).
 *  - Hạn trượt (JWT_REFRESH_EXPIRES_IN) không bao giờ vượt hạn tuyệt đối (AUTH_REFRESH_ABSOLUTE_EXPIRES_IN).
 *  - Thu hồi phiên ghi `auth:revoked-sid:{sid}` → access token còn hạn của phiên bị từ chối ngay.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service';
import { SessionRevocationStore } from '../../../core/security/jwt/session-revocation.store';
import { UUID_REGEX } from '../../../core/multitenancy/tenancy.constants';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { AuthSession, SessionRevokedReason } from '../entities/auth-session.entity';

const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 byte base64url

export interface SessionClientInfo {
  deviceId?: string | null;
  deviceName?: string | null;
  ipAddress: string;
  userAgent?: string | null;
}

export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

export type RotationOutcome =
  | { status: 'ROTATED'; session: AuthSession; refreshToken: string }
  | { status: 'REUSED'; session: AuthSession }
  | { status: 'INVALID' }
  | { status: 'REVOKED' };

@Injectable()
export class SessionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly revocations: SessionRevocationStore,
  ) {}

  async create(userId: string, client: SessionClientInfo, mfaVerifiedAt: Date | null = null, manager?: EntityManager): Promise<IssuedSession> {
    const { refreshIdleTtlSec, refreshAbsoluteTtlSec } = this.config.auth;
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + refreshAbsoluteTtlSec * 1000);
    const secret = this.newSecret();
    const repo = (manager ?? this.dataSource.manager).getRepository(AuthSession);
    const session = await repo.save(
      repo.create({
        userId,
        refreshTokenHash: this.hash(secret),
        previousRefreshTokenHash: null,
        rotationCount: 0,
        deviceId: client.deviceId ?? null,
        deviceName: client.deviceName ?? null,
        userAgent: client.userAgent?.slice(0, 512) ?? null,
        ipAddress: client.ipAddress.slice(0, 45),
        mfaVerifiedAt,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: this.min(new Date(now.getTime() + refreshIdleTtlSec * 1000), absoluteExpiresAt),
        absoluteExpiresAt,
      }),
    );
    return { session, refreshToken: `${session.id}.${secret}` };
  }

  /**
   * Xoay refresh token trong một transaction có khóa dòng: hai request refresh đồng thời với CÙNG token
   * → request thứ hai thấy hash đã chuyển sang previous → coi là dùng lại → thu hồi phiên.
   */
  async rotate(refreshToken: string, client: SessionClientInfo): Promise<RotationOutcome> {
    const parsed = this.parse(refreshToken);
    if (!parsed) return { status: 'INVALID' };

    const outcome = await this.dataSource.transaction(async (manager): Promise<RotationOutcome> => {
      const repo = manager.getRepository(AuthSession);
      const session = await repo.findOne({ where: { id: parsed.sessionId }, lock: { mode: 'pessimistic_write' } });
      if (!session) return { status: 'INVALID' };
      if (session.revokedAt) return { status: 'REVOKED' };

      const presented = this.hash(parsed.secret);
      if (session.previousRefreshTokenHash && this.equals(presented, session.previousRefreshTokenHash)) {
        await this.revokeRow(manager, session, SessionRevokedReason.ROTATION_REUSE_DETECTED);
        return { status: 'REUSED', session };
      }
      if (!this.equals(presented, session.refreshTokenHash)) return { status: 'INVALID' };

      const now = new Date();
      if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return { status: 'REVOKED' };

      const secret = this.newSecret();
      session.previousRefreshTokenHash = session.refreshTokenHash;
      session.refreshTokenHash = this.hash(secret);
      session.rotationCount += 1;
      session.lastUsedAt = now;
      session.idleExpiresAt = this.min(new Date(now.getTime() + this.config.auth.refreshIdleTtlSec * 1000), session.absoluteExpiresAt);
      session.ipAddress = client.ipAddress.slice(0, 45);
      session.userAgent = client.userAgent?.slice(0, 512) ?? session.userAgent;
      await repo.save(session);
      return { status: 'ROTATED', session, refreshToken: `${session.id}.${secret}` };
    });

    if (outcome.status === 'REUSED') await this.markRevoked([outcome.session.id]);
    return outcome;
  }

  /** Thu hồi một phiên của user (đăng xuất / gỡ thiết bị). Trả false nếu phiên không thuộc user hoặc đã thu hồi */
  async revoke(userId: string, sessionId: string, reason: SessionRevokedReason): Promise<boolean> {
    const result = await this.dataSource
      .getRepository(AuthSession)
      .update({ id: sessionId, userId, revokedAt: IsNull() }, { revokedAt: new Date(), revokedReason: reason });
    if (!result.affected) return false;
    await this.markRevoked([sessionId]);
    return true;
  }

  /** Thu hồi mọi phiên còn hiệu lực của user (trừ phiên hiện tại khi đổi mật khẩu); trả về id đã thu hồi */
  async revokeAll(userId: string, reason: SessionRevokedReason, exceptSessionId?: string, manager?: EntityManager): Promise<string[]> {
    const qb = (manager ?? this.dataSource.manager)
      .createQueryBuilder()
      .update(AuthSession)
      .set({ revokedAt: () => 'now()', revokedReason: reason })
      .where('user_id = :userId AND revoked_at IS NULL', { userId });
    if (exceptSessionId) qb.andWhere('id <> :exceptSessionId', { exceptSessionId });
    const result = await qb.returning(['id']).execute();
    const ids: string[] = (result.raw as Array<{ id: string }>).map((row) => row.id);
    await this.markRevoked(ids);
    return ids;
  }

  listActive(userId: string): Promise<AuthSession[]> {
    const now = new Date();
    return this.dataSource.getRepository(AuthSession).find({
      where: { userId, revokedAt: IsNull(), idleExpiresAt: MoreThan(now), absoluteExpiresAt: MoreThan(now) },
      order: { lastUsedAt: 'DESC' },
    });
  }

  async markRevoked(sessionIds: string[]): Promise<void> {
    await this.revocations.markRevoked(sessionIds, this.config.auth.accessTokenTtlSec);
  }

  /** Ném 401 tương ứng với kết quả xoay token không thành công */
  static toUnauthorized(outcome: Exclude<RotationOutcome, { status: 'ROTATED' }>): UnauthorizedException {
    switch (outcome.status) {
      case 'REUSED':
        return new UnauthorizedException({
          errorCode: SystemErrorCode.AUTH_REFRESH_TOKEN_REUSED,
          message: 'This refresh token was already used. The session has been revoked.',
        });
      case 'REVOKED':
        return new UnauthorizedException({
          errorCode: SystemErrorCode.AUTH_SESSION_REVOKED,
          message: 'This session has been revoked or has expired. Please sign in again.',
        });
      default:
        return new UnauthorizedException({ errorCode: SystemErrorCode.AUTH_TOKEN_INVALID, message: 'The refresh token is invalid.' });
    }
  }

  private async revokeRow(manager: EntityManager, session: AuthSession, reason: SessionRevokedReason): Promise<void> {
    session.revokedAt = new Date();
    session.revokedReason = reason;
    await manager.getRepository(AuthSession).save(session);
  }

  private parse(token: string): { sessionId: string; secret: string } | null {
    if (typeof token !== 'string') return null;
    const [sessionId, secret, ...rest] = token.trim().split('.');
    if (rest.length || !UUID_REGEX.test(sessionId ?? '') || !SECRET.test(secret ?? '')) return null;
    return { sessionId, secret };
  }

  private newSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(secret: string): string {
    return createHmac('sha256', this.config.auth.refreshTokenPepper).update(secret).digest('hex');
  }

  private equals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private min(a: Date, b: Date): Date {
    return a.getTime() <= b.getTime() ? a : b;
  }
}
