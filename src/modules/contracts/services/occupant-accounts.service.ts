/**
 * Tài khoản khách thuê khi chuyển đến (tài liệu 02, mục 2.0 / 5.5.2): người ở ĐÃ THÀNH NIÊN có số điện thoại được
 * tạo (hoặc dùng lại) tài khoản TENANT trong CÙNG transaction và hồ sơ được liên kết (tenants.user_id) - trừ khi một hồ
 * sơ khác của tòa nhà đã dùng tài khoản đó (vd: hai người chung một số điện thoại).
 * Trả về các user id đã liên kết để xóa cache phạm vi phòng SAU COMMIT.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { TenantAccountProvisioningService } from '../../identity/services/tenant-account-provisioning.service';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { isMinorOn } from '../../tenants/domain/tenant-profile.rules';

@Injectable()
export class OccupantAccountsService {
  constructor(private readonly provisioning: TenantAccountProvisioningService) {}

  async provisionFor(manager: EntityManager, buildingId: string, tenantIds: string[], today: string): Promise<string[]> {
    if (tenantIds.length === 0) return [];
    const repo = manager.getRepository(Tenant);
    const people = await repo.find({ where: { buildingId, id: In(tenantIds) } });
    const linked: string[] = [];
    for (const person of people) {
      if (person.userId) {
        linked.push(person.userId);
        continue;
      }
      if (!person.phone || isMinorOn(person.dateOfBirth, today)) continue;
      const account = await this.provisioning.provision({ phone: person.phone, fullName: person.fullName, buildingId }, manager);
      const taken = await repo.exists({ where: { buildingId, userId: account.userId } });
      if (taken) continue;
      person.userId = account.userId;
      await repo.save(person); // save(): audit ghi liên kết hồ sơ ↔ tài khoản trên đúng hồ sơ
      linked.push(account.userId);
    }
    return linked;
  }

  /** User id đã liên kết của các hồ sơ (để xóa cache phạm vi phòng) */
  async linkedUserIds(manager: EntityManager, buildingId: string, tenantIds: string[]): Promise<string[]> {
    if (tenantIds.length === 0) return [];
    const rows = await manager.getRepository(Tenant).find({ where: { buildingId, id: In(tenantIds) }, select: { id: true, userId: true } });
    return rows.map((r) => r.userId).filter((id): id is string => !!id);
  }
}
