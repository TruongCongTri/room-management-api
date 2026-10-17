/**
 * Tính toán sai khác dữ liệu giữa bản ghi cũ và mới,
 * loại bỏ các trường không đổi và tự động che giấu dữ liệu bảo mật (mật khẩu, khóa, thẻ, giấy tờ tùy thân):
 *
 * */

import { EntityDiffSnapshot } from '../interfaces/audit.interface';
import { SENSITIVE_KEYS } from '../../../core/logger/logger.constants';

export const REDACTED_VALUE = '[REDACTED]';

const IGNORED_DIFF_FIELDS = new Set(['updatedAt', 'version']);
// Dùng chung danh mục PCI-DSS / GDPR với logger để audit và log che giấu nhất quán
const SENSITIVE_FIELDS = new Set<string>([...SENSITIVE_KEYS, 'encryptionKey', 'passwordHash']);

export interface DiffOptions {
  /** Trường bổ sung cần che (vd: cột mã hóa FLE của entity) */
  redact?: Iterable<string>;
  /** Trường bỏ qua hoàn toàn */
  ignore?: Iterable<string>;
}

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export function calculateEntityDiff(
  oldData: Record<string, any> | null | undefined,
  newData: Record<string, any> | null | undefined,
  options: DiffOptions = {},
): EntityDiffSnapshot | null {
  if (!oldData || !newData) return null;

  const redact = new Set(options.redact ?? []);
  const ignore = new Set(options.ignore ?? []);
  const diff: EntityDiffSnapshot = {};
  const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);

  for (const key of allKeys) {
    if (IGNORED_DIFF_FIELDS.has(key) || ignore.has(key)) continue;

    const oldVal = normalize(oldData[key]);
    const newVal = normalize(newData[key]);
    if (typeof oldVal === 'function' || typeof newVal === 'function') continue;

    const isOldEmpty = oldVal === undefined || oldVal === null;
    const isNewEmpty = newVal === undefined || newVal === null;
    if (isOldEmpty && isNewEmpty) continue;

    // So sánh dữ liệu dạng chuỗi hóa để bắt kịp cả Objects và Dates
    const oldJson = !isOldEmpty ? JSON.stringify(oldVal) : null;
    const newJson = !isNewEmpty ? JSON.stringify(newVal) : null;
    if (oldJson === newJson) continue;

    diff[key] =
      SENSITIVE_FIELDS.has(key) || redact.has(key)
        ? { from: isOldEmpty ? null : REDACTED_VALUE, to: isNewEmpty ? null : REDACTED_VALUE }
        : { from: isOldEmpty ? null : oldVal, to: isNewEmpty ? null : newVal };
  }

  return Object.keys(diff).length > 0 ? diff : null;
}
