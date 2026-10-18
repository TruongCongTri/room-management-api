/** /tenants/* (tài liệu 04, tag Tenants & PDPL Privacy). Route tĩnh (`lookup`, `me`) khai báo TRƯỚC `:id`. */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
import { TenantsService } from '../services/tenants.service';
import { CreateTenantDto, ListTenantsQueryDto, LookupTenantQueryDto, UpdateTenantDto } from '../dto/tenants.dto';

const T = RentalResource.TENANTS;

@ApiTags('Tenants & PDPL Privacy')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  @ApiAudience('admin')
  @Idempotent()
  @RequirePermissions({ resource: T, action: Action.CREATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Register one person (holder, roommate or child)' })
  create(@Body() dto: CreateTenantDto) {
    return this.tenants.create(dto);
  }

  @Get()
  @ApiAudience('admin')
  @ThrottleSearch()
  @RequirePermissions({ resource: T, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Search people by name (without diacritics) or phone' })
  list(@Query() query: ListTenantsQueryDto) {
    return this.tenants.list(query);
  }

  @Get('lookup')
  @ApiAudience('admin')
  @ThrottleSearch()
  @RequirePermissions({ resource: T, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: 'Exact lookup by CCCD / personal ID / passport (blind index, audited)' })
  lookup(@Query() query: LookupTenantQueryDto) {
    return this.tenants.lookup(query.idCardNumber);
  }

  @Get('me')
  @ApiAudience('external')
  @RequirePermissions({ resource: T, action: Action.READ, scope: Scope.OWN })
  @ApiOperation({ summary: "The signed-in tenant's own profile" })
  me(@CurrentUser() user: RequestUserContext) {
    return this.tenants.getMine(user);
  }

  @Get(':id')
  @ApiAudience('admin')
  @RequirePermissions({ resource: T, action: Action.READ, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: "One person's profile (masked)" })
  get(@Param('id', ParseUUIDStrictPipe) id: string) {
    return this.tenants.getById(id);
  }

  @Patch(':id')
  @ApiAudience('admin')
  @RequirePermissions({ resource: T, action: Action.UPDATE, scope: Scope.DEPARTMENT })
  @ApiOperation({ summary: "Correct a person's data" })
  update(@Param('id', ParseUUIDStrictPipe) id: string, @Body() dto: UpdateTenantDto) {
    return this.tenants.update(id, dto);
  }
}
