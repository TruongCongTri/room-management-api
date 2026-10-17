/**
 * Interceptor này chạy sau Guards.
 * Khi JwtAuthGuard xác thực thành công và gán thông tin vào request.user,
 * Interceptor lập tức đồng bộ đối tượng này vào RequestContextService.
 * Kể từ thời điểm này, mọi Service, Helper, TypeORM Subscriber bên dưới
 * đều có thể lấy userId, tenantId, rules mà không cần chạm vào request object.
 *
 * Đồng thời đặt tên span server của OpenTelemetry theo route template ("GET /api/v1/properties/rooms/:id")
 * để trace có thể gom nhóm theo endpoint (no-op khi tracing tắt).
 *
 * Lưu ý: Guard chạy TRƯỚC interceptor, vì vậy các guard cần user (PermissionsGuard)
 * phải tự gọi syncUserFromRequest().
 */
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Observable } from 'rxjs';
import { RequestContextService } from './request-context.service';
import { RequestUserContext } from './request-context.model';

/**
 * Đồng bộ request.user (do JwtAuthGuard gán) vào AsyncLocalStorage.
 * Trả về user hiệu lực (ưu tiên request.user).
 */
export function syncUserFromRequest(
  context: ExecutionContext,
  contextService: RequestContextService,
): RequestUserContext | undefined {
  if (context.getType() !== 'http') {
    return contextService.getCurrentUser();
  }
  const request = context.switchToHttp().getRequest();
  const user: RequestUserContext | undefined = request?.user;
  if (user && contextService.getCurrentUser() !== user) {
    contextService.setUser(user);
  }
  return user ?? contextService.getCurrentUser();
}

@Injectable()
export class RequestContextSyncInterceptor implements NestInterceptor {
  constructor(private readonly contextService: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    syncUserFromRequest(context, this.contextService);

    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest();
      const route: string | undefined = request?.route?.path;
      const span = trace.getActiveSpan();
      if (span && route) {
        span.updateName(`${request.method} ${route}`);
        span.setAttribute('http.route', route);
      }
    }

    return next.handle();
  }
}
