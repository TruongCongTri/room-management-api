/**
 * Guard kiểm tra quyền tĩnh (RBAC) & thuộc tính động (ABAC) trước khi vào Controller.
 * Thứ tự kiểm tra cho mỗi RequiredPermission:
 *   1. Type-level: user có GRANT cho (resource, action) và không bị DENY tuyệt đối.
 *   2. Scope: phạm vi quyền của user >= scope yêu cầu.
 *   3. Instance-level (ABAC): nếu xác định được bản ghi mục tiêu, áp điều kiện scope/conditions.
 * Với endpoint không xác định được bản ghi (vd: list), Service phải lọc dữ liệu theo scope
 * hoặc gọi AccessControlService.enforce() trên từng entity.
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  POLICY_HANDLER_KEY,
  RequiredPermission,
  PolicyHandlerFn,
} from './permission.decorator';
import { CaslAbilityFactory } from './casl-ability.factory';
import { RequestContextService } from '../context/request-context.service';
import { syncUserFromRequest } from '../context/request-context.interceptor';
import { Action, ResourceEntity } from './access-control.types';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: CaslAbilityFactory,
    private readonly contextService: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const requiredPermissions = this.reflector.getAllAndOverride<RequiredPermission[]>(
      PERMISSIONS_KEY,
      targets,
    );
    const policyHandlers = this.reflector.getAllAndOverride<PolicyHandlerFn[]>(
      POLICY_HANDLER_KEY,
      targets,
    );

    // Endpoint không khai báo permission
    if (!requiredPermissions?.length && !policyHandlers?.length) {
      return true;
    }

    // Guard chạy TRƯỚC interceptor → tự đồng bộ request.user (do JwtAuthGuard gán) vào context
    const user = syncUserFromRequest(context, this.contextService);
    if (!user) {
      throw new UnauthorizedException('Authentication context is missing');
    }

    const ability = this.abilityFactory.createForUser(user);
    const request = context.switchToHttp().getRequest();

    // 1. Kiểm tra ma trận RequiredPermissions
    for (const perm of requiredPermissions ?? []) {
      const denied = () =>
        new ForbiddenException(
          `Access Denied: Missing '${perm.resource}:${perm.action}:${perm.scope ?? 'any'}' permission`,
        );

      if (!ability.can(perm.action, perm.resource)) throw denied();

      if (
        perm.scope &&
        !this.abilityFactory.hasScope(user, perm.resource, perm.action, perm.scope)
      ) {
        throw denied();
      }

      const target = await this.resolveSubject(perm, context, request);
      if (target && !ability.can(perm.action, { ...target, __type: perm.resource })) {
        throw denied();
      }
    }

    // 2. Kiểm tra các Policy Handlers nâng cao (nếu có)
    for (const handler of policyHandlers ?? []) {
      if (!(await handler(ability, context))) {
        throw new ForbiddenException('Access Denied: Policy evaluation failed');
      }
    }

    return true;
  }

  /**
   * Xác định bản ghi mục tiêu cho ABAC.
   * KHÔNG lấy thuộc tính sở hữu từ body cho UPDATE/DELETE: client có thể khai man buildingId/userId
   * trong khi bản ghi thật thuộc tòa nhà khác. Với các action đó cần subjectResolver tải từ DB.
   */
  private async resolveSubject(
    perm: RequiredPermission,
    context: ExecutionContext,
    request: any,
  ): Promise<ResourceEntity | undefined> {
    if (perm.subjectResolver) {
      const resolved = await perm.subjectResolver(context);
      if (!resolved) return undefined;
      request.targetResource = resolved;
      return resolved;
    }

    if (request.targetResource) {
      return request.targetResource;
    }

    const pick = (source: Record<string, any> | undefined) => {
      if (!source) return undefined;
      const attrs: ResourceEntity = {};
      if (source.userId !== undefined) attrs.userId = source.userId;
      if (source.buildingId !== undefined) attrs.buildingId = source.buildingId;
      return Object.keys(attrs).length ? attrs : undefined;
    };

    // Route params mô tả phạm vi truy cập (vd: /buildings/:buildingId/rooms)
    const fromParams = pick(request.params);
    // Với CREATE, body chính là thuộc tính của bản ghi sắp tạo
    const fromBody = perm.action === Action.CREATE ? pick(request.body) : undefined;

    if (!fromParams && !fromBody) return undefined;
    return { ...fromBody, ...fromParams };
  }
}
