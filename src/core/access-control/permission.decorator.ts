import { SetMetadata, CustomDecorator, ExecutionContext } from '@nestjs/common';
import { Action, ResourceEntity, Scope } from './access-control.types';
import { AppAbility } from './casl-ability.factory';

export const PERMISSIONS_KEY = 'app:permissions';
export const POLICY_HANDLER_KEY = 'app:policy_handlers';

/**
 * Trích xuất đối tượng ABAC thực tế (thường tải từ DB theo req.params.id).
 * Kết quả được gắn vào request.targetResource để Controller tái sử dụng, tránh query lại.
 */
export type SubjectResolverFn = (
  context: ExecutionContext,
) => ResourceEntity | undefined | null | Promise<ResourceEntity | undefined | null>;

export interface RequiredPermission {
  resource: string;
  action: Action;
  /**
   * Phạm vi TỐI THIỂU user phải có (OWN < DEPARTMENT < GLOBAL).
   */
  scope?: Scope;
  /**
   * Bộ trích xuất đối tượng để kiểm tra ABAC theo bản ghi cụ thể.
   * Nếu bỏ trống, guard dùng route params (và body với action CREATE).
   */
  subjectResolver?: SubjectResolverFn;
}

export type PolicyHandlerFn = (
  ability: AppAbility,
  context: ExecutionContext,
) => boolean | Promise<boolean>;

/**
 * Decorator khai báo quyền hạn bắt buộc trên Endpoint (hỗ trợ nhiều quyền).
 * Phải đi cùng Auth Guard: @UseGuards(JwtAuthGuard, PermissionsGuard)
 * Ví dụ: @RequirePermissions({ resource: RentalResource.ROOMS, action: Action.READ, scope: Scope.DEPARTMENT })
 */
export const RequirePermissions = (
  ...permissions: RequiredPermission[]
): CustomDecorator<string> => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Decorator kiểm tra Policy phức tạp (ABAC nâng cao hoặc custom logic)
 */
export const CheckPolicies = (
  ...handlers: PolicyHandlerFn[]
): CustomDecorator<string> => SetMetadata(POLICY_HANDLER_KEY, handlers);
