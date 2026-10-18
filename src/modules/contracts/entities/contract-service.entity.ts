import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';
import { Auditable } from '../../../infrastructure/audit/decorators/auditable.decorator';
import { Contract } from './contract.entity';
import { ServiceCatalog, ServiceChargeUnit } from './service-catalog.entity';

/**
 * Dịch vụ đi kèm của một hợp đồng (tài liệu 03, mục 3.2 #11 + 3.2b): giá thỏa thuận theo hợp đồng; số lượng dịch vụ theo
 * người / theo xe do hệ thống tính lại, không nhập tay. Một gói còn hiệu lực cho mỗi dịch vụ của mỗi hợp đồng.
 */
@Auditable({ resource: 'contract_services' })
@Entity('contract_services')
@Index('idx_contract_services_contract_id', ['contractId'])
@Index('idx_contract_services_contract_catalog_unique', ['contractId', 'serviceCatalogId'], { unique: true, where: '"deleted_at" IS NULL' })
@Check('chk_contract_services_values', `"quantity" >= 1 AND "agreed_unit_price" >= 0`)
export class ContractServiceSubscription extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contract_services_contract_same_building' },
    { name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_services_contract_same_building' },
  ])
  contract?: Contract;

  @Column({ type: 'uuid' })
  serviceCatalogId: string;

  @ManyToOne(() => ServiceCatalog, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'building_id', referencedColumnName: 'buildingId', foreignKeyConstraintName: 'fk_contract_services_catalog_same_building' },
    { name: 'service_catalog_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_services_catalog_same_building' },
  ])
  serviceCatalog?: ServiceCatalog;

  /** Ảnh chụp mã & cách tính phí tại thời điểm đăng ký */
  @Column({ type: 'varchar', length: 50 })
  serviceCode: string;

  @Column({ type: 'enum', enum: ServiceChargeUnit })
  chargeUnit: ServiceChargeUnit;

  @Column({ type: 'smallint', default: 1 })
  quantity: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  agreedUnitPrice: string;
}
