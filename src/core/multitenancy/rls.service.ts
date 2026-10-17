/**
 * Điều phối thực thi Transaction với biến phiên cục bộ (tương đương SET LOCAL):
 *  Đảm bảo biến session của Postgres chỉ tồn tại trong vòng đời của transaction,
 *  tự động hủy khi kết thúc transaction mà không làm bẩn Connection Pool.
 */
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestContextService } from '../context/request-context.service';
import { RLS_CURRENT_BUILDING_VAR, RLS_BYPASS_VAR, UUID_REGEX } from './tenancy.constants';

/** set_config(name, value, is_local=true) ≡ SET LOCAL nhưng hỗ trợ tham số hóa (chống SQL injection) */
const SET_LOCAL_SQL = 'SELECT set_config($1, $2, true)';

@Injectable()
export class RlsService {
  private readonly logger = new Logger(RlsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly contextService: RequestContextService,
  ) {}

  /**
   * Thực thi khối lệnh trong Transaction với RLS bảo vệ nghiêm ngặt
   * (`SET LOCAL app.current_building_id`, tự hủy khi COMMIT/ROLLBACK).
   * explicitTenantId (buildingId) chỉ dành cho worker nền / tài khoản đặc quyền.
   */
  async runInTenantContext<T>(
    operation: (manager: EntityManager) => Promise<T>,
    explicitTenantId?: string,
  ): Promise<T> {
    const contextTenantId = this.contextService.getTenantId();

    if (
      explicitTenantId &&
      contextTenantId &&
      explicitTenantId !== contextTenantId &&
      !this.isTrustedCaller()
    ) {
      throw new ForbiddenException('Cannot execute in a building other than the authenticated one.');
    }

    const tenantId = explicitTenantId || contextTenantId;
    if (!tenantId || !UUID_REGEX.test(tenantId)) {
      throw new BadRequestException(
        'A valid UUID building context is required for database execution.',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.query(SET_LOCAL_SQL, [RLS_CURRENT_BUILDING_VAR, tenantId]);
      return operation(manager);
    });
  }

  /**
   * Thực thi Transaction với quyền Bypass RLS (Dành cho SuperAdmin, Migration, Cron đối soát).
   * Chỉ được gọi từ worker nền (runAsSystem) hoặc user SUPER_ADMIN/SYSTEM.
   */
  async runWithBypass<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (!this.isTrustedCaller()) {
      throw new ForbiddenException('RLS bypass is restricted to system workers and super admins.');
    }

    this.logger.warn(
      `[Security] RLS BYPASS transaction (traceId=${this.contextService.getTraceId()}, actor=${this.contextService.getUserId() ?? 'unknown'}).`,
    );

    return this.dataSource.transaction(async (manager) => {
      await manager.query(SET_LOCAL_SQL, [RLS_BYPASS_VAR, 'on']);
      return operation(manager);
    });
  }

  /** Bí danh theo thuật ngữ tài liệu 01 (RlsService.runWithTenantTransaction) */
  runWithTenantTransaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.runInTenantContext(operation);
  }

  /** Bí danh theo thuật ngữ tài liệu 01: cron toàn tòa nhà, Outbox poller, báo cáo SuperAdmin */
  runWithSystemBypass<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.runWithBypass(operation);
  }

  private isTrustedCaller(): boolean {
    return this.contextService.isBackgroundJob() || this.contextService.isPrivileged();
  }
}
