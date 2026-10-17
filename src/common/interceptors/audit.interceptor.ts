/**
 * Tự động ghi nhận thông tin kiểm toán (Audit Trail) cho mọi thao tác ghi dữ liệu (POST, PUT, PATCH, DELETE):
 *  - Bản ghi bất biến vào audit_logs qua AuditWriterService (ai, route, IP, User-Agent, status, durationMs, kết quả).
 *  - Đồng thời ghi log có cấu trúc (ELK/Loki).
 * Bỏ qua phương thức an toàn (GET, HEAD, OPTIONS) để không làm ngập bảng log; tắt theo route bằng @SkipAudit().
 * Lỗi ghi audit không bao giờ làm hỏng response của người dùng (fire-and-forget có log lỗi).
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { AuditWriterService } from '../../infrastructure/audit/services/audit-writer.service';
import { AuditAction } from '../../infrastructure/audit/interfaces/audit.interface';
import { SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';

const METHOD_ACTIONS: Record<string, AuditAction> = {
  POST: AuditAction.CREATE,
  PUT: AuditAction.UPDATE,
  PATCH: AuditAction.UPDATE,
  DELETE: AuditAction.DELETE,
};

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly mutatingMethods = new Set(Object.keys(METHOD_ACTIONS));
  private readonly httpAuditEnabled: boolean;

  constructor(
    private readonly contextService: RequestContextService,
    private readonly logger: AppLoggerService,
    @Optional() private readonly reflector?: Reflector,
    @Optional() private readonly auditWriter?: AuditWriterService,
    @Optional() config?: AppConfigService,
  ) {
    this.httpAuditEnabled = config?.audit.httpEnabled ?? true;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http' || !this.httpAuditEnabled) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const method: string = (request.method ?? 'GET').toUpperCase();

    // Chỉ giám sát các thao tác làm biến đổi dữ liệu (Mutating Operations)
    if (!this.mutatingMethods.has(method)) {
      return next.handle();
    }
    if (this.reflector?.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [context.getHandler(), context.getClass()])) {
      return next.handle();
    }

    const response = context.switchToHttp().getResponse();
    const endpoint: string = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const base = {
      actorId: this.contextService.getUserId() || 'ANONYMOUS',
      tenantId: this.contextService.getTenantId() || 'SYSTEM',
      traceId: this.contextService.getTraceId(),
      clientIp: this.contextService.getClientIp(),
      method,
      endpoint,
    };

    const persist = (outcome: 'SUCCESS' | 'FAILED', statusCode: number, durationMs: number, error?: string) => {
      if (!this.auditWriter) return;
      void this.auditWriter.record({
        action: METHOD_ACTIONS[method],
        // Route pattern (vd: /api/v1/contracts/:id) thay cho URL cụ thể → truy vấn audit theo tài nguyên
        resource: `${request.baseUrl ?? ''}${request.route?.path ?? endpoint}`.slice(0, 255),
        resourceId: String(request.params?.id ?? request.params?.[Object.keys(request.params ?? {})[0]] ?? '-'),
        metadata: { channel: 'HTTP', method, path: endpoint, statusCode, durationMs, outcome, error },
      });
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = this.contextService.getDurationMs();
          this.logger.log({ event: 'AUDIT_MUTATION_SUCCESS', ...base, durationMs }, AuditInterceptor.name);
          persist('SUCCESS', response?.statusCode ?? 200, durationMs);
        },
        error: (error) => {
          const durationMs = this.contextService.getDurationMs();
          const statusCode = typeof error?.getStatus === 'function' ? error.getStatus() : 500;
          this.logger.warn(
            { event: 'AUDIT_MUTATION_FAILED', ...base, durationMs, errorMessage: error?.message },
            AuditInterceptor.name,
          );
          persist('FAILED', statusCode, durationMs, error?.message);
        },
      }),
    );
  }
}
