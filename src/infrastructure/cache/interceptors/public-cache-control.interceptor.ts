/**
 * Bộ nhớ đệm phía trình duyệt / CDN cho response ẨN DANH, không mang dữ liệu cá nhân (website giới thiệu, tài liệu 01 mục 4.2):
 *  - `Cache-Control: public, max-age=<n>, stale-while-revalidate=300` + `Vary: Accept-Language`.
 *  - ETag yếu = SHA-256 của DỮ LIỆU handler trả về (interceptor của route chạy BÊN TRONG TransformInterceptor, nên envelope
 *    mang traceId / timestamp thay đổi mỗi request không làm ETag đổi theo).
 *  - `If-None-Match` khớp → 304, không có body.
 * Chỉ áp cho GET; response lỗi đi qua exception filter nên không bao giờ bị gắn header cache.
 *
 * @example
 * @UseInterceptors(PublicCacheControlInterceptor)
 * @PublicCacheControl(60)
 * @Get('rooms')
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const PUBLIC_CACHE_CONTROL_KEY = 'cache:public_cache_control';
export const STALE_WHILE_REVALIDATE_SEC = 300;

export const PublicCacheControl = (maxAgeSeconds = 60) => SetMetadata(PUBLIC_CACHE_CONTROL_KEY, maxAgeSeconds);

export function weakEtagOf(data: unknown): string {
  return `W/"${createHash('sha256').update(JSON.stringify(data ?? null)).digest('base64url').slice(0, 27)}"`;
}

/** If-None-Match có thể chứa nhiều ETag ("a", "b") hoặc "*" */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || strip(tag) === strip(etag));
}

@Injectable()
export class PublicCacheControlInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const maxAge = this.reflector.getAllAndOverride<number>(PUBLIC_CACHE_CONTROL_KEY, [context.getHandler(), context.getClass()]);
    const http = context.switchToHttp();
    const request = http.getRequest();
    if (maxAge === undefined || context.getType() !== 'http' || request.method !== 'GET') return next.handle();

    const response = http.getResponse();
    return next.handle().pipe(
      map((data) => {
        const etag = weakEtagOf(data);
        response.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SEC}`);
        response.setHeader('ETag', etag);
        response.setHeader('Vary', 'Accept-Language');
        if (etagMatches(request.headers?.['if-none-match'], etag)) {
          response.status(304);
          return undefined;
        }
        return data;
      }),
    );
  }
}
