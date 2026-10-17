import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Danh mục vai trò hệ thống (bảng tham chiếu do 1792250000000 tạo và DatabaseSeeder nạp từ code).
 * Chỉ đọc trong ứng dụng; khai báo entity để quan hệ user_roles.role_code → system_roles.code được mô hình hóa.
 */
@Entity('system_roles')
export class SystemRole {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'boolean', default: true })
  isSystem: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
