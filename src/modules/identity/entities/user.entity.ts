import { Check, Column, Entity, Index, OneToMany } from 'typeorm';
import { EnterpriseBaseEntity } from '../../../core/database/base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { UserRole } from './user-role.entity';
import { UserBuildingAccess } from './user-building-access.entity';

export enum UserStatus {
  /** Do chủ nhà tạo hoặc tạo tự động khi người ở chuyển đến; chưa có mật khẩu */
  PENDING_ACTIVATION = 'PENDING_ACTIVATION',
  ACTIVE = 'ACTIVE',
  /** Bị chủ nhà vô hiệu hóa; mọi phiên bị thu hồi */
  DISABLED = 'DISABLED',
}

/**
 * Tài khoản đăng nhập (tài liệu 03, I-1). Bảng toàn cục, không RLS: đăng nhập diễn ra trước khi chọn tòa nhà.
 * Định danh đăng nhập = số điện thoại E.164; một người một tài khoản.
 */
@Auditable({ resource: 'users', exclude: ['lastLoginAt'], redact: ['passwordHash'] })
@Entity('users')
@Index('idx_users_phone_unique', ['phoneE164'], { unique: true, where: '"deleted_at" IS NULL' })
@Check('chk_users_phone_e164', `"phone_e164" ~ '^\\+[1-9][0-9]{7,14}$'`)
@Check('chk_users_active_has_password', `"status" <> 'ACTIVE' OR "password_hash" IS NOT NULL`)
export class User extends EnterpriseBaseEntity {
  /** E.164 (+84901234567), chuẩn hóa bởi PhoneNumber.normalize() */
  @Column({ type: 'varchar', length: 16 })
  phoneE164: string;

  /** Lần đầu xác thực OTP thành công (kích hoạt tài khoản) */
  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt?: Date | null;

  @Column({ type: 'varchar', length: 150 })
  fullName: string;

  /** argon2id - không bao giờ được SELECT trừ khi yêu cầu tường minh (addSelect) */
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  passwordHash?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt?: Date | null;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING_ACTIVATION })
  status: UserStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt?: Date | null;

  /** Ngôn ngữ của OTP và cảnh báo bảo mật */
  @Column({ type: 'varchar', length: 10, default: 'vi-VN' })
  preferredLocale: string;

  @OneToMany(() => UserRole, (role) => role.user)
  roles: UserRole[];

  @OneToMany(() => UserBuildingAccess, (access) => access.user)
  buildingAccess: UserBuildingAccess[];
}
