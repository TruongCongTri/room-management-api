/**
 * /users - chủ nhà quản lý tài khoản nhân viên (`users:*:global`, chỉ LANDLORD có qua `*:*:global`).
 * Không cần X-Building-ID: phạm vi là các tòa nhà của chủ nhà (user_building_access).
 */
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { Idempotent } from '../../../core/security/idempotency/idempotency.decorator';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { UsersService } from '../services/users.service';
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from '../dto/users.dto';

@ApiTags('Identity & Authentication')
@ApiAudience('admin')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @Idempotent()
  @RequirePermissions({ resource: RentalResource.USERS, action: Action.CREATE, scope: Scope.GLOBAL })
  @ApiOperation({ summary: 'Create a staff account (landlord only)' })
  create(@CurrentUser() actor: RequestUserContext, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto);
  }

  @Get()
  @RequirePermissions({ resource: RentalResource.USERS, action: Action.READ, scope: Scope.GLOBAL })
  @ApiOperation({ summary: "List accounts with access to the landlord's buildings" })
  list(@CurrentUser() actor: RequestUserContext, @Query() query: ListUsersQueryDto) {
    return this.users.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions({ resource: RentalResource.USERS, action: Action.READ, scope: Scope.GLOBAL })
  @ApiOperation({ summary: "One account (staff or tenant) of the landlord's buildings" })
  get(@CurrentUser() actor: RequestUserContext, @Param('id', ParseUUIDStrictPipe) id: string) {
    return this.users.getById(actor, id);
  }

  @Patch(':id')
  @RequirePermissions({ resource: RentalResource.USERS, action: Action.UPDATE, scope: Scope.GLOBAL })
  @ApiOperation({ summary: "Change a staff account's roles, buildings or status (landlord only)" })
  update(
    @CurrentUser() actor: RequestUserContext,
    @Param('id', ParseUUIDStrictPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    const { version, ...changes } = dto;
    if (Object.values(changes).every((value) => value === undefined)) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
        message: 'Nothing to update.',
        details: [{ field: 'body', message: 'Provide at least one of fullName, roles, buildingIds, status' }],
      });
    }
    return this.users.update(actor, id, { ...changes, version });
  }
}
