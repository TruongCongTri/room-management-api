import { Check, Column, Entity, Index, Unique } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';

export enum ServiceChargeUnit {
  /** Wi-Fi: 150.000 VND / phòng / tháng */
  PER_ROOM_MONTH = 'PER_ROOM_MONTH',
  /** Rác, thang máy: 50.000 VND / người / tháng - số lượng = số người đang ở */
  PER_PERSON_MONTH = 'PER_PERSON_MONTH',
  /** Gửi xe máy: 150.000 VND / xe / tháng - số lượng = số xe đang hoạt động cùng loại */
  PER_VEHICLE_MONTH = 'PER_VEHICLE_MONTH',
}

export enum VehicleType {
  MOTORBIKE = 'MOTORBIKE',
  /** Theo dõi riêng vì an toàn PCCC khi sạc */
  ELECTRIC_BIKE = 'ELECTRIC_BIKE',
  BICYCLE = 'BICYCLE',
  CAR = 'CAR',
}

/**
 * Danh mục dịch vụ đi kèm của tòa nhà (tài liệu 03, mục 3.2 #10 + 3.2b). Dịch vụ theo xe ghi rõ loại xe (mỗi loại xe
 * một dịch vụ) để đăng ký xe tự gắn đúng gói gửi xe.
 */
@Auditable({ resource: 'service_catalogs' })
@Entity('service_catalogs')
@Index('idx_service_catalogs_bld_code_unique', ['buildingId', 'code'], { unique: true, where: '"deleted_at" IS NULL' })
@Index('idx_service_catalogs_bld_vehicle_unique', ['buildingId', 'vehicleType'], {
  unique: true,
  where: '"vehicle_type" IS NOT NULL AND "deleted_at" IS NULL',
})
@Unique('uq_service_catalogs_bld_id', ['buildingId', 'id'])
@Check('chk_service_catalogs_code', `"code" ~ '^[A-Z][A-Z0-9_]{1,49}$'`)
@Check('chk_service_catalogs_price', `"default_unit_price" >= 0`)
@Check('chk_service_catalogs_vehicle', `("charge_unit" = 'PER_VEHICLE_MONTH') = ("vehicle_type" IS NOT NULL)`)
export class ServiceCatalog extends BuildingScopedEntity {
  /** "WIFI", "PARKING_MOTORBIKE", "SANITATION" */
  @Column({ type: 'varchar', length: 50 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'enum', enum: ServiceChargeUnit })
  chargeUnit: ServiceChargeUnit;

  /** Bắt buộc đúng với PER_VEHICLE_MONTH */
  @Column({ type: 'enum', enum: VehicleType, nullable: true })
  vehicleType?: VehicleType | null;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  defaultUnitPrice: string;

  @Column({ type: 'boolean', default: true })
  isProratableOnCheckout: boolean;
}
