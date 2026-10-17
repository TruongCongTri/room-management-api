import { SetMetadata, CustomDecorator } from '@nestjs/common';

export interface DeprecationOptions {
  deprecatedAt?: string;    // Ngày bắt đầu đánh dấu deprecation (ISO string hoặc Date)
  sunsetDate: string;       // Ngày chính thức gỡ bỏ API (RFC 8594 Sunset date, ví dụ '2026-12-31')
  alternativePath?: string; // Endpoint thay thế khuyến nghị
}

export const DEPRECATION_KEY = 'api:deprecation';

export const DeprecatedApi = (options: DeprecationOptions): CustomDecorator<string> =>
  SetMetadata(DEPRECATION_KEY, options);