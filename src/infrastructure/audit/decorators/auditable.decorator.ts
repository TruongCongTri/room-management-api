/**
 * Đánh dấu Entity cần ghi audit tự động (CREATE / UPDATE / DELETE / RESTORE kèm diff snapshot).
 * Chủ động opt-in để không ghi audit cho bảng kỹ thuật (outbox, audit_logs, session...).
 *
 * @example
 * @Auditable({ resource: 'contracts', exclude: ['searchVector'] })
 * @Entity('contracts')
 * export class Contract extends BuildingScopedEntity { ... }
 */
export const AUDITABLE_METADATA = Symbol('audit:auditable');

export interface AuditableOptions {
  /** Tên tài nguyên trong audit_logs.resource (mặc định: tên bảng) */
  resource?: string;
  /** Trường không đưa vào diff */
  exclude?: string[];
  /** Trường luôn bị che giá trị trong diff (ngoài danh mục nhạy cảm chuẩn và cột mã hóa FLE) */
  redact?: string[];
}

export function Auditable(options: AuditableOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AUDITABLE_METADATA, options, target);
  };
}

export function getAuditableOptions(target: unknown): AuditableOptions | undefined {
  if (typeof target !== 'function') return undefined;
  return Reflect.getMetadata(AUDITABLE_METADATA, target);
}
