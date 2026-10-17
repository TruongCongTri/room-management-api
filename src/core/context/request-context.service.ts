import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import {
  ContextSeed,
  RequestContextData,
  RequestUserContext,
  SUPER_ADMIN_ROLE,
  SYSTEM_ROLE,
  SYSTEM_USER_ID,
} from './request-context.model';
import { EffectivePermissionRule } from '../access-control/access-control.types';

export const UNTRACKED_TRACE_ID = 'TRACE-UNTRACKED';

@Injectable()
export class RequestContextService {
  private static readonly storage = new AsyncLocalStorage<RequestContextData>();

  /**
   * Truy cập tĩnh context hiện hành cho mã chạy ngoài DI (decorator tham số, Domain Event,
   * TypeORM ValueTransformer). Trong Service/Guard hãy inject RequestContextService.
   */
  static current(): RequestContextData | undefined {
    return RequestContextService.storage.getStore();
  }

  /**
   * Khởi chạy một context mới bao bọc toàn bộ vòng đời của request
   */
  run<T>(context: RequestContextData, fn: () => T): T {
    return RequestContextService.storage.run(context, fn);
  }

  /**
   * @deprecated Dùng run() - giữ lại để tương thích ngược
   */
  runWithResult<T>(context: RequestContextData, fn: () => T): T {
    return this.run(context, fn);
  }

  /**
   * Khởi tạo context tường minh cho worker nền (BullMQ, Outbox, Cron) khi đã biết
   * traceId/user gốc (ví dụ được truyền theo payload của job) để giữ chuỗi truy vết.
   */
  runWithContext<T>(seed: ContextSeed, fn: () => T): T {
    const context: RequestContextData = {
      traceId: seed.traceId || randomUUID(),
      // Tenant gieo từ payload của job/outbox là tenant hiệu lực của tác vụ nền (đã xác thực khi enqueue)
      tenantId: seed.tenantId,
      tenantOverride: seed.tenantOverride ?? seed.tenantId,
      clientIp: seed.clientIp || '127.0.0.1',
      userAgent: seed.userAgent,
      locale: seed.locale,
      user: seed.user,
      startTime: seed.startTime ?? Date.now(),
      isBackgroundJob: seed.isBackgroundJob ?? true,
      requestedTenantId: seed.requestedTenantId,
      metadata: seed.metadata ?? new Map(),
    };
    return this.run(context, fn);
  }

  /**
   * Khởi tạo Context cho các tác vụ nền không có HTTP request (Queue Worker, Cron Job, Outbox Poller)
   */
  runAsSystem<T>(operationName: string, fn: () => T, tenantId?: string): T {
    return this.runWithContext(
      {
        traceId: `SYS-${operationName.toUpperCase()}-${randomUUID()}`,
        userAgent: 'SystemInternalWorker',
        isBackgroundJob: true,
        user: {
          id: SYSTEM_USER_ID,
          tenantId,
          roles: [SYSTEM_ROLE],
          rules: [],
        },
      },
      fn,
    );
  }

  /**
   * Lấy snapshot dữ liệu của request hiện tại
   */
  getStore(): RequestContextData | undefined {
    return RequestContextService.storage.getStore();
  }

  hasActiveContext(): boolean {
    return this.getStore() !== undefined;
  }

  /**
   * Được gọi bởi AuthGuard / Interceptor sau khi giải mã JWT thành công
   */
  setUser(user: RequestUserContext): void {
    const store = this.getStore();
    if (store) {
      store.user = user;
    }
  }

  /**
   * Chuyển tenant hiệu lực của request (chỉ gọi sau khi đã kiểm tra quyền SUPER_ADMIN / SYSTEM)
   */
  setTenantOverride(tenantId: string | undefined): void {
    const store = this.getStore();
    if (store) {
      store.tenantOverride = tenantId;
    }
  }

  setRequestedTenantId(tenantId: string | undefined): void {
    const store = this.getStore();
    if (store) {
      store.requestedTenantId = tenantId;
    }
  }

  // --- CÁC GETTER TRÍCH XUẤT NHANH (ZERO PROP-DRILLING) ---

  getTraceId(): string {
    return this.getStore()?.traceId || UNTRACKED_TRACE_ID;
  }

  getCurrentUser(): RequestUserContext | undefined {
    return this.getStore()?.user;
  }

  getUserId(): string | undefined {
    return this.getStore()?.user?.id;
  }

  getUserPhoneMasked(): string | undefined {
    return this.getStore()?.user?.phoneMasked;
  }

  /**
   * Tenant ĐÃ XÁC THỰC: tenant override hợp lệ hoặc tenant trong token của user.
   * Không bao giờ trả về giá trị lấy thẳng từ header client.
   */
  getTenantId(): string | undefined {
    const store = this.getStore();
    return store?.tenantOverride ?? store?.user?.tenantId;
  }

  /**
   * Tòa nhà hiệu lực (building_id) - cùng giá trị với getTenantId(): phạm vi cô lập dữ liệu là tòa nhà
   */
  getBuildingId(): string | undefined {
    return this.getTenantId();
  }

  /**
   * Tenant client yêu cầu qua header (chưa xác thực) - chỉ dùng cho luồng public (login, đăng ký)
   */
  getRequestedTenantId(): string | undefined {
    return this.getStore()?.requestedTenantId;
  }

  getDepartmentId(): string | undefined {
    return this.getStore()?.user?.departmentId;
  }

  getUserRoles(): string[] {
    return this.getStore()?.user?.roles || [];
  }

  hasRole(role: string): boolean {
    return this.getUserRoles().includes(role);
  }

  /** SUPER_ADMIN hoặc tài khoản hệ thống nội bộ */
  isPrivileged(): boolean {
    return this.hasRole(SUPER_ADMIN_ROLE) || this.hasRole(SYSTEM_ROLE);
  }

  getUserRules(): EffectivePermissionRule[] {
    return this.getStore()?.user?.rules || [];
  }

  getClientIp(): string {
    return this.getStore()?.clientIp || '127.0.0.1';
  }

  getUserAgent(): string | undefined {
    return this.getStore()?.userAgent;
  }

  getLocale(): string | undefined {
    return this.getStore()?.locale;
  }

  getStartTime(): number {
    return this.getStore()?.startTime || Date.now();
  }

  getDurationMs(): number {
    return Date.now() - this.getStartTime();
  }

  isBackgroundJob(): boolean {
    return !!this.getStore()?.isBackgroundJob;
  }

  // --- QUẢN LÝ METADATA MỞ RỘNG ---

  setMetadata(key: string, value: unknown): void {
    const store = this.getStore();
    if (store) {
      store.metadata.set(key, value);
    }
  }

  getMetadata<T>(key: string): T | undefined {
    return this.getStore()?.metadata.get(key) as T | undefined;
  }
}
