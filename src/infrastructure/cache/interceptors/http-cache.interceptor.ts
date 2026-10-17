/**
 * Interceptor tự động cache GET response theo Route (chỉ kích hoạt với @HttpCache()).
 * Đặt BÊN TRONG TransformInterceptor: cache dữ liệu thô của handler, envelope (traceId, durationMs)
 * vẫn được tạo mới cho từng request.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, Observable, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { RedisCacheService } from '../services/redis-cache.service';
import { HTTP_CACHE_METADATA, HttpCacheOptions } from '../decorators/http-cache.decorator';

export const CACHE_LOOKUP_HEADER = 'X-Cache-Lookup';

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cacheService: RedisCacheService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<HttpCacheOptions>(HTTP_CACHE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();
    if (!options || request.method !== 'GET') return next.handle();

    const response = context.switchToHttp().getResponse();
    const principal = options.scope === 'user' ? `u:${request.user?.id ?? 'anonymous'}` : 'shared';
    // originalUrl gồm cả query string → mỗi tổ hợp tham số là một entry riêng
    const key = `http:${principal}:${request.originalUrl ?? request.url}`;

    return from(this.cacheService.get<unknown>(key)).pipe(
      switchMap((cached) => {
        if (cached !== null) {
          response.setHeader(CACHE_LOOKUP_HEADER, 'HIT');
          return of(cached);
        }
        response.setHeader(CACHE_LOOKUP_HEADER, 'MISS');
        return next.handle().pipe(
          tap((body) => {
            if (body === undefined || response.statusCode >= 300) return;
            void this.cacheService.set(key, body, { ttlSeconds: options.ttlSeconds, tags: options.tags });
          }),
        );
      }),
    );
  }
}
