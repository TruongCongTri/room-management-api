import { Check, Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { FieldEncryptionTransformer } from '../../../core/security/encryption/encryption.transformer';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { IdDocumentType } from '../../contracts/domain/occupancy.enums';
import type { Gender } from '../domain/tenant-profile.rules';
import { User } from '../../identity/entities/user.entity';

/**
 * Hồ sơ MỘT người ở (tài liệu 03, mục 3.2 #6): người đứng tên, người ở cùng, trẻ em - mỗi người một giấy tờ.
 *  - Số giấy tờ & tài khoản hoàn cọc mã hóa AES-256-GCM, cột mã hóa `select: false` → không bao giờ được nạp
 *    (và giải mã) trong luồng thông thường; hiển thị bằng 4 ký tự cuối.
 *  - id_card_hash (HMAC) duy nhất theo tòa nhà → phát hiện trùng / tra cứu không cần giải mã.
 *  - Người giám hộ của trẻ em: FK tổng hợp cùng tòa nhà.
 */
@Auditable({ resource: 'tenants', redact: ['idCardEncrypted', 'idCardHash', 'refundBankAccountEncrypted', 'dateOfBirth'] })
@Entity('tenants')
@Index('idx_tenants_bld_id_hash_unique', ['buildingId', 'idCardHash'], { unique: true })
@Index('idx_tenants_bld_phone', ['buildingId', 'phone'])
@Index('idx_tenants_bld_name_search', ['buildingId', 'fullNameSearch'])
@Index('idx_tenants_bld_user_unique', ['buildingId', 'userId'], { unique: true, where: '"user_id" IS NOT NULL AND "deleted_at" IS NULL' })
@Unique('uq_tenants_bld_id', ['buildingId', 'id'])
@Check('chk_tenants_guardian_not_self', `"consent_guardian_tenant_id" IS NULL OR "consent_guardian_tenant_id" <> "id"`)
@Check('chk_tenants_gender', `"gender" IN ('MALE', 'FEMALE')`)
@Check('chk_tenants_nationality', `"nationality" ~ '^[A-Z]{2}$'`)
@Check('chk_tenants_id_hash', `"id_card_hash" ~ '^[0-9a-f]{64}$'`)
@Check('chk_tenants_cccd_vietnamese', `"id_document_type" <> 'CCCD' OR "nationality" = 'VN'`)
@Check('chk_tenants_phone_e164', `"phone" IS NULL OR "phone" ~ '^\\+[1-9][0-9]{7,14}$'`)
export class Tenant extends BuildingScopedEntity {
  @Column({ type: 'varchar', length: 150 })
  fullName: string;

  /** Chữ thường, không dấu ("nguyen van duc") - tìm theo tên không cần extension unaccent */
  @Column({ type: 'varchar', length: 150 })
  fullNameSearch: string;

  @Column({ type: 'enum', enum: IdDocumentType, default: IdDocumentType.CCCD })
  idDocumentType: IdDocumentType;

  /** enc:v1:<iv>:<tag>:<cipher> - chỉ trình dựng CT01 (module 6) đọc cột này */
  @Column({ type: 'text', select: false, transformer: new FieldEncryptionTransformer() })
  idCardEncrypted: string;

  /** HMAC-SHA256(số đã chuẩn hóa, BLIND_INDEX_PEPPER) */
  @Column({ type: 'char', length: 64 })
  idCardHash: string;

  @Column({ type: 'varchar', length: 4 })
  idCardLast4: string;

  @Column({ type: 'date', nullable: true })
  idCardIssueDate?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  idCardIssuePlace?: string | null;

  /** Ảnh giấy tờ (storage riêng tư) - cột có sẵn, endpoint tải lên ngoài phạm vi hiện tại */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idDocumentFrontKey?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idDocumentBackKey?: string | null;

  @Column({ type: 'char', length: 2, default: 'VN' })
  nationality: string;

  @Column({ type: 'varchar', length: 10 })
  gender: Gender;

  @Column({ type: 'date' })
  dateOfBirth: string;

  /** E.164 - cùng cách chuẩn hóa với số đăng nhập để ghép tài khoản khi chuyển đến */
  @Column({ type: 'varchar', length: 16, nullable: true })
  phone?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  email?: string | null;

  @Column({ type: 'varchar', length: 255 })
  hometownAddress: string;

  @Column({ type: 'varchar', length: 255 })
  permanentAddress: string;

  @Column({ type: 'text', nullable: true, select: false, transformer: new FieldEncryptionTransformer() })
  refundBankAccountEncrypted?: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  refundBankAccountLast4?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  refundBankName?: string | null;

  @Column({ type: 'timestamptz' })
  pdplConsentAcceptedAt: Date;

  @Column({ type: 'varchar', length: 30, default: 'v2026.1' })
  pdplConsentVersion: string;

  @Column({ type: 'uuid', nullable: true })
  consentGuardianTenantId?: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_tenants_guardian_same_building' },
    { name: 'consent_guardian_tenant_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_tenants_guardian_same_building' },
  ])
  consentGuardian?: Tenant | null;

  /** Tài khoản TENANT (users.id) - liên kết lúc chuyển đến (module 3) */
  @Column({ type: 'uuid', nullable: true })
  userId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_tenants_user' })
  user?: User | null;
}
