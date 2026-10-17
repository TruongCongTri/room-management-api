/**
 * Ma trận quyền dạng `<resource>:<action>:<scope>` (vd: `meters:create:department`).
 */
export enum Action {
  MANAGE = 'manage', // Toàn quyền (Create, Read, Update, Delete + mọi action nghiệp vụ)
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  EXECUTE = 'execute', // Thực thi nghiệp vụ: trả phòng giữa tháng, chạy kỳ hóa đơn
  UPLOAD = 'upload', // Xin Presigned URL tải ảnh đồng hồ / giấy tờ
  APPROVE = 'approve', // Duyệt chỉ số reset/thay đồng hồ, duyệt hợp đồng
  SETTLE = 'settle', // Quyết toán tiền cọc
  EXPORT = 'export', // Xuất tờ khai thuế 01/BĐS, hồ sơ cư trú CT01
}

export enum Scope {
  OWN = 'own', // Bản ghi của chính user (khách thuê: hợp đồng / hóa đơn của mình)
  DEPARTMENT = 'department', // Bản ghi thuộc TÒA NHÀ được phân công (buildingId)
  GLOBAL = 'global', // Mọi tòa nhà mà tài khoản được phép truy cập
}

export enum PermissionEffect {
  GRANT = 'GRANT',
  DENY = 'DENY',
}

export interface EffectivePermissionRule {
  resource: string;
  action: Action;
  scope: Scope;
  effect: PermissionEffect;
  conditions?: Record<string, any>; // Phục vụ ABAC nâng cao
}

/** Thuộc tính ABAC của bản ghi mục tiêu */
export interface ResourceEntity {
  userId?: string;
  buildingId?: string;
  departmentId?: string;
  [key: string]: any;
}
