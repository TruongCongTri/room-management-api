/**
 * Danh sách seed theo thứ tự thực thi. Module nghiệp vụ đăng ký seed của mình tại đây
 * (mỗi seed BẮT BUỘC idempotent - xem seed.interface.ts).
 */
import type { DatabaseSeed } from './seed.interface';
import { REFERENCE_DATA_SEEDS } from './reference-data.seed';

export const SEEDS: DatabaseSeed[] = [...REFERENCE_DATA_SEEDS];
