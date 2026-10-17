import type { EntityManager } from 'typeorm';

/**
 * Seed dữ liệu danh mục tĩnh (lookup tables, quyền hệ thống, tenant mặc định...).
 * BẮT BUỘC idempotent: chạy lại nhiều lần không tạo bản ghi trùng
 * (dùng INSERT ... ON CONFLICT DO NOTHING / DO UPDATE hoặc kiểm tra tồn tại).
 */
export interface DatabaseSeed {
  /** Tên duy nhất, hiển thị trong log */
  readonly name: string;
  /** Môi trường được phép chạy (mặc định: mọi môi trường) - vd dữ liệu demo chỉ cho development */
  readonly environments?: Array<'development' | 'production' | 'test'>;
  run(manager: EntityManager): Promise<void>;
}
