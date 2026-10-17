/**
 * Danh sách seed theo thứ tự thực thi. Module nghiệp vụ đăng ký seed của mình tại đây
 * (mỗi seed BẮT BUỘC idempotent - xem seed.interface.ts).
 */
import type { DatabaseSeed } from './seed.interface';
import { REFERENCE_DATA_SEEDS } from './reference-data.seed';
import { devAccountsSeed } from '../../../modules/identity/seeds/dev-accounts.seed';

// Tài khoản mẫu cần system_roles → chạy SAU dữ liệu tham chiếu
export const SEEDS: DatabaseSeed[] = [...REFERENCE_DATA_SEEDS, devAccountsSeed];
