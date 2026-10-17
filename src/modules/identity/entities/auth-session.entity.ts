import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

export enum SessionRevokedReason {
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  ROTATION_REUSE_DETECTED = 'ROTATION_REUSE_DETECTED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  /** Chủ nhà gỡ vai trò hoặc tòa nhà */
  ACCESS_REDUCED = 'ACCESS_REDUCED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  /** DELETE /auth/sessions/{id} */
  REVOKED_BY_USER = 'REVOKED_BY_USER',
}

/**
 * Một dòng cho mỗi thiết bị đã đăng nhập (tài liệu 03, I-4). Refresh token = `<sessionId>.<secret>`,
 * chỉ lưu HMAC-SHA256(secret). Mỗi lần refresh: hash cũ chuyển sang previous_refresh_token_hash;
 * nếu token cũ đó được dùng lại → thu hồi cả phiên (ROTATION_REUSE_DETECTED).
 * Bảng kỹ thuật: không @Auditable (sự kiện bảo mật được ghi audit tường minh bởi AuthService).
 */
@Entity('auth_sessions')
@Index('idx_auth_sessions_user_active', ['userId', 'lastUsedAt'], { where: '"revoked_at" IS NULL' })
@Check('chk_sessions_expiry', `"absolute_expires_at" > "created_at" AND "idle_expires_at" <= "absolute_expires_at"`)
@Check('chk_sessions_revocation', `("revoked_at" IS NULL) = ("revoked_reason" IS NULL)`)
export class AuthSession {
  /** = claim `sid` của mọi access token thuộc phiên */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'char', length: 64 })
  refreshTokenHash: string;

  @Column({ type: 'char', length: 64, nullable: true })
  previousRefreshTokenHash?: string | null;

  @Column({ type: 'int', default: 0 })
  rotationCount: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  deviceId?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  deviceName?: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent?: string | null;

  /** IP gần nhất sử dụng phiên */
  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  /** Vai trò tài chính: thời điểm vượt bước OTP */
  @Column({ type: 'timestamptz', nullable: true })
  mfaVerifiedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;

  /** lastUsedAt + JWT_REFRESH_EXPIRES_IN (trượt), không bao giờ vượt absoluteExpiresAt */
  @Column({ type: 'timestamptz' })
  idleExpiresAt: Date;

  /** createdAt + AUTH_REFRESH_ABSOLUTE_EXPIRES_IN, không bao giờ gia hạn */
  @Column({ type: 'timestamptz' })
  absoluteExpiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ type: 'enum', enum: SessionRevokedReason, nullable: true })
  revokedReason?: SessionRevokedReason | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_auth_sessions_user' })
  user?: User;
}
