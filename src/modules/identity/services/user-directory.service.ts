/**
 * Truy vấn tài khoản dùng chung cho AuthService / UsersService / cấp tài khoản khách thuê:
 * tìm theo số điện thoại (kèm hash mật khẩu khi cần), vai trò và tòa nhà của tài khoản.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../entities/user.entity';
import { UserRole } from '../entities/user-role.entity';
import { UserBuildingAccess } from '../entities/user-building-access.entity';

export interface UserAccess {
  roles: string[];
  buildingIds: string[];
}

@Injectable()
export class UserDirectoryService {
  constructor(private readonly dataSource: DataSource) {}

  private manager(manager?: EntityManager) {
    return manager ?? this.dataSource.manager;
  }

  /** Tài khoản còn sống theo số E.164; withPasswordHash để so mật khẩu */
  findByPhone(phoneE164: string, options: { withPasswordHash?: boolean; manager?: EntityManager } = {}): Promise<User | null> {
    const qb = this.manager(options.manager).getRepository(User).createQueryBuilder('u').where('u.phone_e164 = :phoneE164', { phoneE164 });
    if (options.withPasswordHash) qb.addSelect('u.passwordHash');
    return qb.getOne();
  }

  findById(id: string, options: { withPasswordHash?: boolean; manager?: EntityManager } = {}): Promise<User | null> {
    const qb = this.manager(options.manager).getRepository(User).createQueryBuilder('u').where('u.id = :id', { id });
    if (options.withPasswordHash) qb.addSelect('u.passwordHash');
    return qb.getOne();
  }

  /** Vai trò và tòa nhà; tòa nhà mặc định (buildingIds[0]) là tòa được cấp sớm nhất */
  async getAccess(userId: string, manager?: EntityManager): Promise<UserAccess> {
    const m = this.manager(manager);
    const [roles, access] = await Promise.all([
      m.getRepository(UserRole).find({ where: { userId }, order: { roleCode: 'ASC' } }),
      m.getRepository(UserBuildingAccess).find({ where: { userId }, order: { createdAt: 'ASC', buildingId: 'ASC' } }),
    ]);
    return { roles: roles.map((r) => r.roleCode), buildingIds: access.map((a) => a.buildingId) };
  }
}
