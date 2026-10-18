/** /assets/* (tài liệu 04, tag Assets & Furniture Catalog) - danh mục và đơn vị lắp trong phòng của tòa nhà hiệu lực */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { Idempotent } from '../../../core/security/idempotency/idempotency.decorator';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { AssetsService } from '../services/assets.service';
import { AssignRoomAssetDto, CreateAssetDto, QueryAssetsDto, QueryRoomAssetsDto, UpdateAssetDto, UpdateRoomAssetDto } from '../dto/assets.dto';

const A = RentalResource.ASSETS;

@ApiTags('Assets & Furniture Catalog')
@ApiAudience('admin')
@ApiBearerAuth()
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermissions({ resource: A, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Appliance & furniture catalogue with installed unit counts' })
  list(@Query() query: QueryAssetsDto) {
    return this.assets.list(query.category);
  }

  @Post()
  @Idempotent()
  @RequirePermissions({ resource: A, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Add a catalogue item' })
  create(@Body() dto: CreateAssetDto) {
    return this.assets.create(dto);
  }

  @Patch(':id')
  @RequirePermissions({ resource: A, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Change a catalogue item' })
  update(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateAssetDto) {
    return this.assets.update(id, dto);
  }

  @Get('room-assignments')
  @RequirePermissions({ resource: A, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Installed units of the building (by room, item, serial, condition) with the renting contract' })
  listUnits(@Query() query: QueryRoomAssetsDto) {
    return this.assets.listUnits(query);
  }

  @Post('room-assignments')
  @Idempotent()
  @RequirePermissions({ resource: A, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Install a serial-numbered unit in a room' })
  assign(@Body() dto: AssignRoomAssetDto) {
    return this.assets.assign(dto);
  }

  @Patch('room-assignments/:id')
  @RequirePermissions({ resource: A, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Re-grade, re-price or move an installed unit' })
  updateUnit(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateRoomAssetDto) {
    return this.assets.updateUnit(id, dto);
  }

  @Delete('room-assignments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions({ resource: A, action: Action.DELETE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Remove an installed unit (soft delete)' })
  async remove(@Param('id', ParseUUIDStrictPipe) id: string): Promise<void> {
    await this.assets.removeUnit(id);
  }
}
