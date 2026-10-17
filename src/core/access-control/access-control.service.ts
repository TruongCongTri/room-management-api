import { Injectable, ForbiddenException } from '@nestjs/common';
import { CaslAbilityFactory } from './casl-ability.factory';
import { RequestContextService } from '../context/request-context.service';
import { Action, ResourceEntity } from './access-control.types';

@Injectable()
export class AccessControlService {
  constructor(
    private readonly abilityFactory: CaslAbilityFactory,
    private readonly contextService: RequestContextService,
  ) {}

  /**
   * Kiểm tra quyền hiện tại của user trên tài nguyên cụ thể
   */
  can(action: Action, resource: string | ResourceEntity): boolean {
    const user = this.contextService.getCurrentUser();
    if (!user) return false;

    const ability = this.abilityFactory.createForUser(user);
    return ability.can(action, resource);
  }

  /**
   * Kiểm tra quyền và ném ngoại lệ ForbiddenException nếu vi phạm
   */
  enforce(action: Action, resource: string | ResourceEntity): void {
    if (!this.can(action, resource)) {
      throw new ForbiddenException(
        `Access denied: You do not have permission to perform '${action}' on this resource.`,
      );
    }
  }
}
