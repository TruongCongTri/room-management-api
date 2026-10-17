import { CreateDateColumn, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { User } from './user.entity';
import { SystemRole } from './system-role.entity';

/** Vai trò của tài khoản (tài liệu 03, I-2) - áp dụng tại mọi tòa nhà trong user_building_access */
@Auditable({ resource: 'user_roles' })
@Entity('user_roles')
@Index('idx_user_roles_role', ['roleCode'])
export class UserRole {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  /** FK system_roles.code: LANDLORD | PROPERTY_MANAGER | ACCOUNTANT | GUARD | TENANT */
  @PrimaryColumn({ type: 'varchar', length: 50 })
  roleCode: string;

  /** null = hệ thống (tạo tài khoản khách thuê khi chuyển đến) */
  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.roles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_user_roles_user' })
  user?: User;

  @ManyToOne(() => SystemRole)
  @JoinColumn({ name: 'role_code', foreignKeyConstraintName: 'fk_user_roles_role' })
  role?: SystemRole;
}
