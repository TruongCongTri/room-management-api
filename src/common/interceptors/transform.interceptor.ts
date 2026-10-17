/**
 * Chuyển đổi mọi kết quả trả về từ Controller thành cấu trúc Envelope JSON chuẩn doanh nghiệp,
 * tự động gắn traceId và thời gian thực thi.
 * Giữ nguyên dữ liệu khi: route có @SkipEnvelope(), trả về file/stream (StreamableFile, Buffer, Readable).
 *
 * */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Readable } from 'stream';
import { ApiResponseEnvelope } from './response-envelope.interface';
import { SKIP_ENVELOPE_KEY } from './skip-envelope.decorator';
import { RequestContextService } from '../../core/context/request-context.service';

function isRawPayload(data: unknown): boolean {
  return data instanceof StreamableFile || Buffer.isBuffer(data) || data instanceof Readable;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponseEnvelope<T> | T> {
  constructor(
    private readonly contextService: RequestContextService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Chỉ áp dụng bọc Envelope cho HTTP Context
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skip = this.reflector?.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return next.handle();
    }

    const response = context.switchToHttp().getResponse();
    const traceId = this.contextService.getTraceId();

    return next.handle().pipe(
      map((resData) => {
        if (isRawPayload(resData)) {
          return resData;
        }

        const statusCode = response.statusCode || 200;
        const durationMs = this.contextService.getDurationMs();

        // Xử lý trường hợp dữ liệu trả về đã chứa metadata phân trang
        let extractedData = resData;
        let paginationMeta: ApiResponseEnvelope<T>['meta']['pagination'] = undefined;

        if (resData && typeof resData === 'object' && 'items' in resData && 'total' in resData) {
          extractedData = resData.items;
          const page = Number(resData.page ?? 1);
          const limit = Number(resData.limit ?? 20);
          const totalItems = Number(resData.total ?? 0);
          const totalPages = limit > 0 ? Math.ceil(totalItems / limit) : 0;
          paginationMeta = {
            page,
            limit,
            totalItems,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
          };
        }

        return {
          success: true,
          statusCode,
          data: extractedData,
          meta: {
            traceId,
            timestamp: new Date().toISOString(),
            durationMs,
            pagination: paginationMeta,
          },
        };
      }),
    );
  }
}
