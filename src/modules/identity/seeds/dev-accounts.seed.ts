/**
 * Tài khoản mẫu cho môi trường DEVELOPMENT (không bao giờ chạy trên production / test):
 * một tài khoản cho mỗi vai trò ở tòa nhà A và một chủ nhà ở tòa nhà B (kiểm tra cô lập giữa các chủ nhà).
 * Chạy lại seed sẽ ĐẶT LẠI mật khẩu & trạng thái của các tài khoản này (thuận tiện chạy lại bộ Postman).
 */
import type { EntityManager } from 'typeorm';
import * as argon2 from 'argon2';
import type { DatabaseSeed } from '../../../core/database/seeds/seed.interface';
import { RentalRole } from '../../../core/access-control/rental-permissions';
import { ARGON2_OPTIONS } from '../services/password-hasher.service';
import { normalizePassword } from '../domain/password-policy';

export const DEV_BUILDING_A = 'b1000000-0000-4000-8000-000000000001';
export const DEV_BUILDING_B = 'b2000000-0000-4000-8000-000000000002';
export const DEV_ACCOUNT_PASSWORD = 'RentalDev@2026';

export const DEV_ACCOUNTS = [
  { phone: '+84901000001', fullName: 'Chủ nhà A (dev)', role: RentalRole.LANDLORD, buildingId: DEV_BUILDING_A },
  { phone: '+84901000002', fullName: 'Quản lý A (dev)', role: RentalRole.PROPERTY_MANAGER, buildingId: DEV_BUILDING_A },
  { phone: '+84901000003', fullName: 'Kế toán A (dev)', role: RentalRole.ACCOUNTANT, buildingId: DEV_BUILDING_A },
  { phone: '+84901000004', fullName: 'Bảo vệ A (dev)', role: RentalRole.GUARD, buildingId: DEV_BUILDING_A },
  { phone: '+84901000005', fullName: 'Khách thuê A (dev)', role: RentalRole.TENANT, buildingId: DEV_BUILDING_A },
  { phone: '+84902000001', fullName: 'Chủ nhà B (dev)', role: RentalRole.LANDLORD, buildingId: DEV_BUILDING_B },
] as const;

export const devAccountsSeed: DatabaseSeed = {
  name: 'dev-accounts',
  environments: ['development'],
  async run(manager: EntityManager) {
    const passwordHash = await argon2.hash(normalizePassword(DEV_ACCOUNT_PASSWORD), ARGON2_OPTIONS);
    for (const account of DEV_ACCOUNTS) {
      const [{ id }] = await manager.query(
        `INSERT INTO users (phone_e164, full_name, status, password_hash, password_changed_at, phone_verified_at)
         VALUES ($1, $2, 'ACTIVE', $3, now(), now())
         ON CONFLICT (phone_e164) WHERE deleted_at IS NULL
         DO UPDATE SET status = 'ACTIVE', password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name,
                       password_changed_at = now(), phone_verified_at = COALESCE(users.phone_verified_at, now()),
                       updated_at = now(), version = users.version + 1
         RETURNING id`,
        [account.phone, account.fullName, passwordHash],
      );
      await manager.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, account.role]);
      await manager.query(`INSERT INTO user_building_access (user_id, building_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        id,
        account.buildingId,
      ]);
    }
  },
};
