/**
 * Chi tiết phòng (tài liệu 02, mục 2.0.2): nhân viên có `rooms:read:department` mở được mọi phòng của tòa nhà hiệu lực;
 * người còn lại (TENANT, `rooms:read:own`) chỉ mở được phòng mình ĐANG ở (OCCUPANCY_SELF_SCOPE). Phòng khác, hoặc chính
 * phòng đó sau khi chuyển đi → 403. Chạy SAU PermissionsGuard (đã chặn người không có quyền đọc phòng nào).
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { CaslAbilityFactory } from '../../../core/access-control/casl-ability.factory';
import { OccupancySelfScopeService } from '../../../core/access-control/occupancy-self-scope';
import { Action, Scope } from '../../../core/access-control/access-control.types';
import { RentalResource } from '../../../core/access-control/rental-permissions';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { RequestContextService } from '../../../core/context/request-context.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';

@Injectable()
export class RoomAccessGuard implements CanActivate {
  constructor(
    private readonly abilityFactory: CaslAbilityFactory,
    private readonly selfScope: OccupancySelfScopeService,
    private readonly context: RequestContextService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user: RequestUserContext = req.user;
    if (this.abilityFactory.hasScope(user, RentalResource.ROOMS, Action.READ, Scope.DEPARTMENT)) return true;

    const scope = await this.selfScope.resolve(user.id, this.context.getBuildingId());
    if (scope && scope.roomId === req.params.id) return true;

    throw new ForbiddenException({
      errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
      message: 'You can only view the room you currently live in.',
    });
  }
}
