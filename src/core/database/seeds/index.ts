/**
 * Danh sách seed theo thứ tự thực thi. Module nghiệp vụ đăng ký seed của mình tại đây
 * (mỗi seed BẮT BUỘC idempotent - xem seed.interface.ts).
 */
import type { DatabaseSeed } from './seed.interface';
import { REFERENCE_DATA_SEEDS } from './reference-data.seed';
import { devAccountsSeed } from '../../../modules/identity/seeds/dev-accounts.seed';
import { devPropertiesSeed } from '../../../modules/properties/seeds/dev-properties.seed';
import { devTenantsSeed } from '../../../modules/tenants/seeds/dev-tenants.seed';

// Thứ tự: dữ liệu tham chiếu → tòa nhà / phòng (FK user_building_access → buildings) → tài khoản mẫu → hồ sơ người ở
export const SEEDS: DatabaseSeed[] = [...REFERENCE_DATA_SEEDS, devPropertiesSeed, devAccountsSeed, devTenantsSeed];
