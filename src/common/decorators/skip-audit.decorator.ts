import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const SKIP_AUDIT_KEY = 'audit:skip_http_audit';

/**
 * Bỏ qua ghi audit HTTP cho route (vd: endpoint nhận webhook tần suất cao đã có audit nghiệp vụ riêng).
 */
export const SkipAudit = (): CustomDecorator<string> => SetMetadata(SKIP_AUDIT_KEY, true);
