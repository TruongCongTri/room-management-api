import { applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/**
 * Cổng tài liệu OpenAPI tách biệt (tài liệu 04, mục 1.1):
 *  - admin:    LANDLORD / PROPERTY_MANAGER / ACCOUNTANT (phòng, hợp đồng, trả phòng, thuế, audit).
 *  - guard:    GUARD - app di động ghi chỉ số điện nước (Presigned PUT, checklist phòng thiếu chỉ số).
 *  - external: TENANT tự phục vụ + webhook ngân hàng VietQR.
 *  - public:   website giới thiệu - /public/* không cần đăng nhập (tài liệu 04, mục 1.5).
 *  - internal: toàn bộ API (chỉ dành cho đội phát triển).
 */
export type ApiAudienceType = 'admin' | 'guard' | 'external' | 'public' | 'internal';

export const API_AUDIENCE_EXTENSION = 'x-audience';

/** Các cổng công bố riêng (internal là tài liệu đầy đủ ở đường dẫn gốc) */
export const PUBLISHED_API_AUDIENCES = ['admin', 'guard', 'external', 'public'] as const;

/**
 * Gắn endpoint vào một hoặc nhiều cổng tài liệu.
 * Endpoint KHÔNG gắn decorator chỉ xuất hiện trong tài liệu internal (mặc định an toàn).
 *
 * @example
 * @ApiAudience('admin', 'guard')
 * @Controller('metering')
 */
export const ApiAudience = (...audiences: ApiAudienceType[]) =>
  applyDecorators(ApiExtension(API_AUDIENCE_EXTENSION, audiences));
