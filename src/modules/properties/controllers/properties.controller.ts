/**
 * /properties/* (tài liệu 04, tag Properties & Room Directory): tòa nhà, hạng phòng, danh bạ phòng.
 * Route tĩnh (`rooms/mine`, `rooms/vacancies/summary`) khai báo TRƯỚC `rooms/:id`.
 */
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { Idempotent } from '../../../core/security/idempotency/idempotency.decorator';
import { ThrottleSearch } from '../../../core/security/throttler/throttler.decorators';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { BuildingsService } from '../services/buildings.service';
import { RoomTypesService } from '../services/room-types.service';
import { PropertiesService } from '../services/properties.service';
import { RoomAccessGuard } from '../guards/room-access.guard';
import {
  CreateBuildingDto,
  CreateRoomDto,
  CreateRoomTypeDto,
  QueryRoomsDto,
  UpdateBuildingDto,
  UpdateRoomDto,
  UpdateRoomTypeDto,
} from '../dto/properties.dto';

const R = RentalResource;

@ApiTags('Properties & Room Directory')
@ApiBearerAuth()
@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly buildings: BuildingsService,
    private readonly roomTypes: RoomTypesService,
    private readonly properties: PropertiesService,
  ) {}

  // ------------------------------------------------------------------ buildings (landlord, global)

  @Get('buildings')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.BUILDINGS, action: Action.READ, scope: Scope.GLOBAL })
  @ApiOperation({ summary: 'Buildings the landlord manages' })
  listBuildings(@CurrentUser() actor: RequestUserContext) {
    return this.buildings.list(actor);
  }

  @Post('buildings')
  @ApiAudience('admin')
  @Idempotent()
  @RequirePermissions({ resource: R.BUILDINGS, action: Action.CREATE, scope: Scope.GLOBAL })
  @ApiOperation({ summary: 'Register a building (the creator gets access)' })
  createBuilding(@CurrentUser() actor: RequestUserContext, @Body() dto: CreateBuildingDto) {
    return this.buildings.create(actor, dto);
  }

  @Patch('buildings/:id')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.BUILDINGS, action: Action.UPDATE, scope: Scope.GLOBAL })
  @ApiOperation({ summary: "Update a building's address, tax, bank and billing settings" })
  updateBuilding(@CurrentUser() actor: RequestUserContext, @Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateBuildingDto) {
    return this.buildings.update(actor, id, dto);
  }

  // ------------------------------------------------------------------ room types

  @Get('room-types')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.ROOMS, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Room types of the active building (cached)' })
  listRoomTypes() {
    return this.roomTypes.list();
  }

  @Post('room-types')
  @ApiAudience('admin')
  @Idempotent()
  @RequirePermissions({ resource: R.ROOMS, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Create a room type' })
  createRoomType(@Body() dto: CreateRoomTypeDto) {
    return this.roomTypes.create(dto);
  }

  @Patch('room-types/:id')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.ROOMS, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Change a room type (base rent, area, default capacity)' })
  updateRoomType(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateRoomTypeDto) {
    return this.roomTypes.update(id, dto);
  }

  // ------------------------------------------------------------------ rooms

  @Get('rooms')
  @ApiAudience('admin', 'guard')
  @ThrottleSearch()
  @RequirePermissions({ resource: R.ROOMS, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Index-backed room directory (6 fields, paginated)' })
  listRooms(@Query() query: QueryRoomsDto) {
    return this.properties.listRooms(query);
  }

  @Post('rooms')
  @ApiAudience('admin')
  @Idempotent()
  @RequirePermissions({ resource: R.ROOMS, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Create a room (never above the building capacity)' })
  createRoom(@Body() dto: CreateRoomDto) {
    return this.properties.createRoom(dto);
  }

  @Get('rooms/vacancies/summary')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.ROOMS, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Vacancy statistics by room type (XFetch cached)' })
  vacancySummary() {
    return this.properties.getVacancySummary();
  }

  @Get('rooms/mine')
  @ApiAudience('external')
  @RequirePermissions({ resource: R.ROOMS, action: Action.READ, scope: Scope.OWN })
  @ApiOperation({ summary: 'The room the signed-in tenant currently lives in' })
  myRoom(@CurrentUser() user: RequestUserContext) {
    return this.properties.getMyRoom(user);
  }

  @Get('rooms/:id')
  @ApiAudience('admin', 'guard', 'external')
  @RequirePermissions({ resource: R.ROOMS, action: Action.READ, scope: Scope.OWN })
  @UseGuards(RoomAccessGuard)
  @ApiOperation({ summary: 'Single-query room detail (tenants: only their own room)' })
  roomDetail(@Param('id', ParseUUIDStrictPipe) id: string) {
    return this.properties.getRoomDetail(id);
  }

  @Patch('rooms/:id')
  @ApiAudience('admin')
  @RequirePermissions({ resource: R.ROOMS, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: "Change a room's price, status, type or physical data" })
  updateRoom(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateRoomDto) {
    return this.properties.updateRoom(id, dto);
  }
}
