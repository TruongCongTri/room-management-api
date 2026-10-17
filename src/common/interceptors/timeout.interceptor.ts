/**
 * Kiểm soát thời gian chạy tối đa của request (mặc định HTTP_REQUEST_TIMEOUT_MS, ghi đè bằng @SetRequestTimeout):
 * chặn request treo giữ kết nối vô thời hạn, trả 408 kèm traceId để đối soát.
 * */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  RequestTimeoutException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { REQUEST_TIMEOUT_KEY } from './timeout.decorator';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { SystemErrorCode } from '../constants/error-codes.constant';

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private defaultTimeoutMs: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly contextService: RequestContextService,
    @Optional() config?: AppConfigService,
  ) {
    this.defaultTimeoutMs = config?.http.requestTimeoutMs ?? 15000; // Mặc định 15 giây
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const targets = [context.getHandler(), context.getClass()].filter(Boolean);
    const routeTimeout =
      targets.length > 0 ? this.reflector.getAllAndOverride<number>(REQUEST_TIMEOUT_KEY, targets) : undefined;

    const timeoutLimit = routeTimeout || this.defaultTimeoutMs;

    return next.handle().pipe(
      timeout(timeoutLimit),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          const traceId = this.contextService.getTraceId();
          return throwError(
            () =>
              new RequestTimeoutException({
                errorCode: SystemErrorCode.REQ_TIMEOUT,
                message: `Request timed out after ${timeoutLimit}ms. TraceId: ${traceId}`,
              }),
          );
        }
        return throwError(() => err);
      }),
    );
  }
}
