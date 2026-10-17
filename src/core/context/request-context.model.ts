import { EffectivePermissionRule } from '../access-control/access-control.types';

export const SYSTEM_USER_ID = 'SYSTEM_INTERNAL_SERVICE';
export const SYSTEM_ROLE = 'SYSTEM';
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export interface RequestUserContext {
  id: string;
  /** Số điện thoại đã che (090****567) - định danh hiển thị của người dùng, KHÔNG BAO GIỜ là số đầy đủ */
  phoneMasked?: string;
  /** Phiên đăng nhập (auth_sessions.id, claim `sid`) - dùng cho thu hồi tức thời & đăng xuất */
  sessionId?: string;
  /** Tòa nhà (building_id) mặc định của user - phạm vi cô lập dữ liệu RLS */
  tenantId?: string;
  /** Các tòa nhà user được phép chuyển sang qua header X-Building-ID */
  buildingIds?: string[];
  departmentId?: string;
  roles: string[];
  // Danh sách ma trận quyền đã hợp nhất gồm cả Base Grants và Direct Overrides (Grant/Deny)
  rules: EffectivePermissionRule[];
}

export interface RequestContextData {
  traceId: string;
  /**
   * Tenant do mã phía server gieo vào context nền (job payload, outbox, cron) - đáng tin cậy.
   * Không bao giờ lấy từ header của client (xem requestedTenantId).
   */
  tenantId?: string;
  clientIp: string;
  userAgent?: string;
  /** Ngôn ngữ phản hồi đã phân giải từ Accept-Language (vi | en | ja | ko) */
  locale?: string;
  user?: RequestUserContext;
  startTime: number;
  isBackgroundJob?: boolean;
  /**
   * Tenant đã được xác thực khác với user.tenantId (chỉ SUPER_ADMIN/SYSTEM được phép chuyển tenant)
   */
  tenantOverride?: string;
  /**
   * Tenant client yêu cầu qua header (CHƯA XÁC THỰC) - không được dùng để ghi dữ liệu
   */
  requestedTenantId?: string;
  metadata: Map<string, unknown>;
}

/** Tham số khởi tạo context cho tác vụ nền / test */
export type ContextSeed = Partial<Omit<RequestContextData, 'metadata'>> & {
  metadata?: Map<string, unknown>;
};
