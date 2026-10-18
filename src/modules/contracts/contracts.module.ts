/**
 * Module 3 - Contracts (tài liệu 02, mục 5.1 / 5.4 / 5.5 - quyết định D8): hợp đồng nháp → hiệu lực → gia hạn, tiền cọc 1
 * tháng, người ở & người đứng tên, cư trú từng người, xe & dịch vụ đi kèm, danh mục dịch vụ. Cung cấp resolver thật của
 * OCCUPANCY_SELF_SCOPE: khách thuê chỉ xem được phòng / hợp đồng mình đang ở.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OCCUPANCY_SELF_SCOPE } from '../../core/access-control/occupancy-self-scope';
import { IdentityModule } from '../identity/identity.module';
import { Contract } from './entities/contract.entity';
import { ContractOccupant } from './entities/contract-occupant.entity';
import { ContractHolderTransfer } from './entities/contract-holder-transfer.entity';
import { ContractRenewal } from './entities/contract-renewal.entity';
import { ContractAsset } from './entities/contract-asset.entity';
import { ServiceCatalog } from './entities/service-catalog.entity';
import { ContractServiceSubscription } from './entities/contract-service.entity';
import { TenantVehicle } from './entities/tenant-vehicle.entity';
import { DepositLedger } from './entities/deposit-ledger.entity';
import { ContractsController } from './controllers/contracts.controller';
import { ServiceCatalogController } from './controllers/service-catalog.controller';
import { ContractsService } from './services/contracts.service';
import { ContractOccupancyService } from './services/contract-occupancy.service';
import { ContractExtrasService } from './services/contract-extras.service';
import { DepositEscrowService } from './services/deposit-escrow.service';
import { OccupantAccountsService } from './services/occupant-accounts.service';
import { ServiceCatalogService } from './services/service-catalog.service';
import { ContractOccupancySelfScopeResolver } from './services/contract-occupancy-self-scope.resolver';
import { ContractNotificationsListener } from './listeners/contract-notifications.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Contract,
      ContractOccupant,
      ContractHolderTransfer,
      ContractRenewal,
      ContractAsset,
      ServiceCatalog,
      ContractServiceSubscription,
      TenantVehicle,
      DepositLedger,
    ]),
    IdentityModule,
  ],
  controllers: [ContractsController, ServiceCatalogController],
  providers: [
    ContractsService,
    ContractOccupancyService,
    ContractExtrasService,
    DepositEscrowService,
    OccupantAccountsService,
    ServiceCatalogService,
    ContractNotificationsListener,
    { provide: OCCUPANCY_SELF_SCOPE, useClass: ContractOccupancySelfScopeResolver },
  ],
  exports: [ContractOccupancyService, DepositEscrowService],
})
export class ContractsModule {}
