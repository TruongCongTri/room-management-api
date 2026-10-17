/**
 * Tenant ĐÃ XÁC THỰC của request (tenant trong JWT, hoặc tenant SUPER_ADMIN/SYSTEM chuyển sang hợp lệ
 * do TenancyContextInterceptor kiểm tra). KHÔNG BAO GIỜ trả về giá trị thô của header x-building-id:
 * client ẩn danh có thể tự đặt header bất kỳ (Tenant Spoofing).
 *
 * Luồng công khai cần biết tenant mà client chỉ định (đăng nhập, đăng ký) dùng @RequestedTenant().
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContextService } from '../../core/context/request-context.service';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const store = RequestContextService.current();
  const request = ctx.switchToHttp().getRequest();
  return store?.tenantOverride ?? store?.user?.tenantId ?? request?.user?.tenantId;
});

/**
 * Tenant client yêu cầu qua header (đã kiểm tra định dạng UUID nhưng CHƯA xác thực quyền) -
 * chỉ dùng để định tuyến luồng công khai, không dùng làm tenant ghi dữ liệu.
 */
export const RequestedTenant = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string | undefined => {
  return RequestContextService.current()?.requestedTenantId;
});
