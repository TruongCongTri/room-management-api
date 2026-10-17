import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  BaseEntity,
} from 'typeorm';

/**
 * Entity chuẩn cho bảng danh mục / toàn cục: UUID v4, mốc thời gian, xóa mềm và khóa lạc quan.
 * Bảng thuộc một tòa nhà kế thừa BuildingScopedEntity (core/multitenancy).
 */
export abstract class EnterpriseBaseEntity extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;

  // Soft Delete: Giữ dữ liệu phục vụ đối soát tài chính, thuế và cư trú - không xóa vật lý
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;

  // Khóa lạc quan (Optimistic Locking): ngăn hai quản lý ghi đè cùng hợp đồng / hóa đơn
  @VersionColumn({ default: 1 })
  version: number;
}
