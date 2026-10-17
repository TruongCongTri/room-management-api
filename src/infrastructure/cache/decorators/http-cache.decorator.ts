import { SetMetadata } from '@nestjs/common';

export const HTTP_CACHE_METADATA = 'cache:http_cache_options';

export interface HttpCacheOptions {
  ttlSeconds?: number;
  tags?: string[];
  /**
   * Phạm vi chia sẻ response:
   *  - 'tenant' (mặc định): dùng chung trong một tenant (danh mục sân bay, bảng giá công khai của tenant)
   *  - 'user': riêng từng user (dữ liệu cá nhân hóa)
   */
  scope?: 'tenant' | 'user';
}

/**
 * Tự động cache response của route GET (HttpCacheInterceptor đăng ký toàn cục).
 * @example
 * @Get('airports')
 * @HttpCache({ ttlSeconds: 3600, tags: ['airports'] })
 */
export const HttpCache = (options: HttpCacheOptions = {}) =>
  SetMetadata(HTTP_CACHE_METADATA, { scope: 'tenant', ...options } satisfies HttpCacheOptions);
