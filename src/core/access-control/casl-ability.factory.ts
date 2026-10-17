import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';
import {
  Action,
  Scope,
  PermissionEffect,
  EffectivePermissionRule,
} from './access-control.types';
import { RequestUserContext } from '../context/request-context.model';
import { ALL_RESOURCES } from './rental-permissions';

export type AppAbility = MongoAbility<[Action, any]>;

export { ALL_RESOURCES };

const SCOPE_RANK: Record<Scope, number> = {
  [Scope.OWN]: 1,
  [Scope.DEPARTMENT]: 2,
  [Scope.GLOBAL]: 3,
};

@Injectable()
export class CaslAbilityFactory {
  // Memo theo object user (sống trong 1 request) để Guard + Service không build lại ability
  private readonly cache = new WeakMap<RequestUserContext, AppAbility>();

  createForUser(user: RequestUserContext): AppAbility {
    const cached = this.cache.get(user);
    if (cached) return cached;

    const ability = this.build(user);
    this.cache.set(user, ability);
    return ability;
  }

  /**
   * Kiểm tra user có ít nhất một GRANT cho (resource, action) với phạm vi >= requiredScope.
   * Ví dụ: quyền GLOBAL thỏa yêu cầu DEPARTMENT; quyền OWN không thỏa yêu cầu DEPARTMENT.
   */
  hasScope(
    user: RequestUserContext,
    resource: string,
    action: Action,
    requiredScope: Scope,
  ): boolean {
    return (user.rules || []).some(
      (rule) =>
        rule.effect === PermissionEffect.GRANT &&
        (rule.resource === resource || rule.resource === ALL_RESOURCES) &&
        (rule.action === action || rule.action === Action.MANAGE) &&
        SCOPE_RANK[rule.scope] >= SCOPE_RANK[requiredScope] &&
        // Quyền DEPARTMENT (theo tòa nhà) vô hiệu nếu user không gắn với tòa nhà nào
        (rule.scope !== Scope.DEPARTMENT || !!user.tenantId),
    );
  }

  private build(user: RequestUserContext): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    const rules = user.rules || [];

    // BƯỚC 1: Xây dựng tập quyền cho phép (GRANT)
    for (const rule of rules.filter((r) => r.effect === PermissionEffect.GRANT)) {
      const conditions = this.resolveConditions(rule, user);
      if (conditions === null) continue; // Thiếu thuộc tính để giới hạn phạm vi → bỏ quyền (fail-closed)
      if (conditions) {
        can(rule.action, rule.resource, conditions);
      } else {
        can(rule.action, rule.resource);
      }
    }

    // BƯỚC 2: Phủ quyết đích danh (EXPLICIT DENY LUÔN NẰM DƯỚI ĐỂ GHI ĐÈ)
    for (const rule of rules.filter((r) => r.effect === PermissionEffect.DENY)) {
      const conditions = this.resolveConditions(rule, user);
      if (conditions) {
        cannot(rule.action, rule.resource, conditions);
      } else {
        // Không xác định được phạm vi → chặn toàn bộ (fail-closed)
        cannot(rule.action, rule.resource);
      }
    }

    return build({
      detectSubjectType: (item) => {
        if (!item) return 'Object';
        if (typeof item === 'string') return item;

        const caslSymbol =
          (item as any)[Symbol.for('subjectType')] || (item as any).__caslSubjectType__;
        if (caslSymbol) return caslSymbol;

        const explicitType = (item as any).__type || (item as any).subjectType;
        if (explicitType) return explicitType;

        if (item.constructor?.name && item.constructor.name !== 'Object') {
          return item.constructor.name;
        }

        return 'Object';
      },
    });
  }

  /**
   * Tính toán điều kiện so khớp ABAC dựa trên Scope và thuộc tính User.
   *  - DEPARTMENT: bản ghi thuộc tòa nhà hiệu lực của user (`room.buildingId === user.buildingId`).
   *  - OWN: bản ghi do chính user sở hữu (`userId`).
   * Trả về null khi scope yêu cầu một thuộc tính mà user không có (vd: DEPARTMENT nhưng không có tòa nhà):
   * nếu không, điều kiện { buildingId: undefined } sẽ khớp mọi bản ghi thiếu buildingId (leo thang đặc quyền).
   */
  private resolveConditions(
    rule: EffectivePermissionRule,
    user: RequestUserContext,
  ): Record<string, any> | undefined | null {
    let scopeConditions: Record<string, any> | undefined;

    if (rule.scope === Scope.DEPARTMENT) {
      if (!user.tenantId) return null;
      scopeConditions = { buildingId: user.tenantId };
    } else if (rule.scope === Scope.OWN) {
      if (!user.id) return null;
      scopeConditions = { userId: user.id };
    }

    if (!scopeConditions && !rule.conditions) {
      return undefined;
    }

    return {
      ...rule.conditions,
      // Điều kiện scope đặt sau để custom conditions không thể nới rộng phạm vi
      ...scopeConditions,
    };
  }
}
