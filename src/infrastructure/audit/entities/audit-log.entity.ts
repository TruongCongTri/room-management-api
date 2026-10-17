/**
 * Entity bất biến (WORM - Write Once, Read Many).
 * Bảng này tuyệt đối không có cột updated_at hay deleted_at; trigger PostgreSQL (migration
 * CreateInfrastructureTables) chặn UPDATE / DELETE / TRUNCATE ở tầng database.
 *
 * */

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { AuditAction, EntityDiffSnapshot } from '../interfaces/audit.interface';

@Entity('audit_logs')
@Index('idx_audit_bld_created', ['buildingId', 'createdAt'])
@Index('idx_audit_bld_resource', ['buildingId', 'resource', 'resourceId'])
@Index('idx_audit_actor_created_desc', ['actorId', 'createdAt'])
@Index('idx_audit_department_created', ['departmentId', 'createdAt'])
@Index('idx_audit_created_tiering', ['createdAt']) // Job lưu trữ 90 ngày sang S3 Glacier
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Tòa nhà phát sinh thay đổi; NULL với sự kiện hệ thống không thuộc tòa nhà nào (đăng nhập, cron toàn cục) */
  @Column({ type: 'uuid', name: 'building_id', nullable: true })
  buildingId?: string | null;

  @Column({ type: 'varchar', length: 100, name: 'actor_id' })
  actorId: string;

  /** Nhãn hiển thị của người thực hiện: số điện thoại đã che (090****567); NULL với tác vụ hệ thống */
  @Column({ type: 'varchar', length: 255, name: 'actor_label', nullable: true })
  actorLabel?: string | null;

  @Column({ type: 'varchar', length: 100, name: 'department_id', nullable: true })
  departmentId?: string | null;

  @Column({ type: 'enum', enum: AuditAction })
  action: AuditAction;

  @Column({ type: 'varchar', length: 255 })
  resource: string;

  @Column({ type: 'varchar', length: 255, name: 'resource_id' })
  resourceId: string;

  // Lưu trữ khác biệt dữ liệu (old_val vs new_val) dạng JSONB
  @Column({ type: 'jsonb', nullable: true, name: 'diff_snapshot' })
  diffSnapshot?: EntityDiffSnapshot | null;

  // Siêu dữ liệu ngữ cảnh: HTTP method/path/status/duration, lý do, kênh thao tác...
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 128, name: 'trace_id' })
  traceId: string;

  @Column({ type: 'varchar', length: 45, name: 'client_ip' })
  clientIp: string;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  userAgent?: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
