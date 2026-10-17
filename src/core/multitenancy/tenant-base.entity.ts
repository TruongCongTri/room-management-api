import { Column, Index } from 'typeorm';
import { EnterpriseBaseEntity } from '../database/base.entity';

/**
 * Entity thuộc phạm vi một tòa nhà: cột `building_id` là khóa cô lập của PostgreSQL RLS
 * (policy tenant_isolation_policy) và được TenancySubscriber tự gán khi INSERT.
 */
export abstract class BuildingScopedEntity extends EnterpriseBaseEntity {
  @Index()
  @Column({
    type: 'uuid',
    name: 'building_id',
    nullable: false,
    update: false, // Bất biến: không cho phép chuyển bản ghi sang tòa nhà khác sau khi tạo
  })
  buildingId: string;
}
