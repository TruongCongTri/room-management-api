import { Check, Column, Entity, Index, OneToMany } from 'typeorm';
import { EnterpriseBaseEntity } from '../../../core/database/base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Room } from './room.entity';

export enum ElectricityBillingMode {
  /** Thông tư 16/2014 & 09/2023/TT-BCT: định mức bậc thang theo số người đăng ký tạm trú */
  EVN_TIERED_QUOTA = 'EVN_TIERED_QUOTA',
  /** Giá bán lẻ bậc 3 đồng nhất khi người ở chưa đăng ký đủ định mức */
  EVN_TIER_3_FLAT = 'EVN_TIER_3_FLAT',
}

/**
 * Tòa nhà (tài liệu 03, mục 3.1 #1). Bảng TOÀN CỤC, không RLS: quyền truy cập đi qua user_building_access.
 * Không bao giờ xóa (lịch sử thuế, hóa đơn, cư trú).
 */
@Auditable({ resource: 'buildings', redact: ['bankAccountNumber'] })
@Entity('buildings')
@Check('chk_buildings_values', `"total_rooms_capacity" BETWEEN 1 AND 500 AND "default_water_rate_per_m3" >= 0`)
@Check('chk_buildings_public_slug', `"public_slug" IS NULL OR "public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)
@Check('chk_buildings_listed_has_slug', `NOT "is_publicly_listed" OR "public_slug" IS NOT NULL`)
export class Building extends EnterpriseBaseEntity {
  @Index('idx_buildings_code_unique', { unique: true })
  @Column({ type: 'varchar', length: 30 })
  code: string; // "BLD-HCM-Q7-01"

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  addressLine: string;

  @Column({ type: 'varchar', length: 100 })
  ward: string;

  @Column({ type: 'varchar', length: 100 })
  district: string;

  @Column({ type: 'varchar', length: 100, default: 'Thành phố Hồ Chí Minh' })
  city: string;

  /** Mã số thuế hộ kinh doanh cho thuê */
  @Index('idx_buildings_tax_code')
  @Column({ type: 'varchar', length: 30 })
  landlordTaxCode: string;

  @Column({ type: 'varchar', length: 150 })
  landlordFullName: string;

  /** Tài khoản nhận tiền cho mã VietQR động */
  @Column({ type: 'varchar', length: 50, nullable: true })
  bankAccountNumber?: string | null;

  /** BIN ngân hàng NAPAS (vd: 970436 Vietcombank) */
  @Column({ type: 'varchar', length: 20, nullable: true })
  bankBinCode?: string | null;

  @Column({ type: 'smallint', default: 80 })
  totalRoomsCapacity: number;

  @Column({ type: 'enum', enum: ElectricityBillingMode, default: ElectricityBillingMode.EVN_TIERED_QUOTA })
  electricityBillingMode: ElectricityBillingMode;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 25000 })
  defaultWaterRatePerM3: string;

  /** Website giới thiệu (module 1b): chỉ hiện trên /public/* khi được bật VÀ có slug */
  @Column({ type: 'boolean', default: false })
  isPubliclyListed: boolean;

  @Index('idx_buildings_public_slug_unique', { unique: true, where: '"public_slug" IS NOT NULL' })
  @Column({ type: 'varchar', length: 80, nullable: true })
  publicSlug?: string | null; // "sunrise-quan-7"

  @Column({ type: 'text', nullable: true })
  publicDescription?: string | null;

  @OneToMany(() => Room, (room) => room.building)
  rooms?: Room[];
}
