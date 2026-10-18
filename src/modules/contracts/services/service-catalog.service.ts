/**
 * Danh mục dịch vụ đi kèm của tòa nhà (tài liệu 02, mục 5.5.3). Dịch vụ theo xe ghi loại xe (mỗi loại một dịch vụ).
 * Khi còn hợp đồng nháp / hiệu lực đang dùng: không đổi cách tính phí / loại xe, không xóa (409 BIZ_SERVICE_IN_USE);
 * đổi giá mặc định không ảnh hưởng giá đã thỏa thuận trên hợp đồng.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { alreadyExists, assertSomethingToUpdate, isUniqueViolation, notFound, staleVersion, toNumber } from '../../properties/properties.helpers';
import { ContractStatus } from '../entities/contract.entity';
import { ContractServiceSubscription } from '../entities/contract-service.entity';
import { ServiceCatalog, ServiceChargeUnit, VehicleType } from '../entities/service-catalog.entity';
import { CreateServiceCatalogDto, UpdateServiceCatalogDto } from '../dto/contracts.dto';
import { invalid } from './contract-helpers';

const CODE_INDEX = 'idx_service_catalogs_bld_code_unique';
const VEHICLE_INDEX = 'idx_service_catalogs_bld_vehicle_unique';

export interface ServiceCatalogView {
  id: string;
  code: string;
  name: string;
  chargeUnit: ServiceChargeUnit;
  vehicleType: VehicleType | null;
  defaultUnitPrice: number;
  isProratableOnCheckout: boolean;
  version: number;
}

@Injectable()
export class ServiceCatalogService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
  ) {}

  list(): Promise<ServiceCatalogView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      const rows = await manager.getRepository(ServiceCatalog).find({ where: { buildingId: this.buildingId() }, order: { code: 'ASC' } });
      return rows.map((c) => this.view(c));
    });
  }

  async create(dto: CreateServiceCatalogDto): Promise<ServiceCatalogView> {
    const vehicleType = dto.vehicleType ?? null;
    this.assertVehicleRule(dto.chargeUnit, vehicleType);
    return this.write(async (manager) => {
      const repo = manager.getRepository(ServiceCatalog);
      if (await repo.exists({ where: { buildingId: this.buildingId(), code: dto.code } })) throw alreadyExists('code', dto.code);
      if (vehicleType && (await repo.exists({ where: { buildingId: this.buildingId(), vehicleType } }))) throw alreadyExists('vehicleType', vehicleType);
      const saved = await repo.save(
        repo.create({
          code: dto.code,
          name: dto.name,
          chargeUnit: dto.chargeUnit,
          vehicleType,
          defaultUnitPrice: String(dto.defaultUnitPrice),
          isProratableOnCheckout: dto.isProratableOnCheckout ?? true,
        }),
      );
      return this.view(saved);
    }, dto.code, vehicleType);
  }

  async update(id: string, dto: UpdateServiceCatalogDto): Promise<ServiceCatalogView> {
    assertSomethingToUpdate(dto);
    return this.write(async (manager) => {
      const repo = manager.getRepository(ServiceCatalog);
      const item = await repo.findOne({ where: { id, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
      if (!item) throw notFound('Service');
      if (dto.version !== undefined && dto.version !== item.version) throw staleVersion();
      const chargeUnit = dto.chargeUnit ?? item.chargeUnit;
      const vehicleType =
        dto.vehicleType !== undefined ? dto.vehicleType : chargeUnit === ServiceChargeUnit.PER_VEHICLE_MONTH ? (item.vehicleType ?? null) : null;
      this.assertVehicleRule(chargeUnit, vehicleType);
      if ((chargeUnit !== item.chargeUnit || vehicleType !== (item.vehicleType ?? null)) && (await this.inUse(manager, item.id))) {
        throw this.inUseError('chargeUnit');
      }
      if (vehicleType && vehicleType !== item.vehicleType && (await repo.exists({ where: { buildingId: this.buildingId(), vehicleType } }))) {
        throw alreadyExists('vehicleType', vehicleType);
      }
      item.chargeUnit = chargeUnit;
      item.vehicleType = vehicleType;
      if (dto.name !== undefined) item.name = dto.name;
      if (dto.defaultUnitPrice !== undefined) item.defaultUnitPrice = String(dto.defaultUnitPrice);
      if (dto.isProratableOnCheckout !== undefined) item.isProratableOnCheckout = dto.isProratableOnCheckout;
      return this.view(await repo.save(item));
    }, undefined, dto.vehicleType ?? null);
  }

  async remove(id: string): Promise<void> {
    await this.rls.runInTenantContext(async (manager) => {
      const repo = manager.getRepository(ServiceCatalog);
      const item = await repo.findOne({ where: { id, buildingId: this.buildingId() }, lock: { mode: 'pessimistic_write' } });
      if (!item) throw notFound('Service');
      if (await this.inUse(manager, item.id)) throw this.inUseError('id');
      await repo.softRemove(item);
    });
  }

  // ----------------------------------------------------------------------------

  /** Còn gói đang dùng trên hợp đồng nháp / hiệu lực */
  private inUse(manager: EntityManager, catalogId: string): Promise<boolean> {
    return manager
      .getRepository(ContractServiceSubscription)
      .createQueryBuilder('s')
      .innerJoin('s.contract', 'c')
      .where('s.service_catalog_id = :catalogId AND c.status IN (:...open)', { catalogId, open: [ContractStatus.DRAFT, ContractStatus.ACTIVE] })
      .getExists();
  }

  private assertVehicleRule(chargeUnit: ServiceChargeUnit, vehicleType: VehicleType | null): void {
    if (chargeUnit === ServiceChargeUnit.PER_VEHICLE_MONTH && !vehicleType) {
      throw invalid([{ field: 'vehicleType', message: 'Required for a per-vehicle service' }]);
    }
    if (chargeUnit !== ServiceChargeUnit.PER_VEHICLE_MONTH && vehicleType) {
      throw invalid([{ field: 'vehicleType', message: 'Only per-vehicle services have a vehicle type' }]);
    }
  }

  private inUseError(field: string) {
    return new ConflictException({
      errorCode: SystemErrorCode.BIZ_SERVICE_IN_USE,
      message: 'Contracts subscribe to this service.',
      details: [{ field, issue: 'IN_USE' }],
    });
  }

  private view(c: ServiceCatalog): ServiceCatalogView {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      chargeUnit: c.chargeUnit,
      vehicleType: c.vehicleType ?? null,
      defaultUnitPrice: toNumber(c.defaultUnitPrice)!,
      isProratableOnCheckout: c.isProratableOnCheckout,
      version: c.version,
    };
  }

  private async write<T>(fn: (manager: EntityManager) => Promise<T>, code: string | undefined, vehicleType: VehicleType | null): Promise<T> {
    try {
      return await this.rls.runInTenantContext(fn);
    } catch (err) {
      if (isUniqueViolation(err, CODE_INDEX)) throw alreadyExists('code', code ?? '');
      if (isUniqueViolation(err, VEHICLE_INDEX)) throw alreadyExists('vehicleType', vehicleType ?? '');
      throw err;
    }
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
