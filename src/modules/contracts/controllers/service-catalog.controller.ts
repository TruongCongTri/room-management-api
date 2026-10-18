/** /service-catalog (tài liệu 04, tag Service Catalogue; quyết định D8) */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { CreateServiceCatalogDto, UpdateServiceCatalogDto } from '../dto/contracts.dto';

const C = RentalResource.CONTRACTS;

@ApiTags('Service Catalogue')
@ApiBearerAuth()
@ApiAudience('admin')
@Controller('service-catalog')
export class ServiceCatalogController {
  constructor(private readonly catalog: ServiceCatalogService) {}

  @Get()
  @RequirePermissions({ resource: C, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Services offered by the building' })
  list() {
    return this.catalog.list();
  }

  @Post()
  @RequirePermissions({ resource: C, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Add a service' })
  create(@Body() dto: CreateServiceCatalogDto) {
    return this.catalog.create(dto);
  }

  @Patch(':id')
  @RequirePermissions({ resource: C, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Rename / re-price a service' })
  update(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateServiceCatalogDto) {
    return this.catalog.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions({ resource: C, action: Action.DELETE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Remove an unused service' })
  async remove(@Param('id', ParseUUIDStrictPipe) id: string) {
    await this.catalog.remove(id);
  }
}
