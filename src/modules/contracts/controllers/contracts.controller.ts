/**
 * /contracts/* (tài liệu 04, tag Contracts & 1-Month Deposit Escrow; quyết định D8). Route tĩnh (`mine`) khai báo TRƯỚC `:id`.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { Idempotent } from '../../../core/security/idempotency/idempotency.decorator';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { ContractsService } from '../services/contracts.service';
import { ContractOccupancyService } from '../services/contract-occupancy.service';
import { ContractExtrasService } from '../services/contract-extras.service';
import { DepositEscrowService } from '../services/deposit-escrow.service';
import {
  AddContractServiceDto,
  AddOccupantDto,
  CreateContractDto,
  DeactivateVehicleDto,
  ListContractsQueryDto,
  MoveOutOccupantDto,
  RegisterVehicleDto,
  RenewContractDto,
  StatusFilterQueryDto,
  TransferPrimaryHolderDto,
  UpdateContractServiceDto,
  UpdateDraftContractDto,
  UpdateResidencyStatusDto,
  UpdateVehicleDto,
  VersionedActionDto,
  VehiclesQueryDto,
} from '../dto/contracts.dto';

const C = RentalResource.CONTRACTS;
const read = { resource: C, action: Action.READ, scope: Scope.DEPARTMENT };
const update = { resource: C, action: Action.UPDATE, scope: Scope.DEPARTMENT };
const execute = { resource: C, action: Action.EXECUTE, scope: Scope.DEPARTMENT };
const Id = () => Param('id', ParseUUIDStrictPipe);

@ApiTags('Contracts & 1-Month Deposit Escrow')
@ApiBearerAuth()
@ApiAudience('admin')
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly occupancy: ContractOccupancyService,
    private readonly extras: ContractExtrasService,
    private readonly deposits: DepositEscrowService,
  ) {}

  // ----------------------------------------------------------------- lifecycle
  @Post()
  @Idempotent()
  @RequirePermissions({ resource: C, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Create a DRAFT lease (room RESERVED)' })
  create(@Body() dto: CreateContractDto) {
    return this.contracts.create(dto);
  }

  @Get()
  @RequirePermissions(read)
  @ApiOperation({ summary: 'List contracts of the building' })
  list(@Query() query: ListContractsQueryDto) {
    return this.contracts.list(query);
  }

  @Get('mine')
  @ApiAudience('external')
  @RequirePermissions({ resource: C, action: Action.READ, scope: Scope.OWN })
  @ApiOperation({ summary: 'The contract the signed-in tenant currently lives under' })
  mine(@CurrentUser() user: RequestUserContext) {
    return this.contracts.getMine(user);
  }

  @Get(':id')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'Contract detail' })
  get(@Id() id: string) {
    return this.contracts.getById(id);
  }

  @Patch(':id')
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Edit a draft' })
  updateDraft(@Id() id: string, @Body() dto: UpdateDraftContractDto) {
    return this.contracts.updateDraft(id, dto);
  }

  @Post(':id/activate')
  @Idempotent()
  @RequirePermissions(execute)
  @ApiOperation({ summary: 'Activate a draft: move-in, 1-month deposit, room OCCUPIED' })
  activate(@Id() id: string, @Body() dto: VersionedActionDto, @CurrentUser() user: RequestUserContext) {
    return this.contracts.activate(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermissions(execute)
  @ApiOperation({ summary: 'Cancel a draft' })
  cancel(@Id() id: string, @Body() dto: VersionedActionDto) {
    return this.contracts.cancel(id, dto);
  }

  @Post(':id/renew')
  @Idempotent()
  @RequirePermissions(execute)
  @ApiOperation({ summary: 'Renew an active contract' })
  renew(@Id() id: string, @Body() dto: RenewContractDto, @CurrentUser() user: RequestUserContext) {
    return this.contracts.renew(id, dto, user);
  }

  @Get(':id/renewals')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'Renewal history' })
  renewals(@Id() id: string) {
    return this.contracts.renewals(id);
  }

  @Get(':id/deposit-ledger')
  @RequirePermissions({ resource: RentalResource.DEPOSITS, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Immutable 1-month deposit ledger' })
  depositLedger(@Id() id: string) {
    return this.deposits.ledger(id);
  }

  // ----------------------------------------------------------------- occupants
  @Get(':id/occupants')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'Everyone living in the room under this contract (holder first)' })
  occupants(@Id() id: string, @Query() query: StatusFilterQueryDto) {
    return this.occupancy.list(id, query.status);
  }

  @Post(':id/occupants')
  @Idempotent()
  @RequirePermissions(update)
  @ApiOperation({ summary: 'A new person moves into the room' })
  addOccupant(@Id() id: string, @Body() dto: AddOccupantDto) {
    return this.occupancy.add(id, dto);
  }

  @Post(':id/occupants/:occupantId/move-out')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(update)
  @ApiOperation({ summary: 'A co-occupant moves out (the room stays rented)' })
  moveOut(@Id() id: string, @Param('occupantId', ParseUUIDStrictPipe) occupantId: string, @Body() dto: MoveOutOccupantDto) {
    return this.occupancy.moveOut(id, occupantId, dto);
  }

  @Patch(':id/occupants/:occupantId/residency')
  @RequirePermissions({ resource: RentalResource.COMPLIANCE, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Record the residence declaration result for one person' })
  residency(@Id() id: string, @Param('occupantId', ParseUUIDStrictPipe) occupantId: string, @Body() dto: UpdateResidencyStatusDto) {
    return this.occupancy.updateResidency(id, occupantId, dto);
  }

  @Post(':id/primary-holder/transfer')
  @Idempotent()
  @RequirePermissions(execute)
  @ApiOperation({ summary: 'Transfer the contract to the next occupant (người đứng tên)' })
  transfer(@Id() id: string, @Body() dto: TransferPrimaryHolderDto, @CurrentUser() user: RequestUserContext) {
    return this.occupancy.transferPrimaryHolder(id, dto, user);
  }

  @Get(':id/primary-holder/history')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'History of contract holders' })
  history(@Id() id: string) {
    return this.occupancy.history(id);
  }

  // ----------------------------------------------------------------- vehicles
  @Get(':id/vehicles')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'Vehicles of the people living under this contract' })
  vehicles(@Id() id: string, @Query() query: VehiclesQueryDto) {
    return this.extras.listVehicles(id, query.status);
  }

  @Post(':id/vehicles')
  @Idempotent()
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Register a vehicle' })
  registerVehicle(@Id() id: string, @Body() dto: RegisterVehicleDto) {
    return this.extras.registerVehicle(id, dto);
  }

  @Patch(':id/vehicles/:vehicleId')
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Correct the plate, model or parking card of an active vehicle' })
  updateVehicle(@Id() id: string, @Param('vehicleId', ParseUUIDStrictPipe) vehicleId: string, @Body() dto: UpdateVehicleDto) {
    return this.extras.updateVehicle(id, vehicleId, dto);
  }

  @Post(':id/vehicles/:vehicleId/deactivate')
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Deactivate a vehicle' })
  deactivateVehicle(@Id() id: string, @Param('vehicleId', ParseUUIDStrictPipe) vehicleId: string, @Body() dto: DeactivateVehicleDto) {
    return this.extras.deactivateVehicle(id, vehicleId, dto);
  }

  // ----------------------------------------------------------------- services
  @Get(':id/services')
  @RequirePermissions(read)
  @ApiOperation({ summary: 'Extra services of the contract' })
  services(@Id() id: string) {
    return this.extras.listServices(id);
  }

  @Post(':id/services')
  @Idempotent()
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Subscribe the contract to a catalogue service' })
  addService(@Id() id: string, @Body() dto: AddContractServiceDto) {
    return this.extras.addService(id, dto);
  }

  @Patch(':id/services/:subscriptionId')
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Change the agreed price or per-room quantity' })
  updateService(@Id() id: string, @Param('subscriptionId', ParseUUIDStrictPipe) subscriptionId: string, @Body() dto: UpdateContractServiceDto) {
    return this.extras.updateService(id, subscriptionId, dto);
  }

  @Delete(':id/services/:subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(update)
  @ApiOperation({ summary: 'Unsubscribe' })
  async removeService(@Id() id: string, @Param('subscriptionId', ParseUUIDStrictPipe) subscriptionId: string) {
    await this.extras.removeService(id, subscriptionId);
  }
}
