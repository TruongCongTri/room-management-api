/**
 * Module 0 - Identity (tài liệu 02, mục 2.0): đăng nhập bằng số điện thoại, OTP, phiên đăng nhập,
 * tài khoản nhân viên, cấp tài khoản khách thuê và nguồn quyền PERMISSION_RULES_LOADER.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { AppConfigService } from '../../core/config/app-config.service';
import { REDIS_CLIENT } from '../../core/redis/redis.constants';
import { PERMISSION_RULES_LOADER } from '../../core/access-control/user-permission.resolver';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user-role.entity';
import { UserBuildingAccess } from './entities/user-building-access.entity';
import { AuthSession } from './entities/auth-session.entity';
import { SystemRole } from './entities/system-role.entity';
import { AuthController } from './controllers/auth.controller';
import { UsersController } from './controllers/users.controller';
import { AuthService } from './services/auth.service';
import { SessionService } from './services/session.service';
import { OtpService } from './services/otp.service';
import { LoginLockService } from './services/login-lock.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { UserDirectoryService } from './services/user-directory.service';
import { UsersService } from './services/users.service';
import { TenantAccountProvisioningService } from './services/tenant-account-provisioning.service';
import { UserRolesPermissionLoader } from './services/user-permission.loader';
import { createIdentityStateStore, IDENTITY_STATE_STORE } from './services/identity-state.store';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserRole, UserBuildingAccess, AuthSession, SystemRole])],
  controllers: [AuthController, UsersController],
  providers: [
    {
      provide: IDENTITY_STATE_STORE,
      inject: [REDIS_CLIENT, AppConfigService],
      useFactory: (redis: Redis | null, config: AppConfigService) => createIdentityStateStore(redis, config.isProduction),
    },
    PasswordHasherService,
    LoginLockService,
    OtpService,
    SessionService,
    UserDirectoryService,
    AuthService,
    UsersService,
    TenantAccountProvisioningService,
    UserRolesPermissionLoader,
    { provide: PERMISSION_RULES_LOADER, useExisting: UserRolesPermissionLoader },
  ],
  exports: [TenantAccountProvisioningService, UserDirectoryService, SessionService],
})
export class IdentityModule {}
