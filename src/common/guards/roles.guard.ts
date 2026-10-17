/**
 * Kiểm tra vai trò (RBAC) nhanh chóng dựa trên metadata @Roles():   
 * 
 * */ 

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RequestContextService } from '../../core/context/request-context.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contextService: RequestContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Nếu endpoint không yêu cầu role cụ thể, cho phép đi tiếp
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user || this.contextService.getCurrentUser();

    if (!user || !user.roles || !Array.isArray(user.roles)) {
      throw new ForbiddenException('Access denied: User possesses no assigned roles.');
    }

    // Kiểm tra xem người dùng có ít nhất một trong các vai trò yêu cầu không
    const hasRole = requiredRoles.some((role) => user.roles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied: Required one of the following roles: [${requiredRoles.join(', ')}]`,
      );
    }

    return true;
  }
}