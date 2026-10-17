import { CreateDateColumn, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { User } from './user.entity';

/** Tòa nhà tài khoản được truy cập (tài liệu 03, I-3) → claim `buildingIds`, chuyển bằng X-Building-ID */
@Auditable({ resource: 'user_building_access' })
@Entity('user_building_access')
@Index('idx_user_building_access_building', ['buildingId'])
export class UserBuildingAccess {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  /** FK buildings.id (ràng buộc được thêm ở migration Properties - module 1) */
  @PrimaryColumn({ type: 'uuid' })
  buildingId: string;

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.buildingAccess, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_user_building_access_user' })
  user?: User;
}
