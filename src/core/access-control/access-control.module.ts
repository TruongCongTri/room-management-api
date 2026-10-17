import { Global, Module } from '@nestjs/common';
import { CaslAbilityFactory } from './casl-ability.factory';
import { AccessControlService } from './access-control.service';
import { PermissionsGuard } from './permissions.guard';
import { PermissionCacheService } from './permission-cache.service';
import { UserPermissionResolver } from './user-permission.resolver';

@Global()
@Module({
  providers: [
    CaslAbilityFactory,
    AccessControlService,
    PermissionCacheService,
    UserPermissionResolver,
    PermissionsGuard,
  ],
  exports: [
    CaslAbilityFactory,
    AccessControlService,
    PermissionCacheService,
    UserPermissionResolver,
    PermissionsGuard,
  ],
})
export class AccessControlModule {}
