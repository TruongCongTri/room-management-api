/**
 * Hồ sơ mẫu DEVELOPMENT ở tòa A (không chạy trên production / test), chạy SAU dev-accounts:
 *  - Khách thuê dev (0901000005): CCCD 079099001234 (nam, 1999), liên kết với tài khoản TENANT → GET /tenants/me.
 *  - Con gái 11 tuổi: số định danh 079315004321 (nữ, 2015), người giám hộ = khách thuê dev.
 *  - Người nước ngoài: hộ chiếu Hàn Quốc M12345678.
 * Mã hóa / blind index bằng chính EncryptionService của ứng dụng. Idempotent theo (building_id, id_card_hash).
 */
import type { EntityManager } from 'typeorm';
import type { DatabaseSeed } from '../../../core/database/seeds/seed.interface';
import { loadAppConfig } from '../../../core/config/load-config';
import { EncryptionService } from '../../../core/security/encryption/encryption.service';
import { DEV_BUILDING_A } from '../../identity/seeds/dev-accounts.seed';
import { toSearchName } from '../domain/tenant-profile.rules';

const PROFILES = [
  { key: 'parent', fullName: 'Khách thuê A (dev)', type: 'CCCD', id: '079099001234', nationality: 'VN', gender: 'MALE', dob: '1999-08-15', phone: '+84901000005' },
  { key: 'child', fullName: 'Nguyễn Ngọc Ánh (dev)', type: 'CCCD', id: '079315004321', nationality: 'VN', gender: 'FEMALE', dob: '2015-03-02', phone: null, guardian: 'parent' },
  { key: 'foreigner', fullName: 'Kim Min-ji (dev)', type: 'PASSPORT', id: 'M12345678', nationality: 'KR', gender: 'FEMALE', dob: '1995-11-20', phone: '+821012345678' },
] as const;

export const devTenantsSeed: DatabaseSeed = {
  name: 'dev-tenants',
  environments: ['development'],
  async run(manager: EntityManager) {
    const encryption = new EncryptionService(loadAppConfig());
    const ids = new Map<string, string>();
    for (const p of PROFILES) {
      const hash = encryption.computeBlindIndex(p.id);
      const guardianId = 'guardian' in p ? ids.get(p.guardian) : null;
      await manager.query(
        `INSERT INTO tenants (building_id, full_name, full_name_search, id_document_type, id_card_encrypted, id_card_hash, id_card_last4,
                              nationality, gender, date_of_birth, phone, hometown_address, permanent_address,
                              pdpl_consent_accepted_at, consent_guardian_tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'TP. Hồ Chí Minh', '123 Nguyễn Huệ, Phường Bến Nghé, TP.HCM', now(), $12)
         ON CONFLICT (building_id, id_card_hash) DO NOTHING`,
        [DEV_BUILDING_A, p.fullName, toSearchName(p.fullName), p.type, encryption.encrypt(p.id), hash, p.id.slice(-4), p.nationality, p.gender, p.dob, p.phone, guardianId ?? null],
      );
      const [{ id }] = await manager.query(`SELECT id FROM tenants WHERE building_id = $1 AND id_card_hash = $2`, [DEV_BUILDING_A, hash]);
      ids.set(p.key, id);
    }
    // Liên kết hồ sơ với tài khoản TENANT mẫu (bình thường việc này diễn ra lúc chuyển đến - module 3)
    await manager.query(
      `UPDATE tenants t SET user_id = u.id FROM users u
        WHERE t.id = $1 AND u.phone_e164 = '+84901000005' AND u.deleted_at IS NULL AND t.user_id IS NULL`,
      [ids.get('parent')],
    );
  },
};
