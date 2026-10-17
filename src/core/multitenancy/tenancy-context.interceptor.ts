/**
 * Xác định TÒA NHÀ hiệu lực của request SAU khi Auth Guard đã chạy
 * (middleware chạy trước Guard nên không thể so khớp với JWT),
 * ngăn chặn tấn công giả mạo phạm vi (Building Spoofing):
 *  - Header X-Building-ID phải là UUID hợp lệ.
 *  - User đã đăng nhập: header phải trùng tòa nhà trong token, hoặc nằm trong `buildingIds` được cấp
 *    (chủ nhà quản lý nhiều tòa). SUPER_ADMIN / SYSTEM được chuyển sang bất kỳ tòa nhà nào.
 *  - Request ẩn danh: header chỉ được lưu dạng "requestedTenantId" (chưa xác thực),
 *    KHÔNG BAO GIỜ được dùng làm phạm vi ghi dữ liệu.
 */
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContextService } from '../context/request-context.service';
import { syncUserFromRequest } from '../context/request-context.interceptor';
import { SUPER_ADMIN_ROLE, SYSTEM_ROLE } from '../context/request-context.model';
import { BUILDING_HEADER, UUID_REGEX } from './tenancy.constants';

@Injectable()
export class TenancyContextInterceptor implements NestInterceptor {
  constructor(private readonly contextService: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const rawHeader = req.headers?.[BUILDING_HEADER];
    const headerBuildingId: string | undefined = Array.isArray(rawHeader)
      ? rawHeader[0]
      : rawHeader;

    if (headerBuildingId && !UUID_REGEX.test(headerBuildingId)) {
      throw new BadRequestException(`Invalid '${BUILDING_HEADER}' format. Must be a valid UUID.`);
    }

    // Không phụ thuộc thứ tự đăng ký interceptor: tự đồng bộ request.user vào context
    const user = syncUserFromRequest(context, this.contextService);

    if (!user) {
      this.contextService.setRequestedTenantId(headerBuildingId);
      return next.handle();
    }

    if (headerBuildingId && headerBuildingId !== user.tenantId) {
      const isPrivileged =
        user.roles.includes(SUPER_ADMIN_ROLE) || user.roles.includes(SYSTEM_ROLE);
      const isAssignedBuilding = user.buildingIds?.includes(headerBuildingId) ?? false;
      if (!isPrivileged && !isAssignedBuilding) {
        throw new ForbiddenException(
          'Building access mismatch: X-Building-ID is not assigned to the authenticated user.',
        );
      }
      this.contextService.setTenantOverride(headerBuildingId);
    }

    return next.handle();
  }
}
