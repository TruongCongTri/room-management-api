/**
 * Gắn header thông báo lộ trình ngừng hỗ trợ cho route được đánh dấu @DeprecatedApi():
 *  - Deprecation (RFC 9745): "@<unix-seconds>" khi biết ngày bắt đầu deprecate, ngược lại "true".
 *  - Sunset (RFC 8594): HTTP-date ngày gỡ bỏ.
 *  - Link: rel="successor-version" trỏ tới endpoint thay thế.
 * Được AppModule đăng ký toàn cục (không cần @UseInterceptors).
 */
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { Response } from 'express';
import { DEPRECATION_KEY, DeprecationOptions } from './deprecation.decorator';

@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const options = this.reflector.getAllAndOverride<DeprecationOptions>(DEPRECATION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (options) {
      const res = context.switchToHttp().getResponse<Response>();
      const deprecatedAt = options.deprecatedAt ? new Date(options.deprecatedAt).getTime() : NaN;

      res.setHeader('Deprecation', Number.isFinite(deprecatedAt) ? `@${Math.floor(deprecatedAt / 1000)}` : 'true');
      res.setHeader('Sunset', new Date(options.sunsetDate).toUTCString());

      if (options.alternativePath) {
        res.setHeader('Link', `<${options.alternativePath}>; rel="successor-version"`);
      }
    }

    return next.handle();
  }
}
