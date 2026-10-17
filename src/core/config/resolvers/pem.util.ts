import { readFileSync } from 'fs';
import { isInlinePem } from '../schemas/env.helpers';

/**
 * Đọc chứng chỉ/khóa PEM: chấp nhận PEM nội tuyến (kể cả dạng một dòng có "\n" thoát
 * như trong K8s Secret / dashboard của PaaS) hoặc đường dẫn file.
 */
export function readPemOrPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isInlinePem(value)) {
    return value.replace(/\\n/g, '\n');
  }
  return readFileSync(value, 'utf8');
}
