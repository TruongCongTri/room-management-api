/**
 * Xe & dịch vụ đi kèm của hợp đồng (tài liệu 02, mục 5.5.3 - quyết định D8).
 *  - Giá thỏa thuận theo hợp đồng; số lượng: theo phòng = quản lý nhập, theo người = số người đang ở (bản nháp: số người
 *    dự kiến), theo xe = số xe đang hoạt động cùng loại → syncDerivedServices() tính lại sau mọi thay đổi người ở / xe.
 *  - Mọi thay đổi khóa dòng hợp đồng (FOR UPDATE) → các lần tính lại không chen nhau.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In, IsNull, Not } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { alreadyExists, isUniqueViolation, nothingToUpdate, notFound, toNumber, vietnamToday } from '../../properties/properties.helpers';
import { OccupancyStatus } from '../domain/occupancy.enums';
import { isValidLicensePlate, normalizeLicensePlate } from '../domain/contract.rules';
import { Contract, ContractStatus } from '../entities/contract.entity';
import { ContractOccupant } from '../entities/contract-occupant.entity';
import { ContractServiceSubscription } from '../entities/contract-service.entity';
import { ServiceCatalog, ServiceChargeUnit, VehicleType } from '../entities/service-catalog.entity';
import { TenantVehicle } from '../entities/tenant-vehicle.entity';
import { AddContractServiceDto, DeactivateVehicleDto, RegisterVehicleDto, UpdateContractServiceDto, UpdateVehicleDto } from '../dto/contracts.dto';
import { activeOccupantCount, findContract, invalid, lockContract, notActive } from './contract-helpers';

const PLATE_INDEX = 'idx_vehicles_bld_active_plate_unique';
const CARD_INDEX = 'idx_vehicles_bld_active_card_unique';
const SUBSCRIPTION_INDEX = 'idx_contract_services_contract_catalog_unique';

export type QuantitySource = 'MANUAL' | 'OCCUPANTS' | 'VEHICLES';

export interface ContractServiceView {
  subscriptionId: string;
  serviceCatalogId: string;
  serviceCode: string;
  name: string;
  chargeUnit: ServiceChargeUnit;
  quantity: number;
  agreedUnitPrice: number;
  quantitySource: QuantitySource;
}

export interface VehicleView {
  id: string;
  ownerTenantId: string;
  ownerName: string;
  vehicleType: VehicleType;
  licensePlate: string | null;
  brandModel: string;
  parkingCardCode: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: Date;
}

const SOURCE: Record<ServiceChargeUnit, QuantitySource> = {
  [ServiceChargeUnit.PER_ROOM_MONTH]: 'MANUAL',
  [ServiceChargeUnit.PER_PERSON_MONTH]: 'OCCUPANTS',
  [ServiceChargeUnit.PER_VEHICLE_MONTH]: 'VEHICLES',
};

const OPEN = [ContractStatus.DRAFT, ContractStatus.ACTIVE];

@Injectable()
export class ContractExtrasService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
  ) {}

  // ============================================================================ services

  listServices(contractId: string): Promise<ContractServiceView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      await findContract(manager, this.buildingId(), contractId);
      return this.loadServices(manager, contractId);
    });
  }

  addService(contractId: string, dto: AddContractServiceDto): Promise<ContractServiceView> {
    return this.write(async (manager) => {
      const contract = await this.lockOpen(manager, contractId);
      const catalog = await manager.getRepository(ServiceCatalog).findOne({ where: { id: dto.serviceCatalogId, buildingId: this.buildingId() } });
      if (!catalog) throw notFound('Service', 'serviceCatalogId');
      if (catalog.chargeUnit === ServiceChargeUnit.PER_VEHICLE_MONTH) throw this.derived('Per-vehicle services follow the registered vehicles');
      if (catalog.chargeUnit === ServiceChargeUnit.PER_PERSON_MONTH && dto.quantity !== undefined) {
        throw this.derived('Per-person services follow the number of occupants');
      }
      const repo = manager.getRepository(ContractServiceSubscription);
      if (await repo.exists({ where: { contractId, serviceCatalogId: catalog.id } })) throw alreadyExists('serviceCatalogId', catalog.code);
      const saved = await repo.save(
        repo.create({
          contractId,
          serviceCatalogId: catalog.id,
          serviceCode: catalog.code,
          chargeUnit: catalog.chargeUnit,
          quantity: catalog.chargeUnit === ServiceChargeUnit.PER_ROOM_MONTH ? (dto.quantity ?? 1) : 1,
          agreedUnitPrice: String(dto.agreedUnitPrice ?? toNumber(catalog.defaultUnitPrice)),
        }),
      );
      await this.syncDerivedServices(manager, contract);
      return this.serviceView(manager, contractId, saved.id);
    }, SUBSCRIPTION_INDEX, () => alreadyExists('serviceCatalogId', dto.serviceCatalogId));
  }

  updateService(contractId: string, subscriptionId: string, dto: UpdateContractServiceDto): Promise<ContractServiceView> {
    if (dto.quantity === undefined && dto.agreedUnitPrice === undefined) throw nothingToUpdate();
    return this.write(async (manager) => {
      await this.lockOpen(manager, contractId);
      const repo = manager.getRepository(ContractServiceSubscription);
      const sub = await this.findSubscription(manager, contractId, subscriptionId);
      if (dto.quantity !== undefined) {
        if (sub.chargeUnit !== ServiceChargeUnit.PER_ROOM_MONTH) throw this.derived('Only per-room services have a quantity you set');
        sub.quantity = dto.quantity;
      }
      if (dto.agreedUnitPrice !== undefined) sub.agreedUnitPrice = String(dto.agreedUnitPrice);
      await repo.save(sub);
      return this.serviceView(manager, contractId, sub.id);
    });
  }

  removeService(contractId: string, subscriptionId: string): Promise<void> {
    return this.write(async (manager) => {
      await this.lockOpen(manager, contractId);
      const sub = await this.findSubscription(manager, contractId, subscriptionId);
      if (sub.chargeUnit === ServiceChargeUnit.PER_VEHICLE_MONTH) throw this.derived('Deactivate the vehicles to end a parking subscription');
      await manager.getRepository(ContractServiceSubscription).softRemove(sub);
    });
  }

  /**
   * Tính lại số lượng dịch vụ theo người / theo xe của hợp đồng. Gọi trong transaction, sau khi người ở hoặc xe thay đổi.
   *  - Theo người: số người đang ở (bản nháp: người đứng tên + người dự kiến), tối thiểu 1.
   *  - Theo xe (chỉ hợp đồng hiệu lực): mỗi dịch vụ theo xe của tòa nhà = số xe đang hoạt động cùng loại; 0 xe → gỡ gói.
   */
  async syncDerivedServices(manager: EntityManager, contract: Contract): Promise<void> {
    const subs = manager.getRepository(ContractServiceSubscription);
    const people =
      contract.status === ContractStatus.DRAFT ? 1 + (contract.plannedCoOccupants?.length ?? 0) : await activeOccupantCount(manager, contract.id);
    // save() từng dòng (không update hàng loạt): audit ghi được dòng nào đổi số lượng từ bao nhiêu
    const perPerson = await subs.find({ where: { contractId: contract.id, chargeUnit: ServiceChargeUnit.PER_PERSON_MONTH, quantity: Not(Math.max(1, people)) } });
    for (const sub of perPerson) {
      sub.quantity = Math.max(1, people);
      await subs.save(sub);
    }
    if (contract.status !== ContractStatus.ACTIVE) return;

    const counts = await manager
      .getRepository(TenantVehicle)
      .createQueryBuilder('v')
      .select('v.vehicle_type', 'vehicleType')
      .addSelect('COUNT(*)::int', 'n')
      .where('v.contract_id = :id AND v.is_active', { id: contract.id })
      .groupBy('v.vehicle_type')
      .getRawMany<{ vehicleType: VehicleType; n: number }>();
    const byType = new Map(counts.map((c) => [c.vehicleType, Number(c.n)]));
    const vehicleItems = await manager
      .getRepository(ServiceCatalog)
      .find({ where: { buildingId: contract.buildingId, chargeUnit: ServiceChargeUnit.PER_VEHICLE_MONTH, vehicleType: Not(IsNull()) } });
    const existing = await subs.find({ where: { contractId: contract.id, chargeUnit: ServiceChargeUnit.PER_VEHICLE_MONTH } });

    for (const item of vehicleItems) {
      const n = byType.get(item.vehicleType!) ?? 0;
      const sub = existing.find((s) => s.serviceCatalogId === item.id);
      if (n === 0) {
        if (sub) await subs.softRemove(sub);
      } else if (!sub) {
        await subs.save(
          subs.create({
            contractId: contract.id,
            serviceCatalogId: item.id,
            serviceCode: item.code,
            chargeUnit: item.chargeUnit,
            quantity: n,
            agreedUnitPrice: item.defaultUnitPrice,
          }),
        );
      } else if (sub.quantity !== n) {
        sub.quantity = n;
        await subs.save(sub);
      }
    }
  }

  async loadServices(manager: EntityManager, contractId: string): Promise<ContractServiceView[]> {
    const rows = await manager
      .getRepository(ContractServiceSubscription)
      .createQueryBuilder('s')
      .innerJoinAndSelect('s.serviceCatalog', 'c')
      .withDeleted() // dịch vụ đã gỡ khỏi danh mục vẫn hiển thị trên hợp đồng đang dùng
      .where('s.contract_id = :contractId AND s.building_id = :b AND s.deleted_at IS NULL', { contractId, b: this.buildingId() })
      .orderBy('s.service_code', 'ASC')
      .getMany();
    return rows.map((s) => ({
      subscriptionId: s.id,
      serviceCatalogId: s.serviceCatalogId,
      serviceCode: s.serviceCode,
      name: s.serviceCatalog!.name,
      chargeUnit: s.chargeUnit,
      quantity: s.quantity,
      agreedUnitPrice: toNumber(s.agreedUnitPrice)!,
      quantitySource: SOURCE[s.chargeUnit],
    }));
  }

  // ============================================================================ vehicles

  listVehicles(contractId: string, status: 'ACTIVE' | 'ALL'): Promise<VehicleView[]> {
    return this.rls.runInTenantContext(async (manager) => {
      await findContract(manager, this.buildingId(), contractId);
      const qb = manager
        .getRepository(TenantVehicle)
        .createQueryBuilder('v')
        .innerJoin('v.owner', 't')
        .addSelect(['t.id', 't.fullName'])
        .where('v.contract_id = :contractId AND v.building_id = :b', { contractId, b: this.buildingId() });
      if (status === 'ACTIVE') qb.andWhere('v.is_active');
      const rows = await qb.orderBy('v.is_active', 'DESC').addOrderBy('v.created_at', 'ASC').addOrderBy('v.id', 'ASC').getMany();
      return rows.map((v) => this.vehicleView(v));
    });
  }

  registerVehicle(contractId: string, dto: RegisterVehicleDto): Promise<VehicleView> {
    const plate = normalizeLicensePlate(dto.licensePlate);
    if (dto.vehicleType !== VehicleType.BICYCLE && !plate) {
      throw invalid([{ field: 'licensePlate', message: 'Required for motorised vehicles' }]);
    }
    if (plate && !isValidLicensePlate(plate)) throw invalid([{ field: 'licensePlate', message: 'Not a valid licence plate' }]);
    const card = dto.parkingCardCode ?? null;
    return this.write(
      async (manager) => {
        const contract = await lockContract(manager, this.buildingId(), contractId);
        if (contract.status !== ContractStatus.ACTIVE) throw notActive(contract.status);
        const owner = await manager
          .getRepository(ContractOccupant)
          .exists({ where: { contractId, tenantId: dto.ownerTenantId, status: OccupancyStatus.ACTIVE } });
        if (!owner) {
          throw new ConflictException({
            errorCode: SystemErrorCode.BIZ_OCCUPANT_NOT_ACTIVE,
            message: 'The owner must be someone living in the room under this contract.',
            details: [{ field: 'ownerTenantId', issue: 'NOT_ACTIVE_OCCUPANT' }],
          });
        }
        const repo = manager.getRepository(TenantVehicle);
        if (plate && (await repo.exists({ where: { buildingId: this.buildingId(), licensePlate: plate, isActive: true } }))) {
          throw alreadyExists('licensePlate', plate);
        }
        if (card && (await repo.exists({ where: { buildingId: this.buildingId(), parkingCardCode: card, isActive: true } }))) {
          throw alreadyExists('parkingCardCode', card);
        }
        const vehicle = await repo.save(
          repo.create({
            contractId,
            ownerTenantId: dto.ownerTenantId,
            vehicleType: dto.vehicleType,
            licensePlate: plate,
            brandModel: dto.brandModel,
            parkingCardCode: card,
            isActive: true,
            deactivatedAt: null,
          }),
        );
        await this.syncDerivedServices(manager, contract);
        return this.loadVehicle(manager, vehicle.id);
      },
      [PLATE_INDEX, CARD_INDEX],
      (err) => (isUniqueViolation(err, CARD_INDEX) ? alreadyExists('parkingCardCode', card ?? '') : alreadyExists('licensePlate', plate ?? '')),
    );
  }

  /** Sửa biển số / dòng xe / thẻ xe của xe đang hoạt động (loại xe không đổi: đăng ký xe mới) */
  updateVehicle(contractId: string, vehicleId: string, dto: UpdateVehicleDto): Promise<VehicleView> {
    if (dto.licensePlate === undefined && dto.brandModel === undefined && dto.parkingCardCode === undefined) throw nothingToUpdate();
    const plate = dto.licensePlate !== undefined ? normalizeLicensePlate(dto.licensePlate) : undefined;
    if (plate && !isValidLicensePlate(plate)) throw invalid([{ field: 'licensePlate', message: 'Not a valid licence plate' }]);
    return this.write(
      async (manager) => {
        await lockContract(manager, this.buildingId(), contractId);
        const repo = manager.getRepository(TenantVehicle);
        const vehicle = await repo.findOne({ where: { id: vehicleId, contractId, buildingId: this.buildingId() } });
        if (!vehicle) throw notFound('Vehicle');
        if (!vehicle.isActive) {
          throw new ConflictException({ errorCode: SystemErrorCode.RES_CONFLICT, message: 'The vehicle is inactive.', details: [{ field: 'vehicleId', issue: 'INACTIVE' }] });
        }
        if (plate !== undefined) {
          if (!plate && vehicle.vehicleType !== VehicleType.BICYCLE) throw invalid([{ field: 'licensePlate', message: 'Required for motorised vehicles' }]);
          if (plate && plate !== vehicle.licensePlate && (await repo.exists({ where: { buildingId: this.buildingId(), licensePlate: plate, isActive: true } }))) {
            throw alreadyExists('licensePlate', plate);
          }
          vehicle.licensePlate = plate;
        }
        if (dto.parkingCardCode !== undefined) {
          const card = dto.parkingCardCode;
          if (card && card !== vehicle.parkingCardCode && (await repo.exists({ where: { buildingId: this.buildingId(), parkingCardCode: card, isActive: true } }))) {
            throw alreadyExists('parkingCardCode', card);
          }
          vehicle.parkingCardCode = card;
        }
        if (dto.brandModel !== undefined) vehicle.brandModel = dto.brandModel;
        await repo.save(vehicle);
        return this.loadVehicle(manager, vehicle.id);
      },
      [PLATE_INDEX, CARD_INDEX],
      (err) => (isUniqueViolation(err, CARD_INDEX) ? alreadyExists('parkingCardCode', dto.parkingCardCode ?? '') : alreadyExists('licensePlate', plate ?? '')),
    );
  }

  deactivateVehicle(contractId: string, vehicleId: string, dto: DeactivateVehicleDto): Promise<VehicleView> {
    const today = vietnamToday();
    const date = dto.deactivatedAt ?? today;
    if (date > today) throw invalid([{ field: 'deactivatedAt', message: 'Cannot be in the future' }]);
    return this.write(async (manager) => {
      const contract = await lockContract(manager, this.buildingId(), contractId);
      const repo = manager.getRepository(TenantVehicle);
      const vehicle = await repo.findOne({ where: { id: vehicleId, contractId, buildingId: this.buildingId() } });
      if (!vehicle) throw notFound('Vehicle');
      if (!vehicle.isActive) {
        throw new ConflictException({ errorCode: SystemErrorCode.RES_CONFLICT, message: 'The vehicle is already inactive.', details: [{ field: 'vehicleId', issue: 'ALREADY_INACTIVE' }] });
      }
      vehicle.isActive = false;
      vehicle.deactivatedAt = date;
      await repo.save(vehicle);
      await this.syncDerivedServices(manager, contract);
      return this.loadVehicle(manager, vehicle.id);
    });
  }

  /** Người ở chuyển đi: xe của họ ngừng hoạt động vào ngày chuyển đi, gói gửi xe tính lại (trong transaction gọi tới) */
  async deactivateVehiclesOf(manager: EntityManager, contract: Contract, tenantIds: string[], date: string): Promise<number> {
    if (tenantIds.length === 0) return 0;
    const repo = manager.getRepository(TenantVehicle);
    const vehicles = await repo.find({ where: { contractId: contract.id, ownerTenantId: In(tenantIds), isActive: true } });
    for (const vehicle of vehicles) {
      vehicle.isActive = false;
      vehicle.deactivatedAt = date;
      await repo.save(vehicle);
    }
    return vehicles.length;
  }

  // ----------------------------------------------------------------------------

  private async lockOpen(manager: EntityManager, contractId: string): Promise<Contract> {
    const contract = await lockContract(manager, this.buildingId(), contractId);
    if (!OPEN.includes(contract.status)) throw notActive(contract.status);
    return contract;
  }

  private async findSubscription(manager: EntityManager, contractId: string, id: string): Promise<ContractServiceSubscription> {
    const sub = await manager.getRepository(ContractServiceSubscription).findOne({ where: { id, contractId, buildingId: this.buildingId() } });
    if (!sub) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Service subscription not found on this contract.' });
    return sub;
  }

  private async serviceView(manager: EntityManager, contractId: string, id: string): Promise<ContractServiceView> {
    return (await this.loadServices(manager, contractId)).find((s) => s.subscriptionId === id)!;
  }

  private async loadVehicle(manager: EntityManager, id: string): Promise<VehicleView> {
    const v = await manager
      .getRepository(TenantVehicle)
      .createQueryBuilder('v')
      .innerJoin('v.owner', 't')
      .addSelect(['t.id', 't.fullName'])
      .where('v.id = :id', { id })
      .getOneOrFail();
    return this.vehicleView(v);
  }

  private vehicleView(v: TenantVehicle): VehicleView {
    return {
      id: v.id,
      ownerTenantId: v.ownerTenantId,
      ownerName: v.owner!.fullName,
      vehicleType: v.vehicleType,
      licensePlate: v.licensePlate ?? null,
      brandModel: v.brandModel,
      parkingCardCode: v.parkingCardCode ?? null,
      isActive: v.isActive,
      deactivatedAt: v.deactivatedAt ?? null,
      createdAt: v.createdAt,
    };
  }

  private derived(message: string) {
    return new ConflictException({ errorCode: SystemErrorCode.BIZ_SERVICE_QUANTITY_DERIVED, message, details: [{ field: 'quantity', issue: 'DERIVED' }] });
  }

  /** Transaction RLS; hai request ghi song song vượt qua kiểm tra trước → unique index chặn, đổi thành 409 rõ nghĩa */
  private async write<T>(fn: (manager: EntityManager) => Promise<T>, uniqueIndex?: string | string[], onUnique?: (err: unknown) => Error): Promise<T> {
    try {
      return await this.rls.runInTenantContext(fn);
    } catch (err) {
      const indexes = uniqueIndex === undefined ? [] : Array.isArray(uniqueIndex) ? uniqueIndex : [uniqueIndex];
      if (onUnique && indexes.some((i) => isUniqueViolation(err, i))) throw onUnique(err);
      throw err;
    }
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}

