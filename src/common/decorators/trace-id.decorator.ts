/**
 * Trace ID ĐÃ PHÂN GIẢI của request (trùng với header phản hồi x-correlation-id, log và distributed trace),
 * kể cả khi client không gửi header nào (id được sinh mới) - không cần inject RequestContextService.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { SYSTEM_HEADERS } from '../constants/headers.constant';
import { RequestContextService, UNTRACKED_TRACE_ID } from '../../core/context/request-context.service';
import { getResolvedTraceId } from '../../core/context/trace-id.util';

export const TraceId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest();
  const headers = request?.headers ?? {};
  return (
    getResolvedTraceId(request) ||
    RequestContextService.current()?.traceId ||
    headers[SYSTEM_HEADERS.CORRELATION_ID] ||
    headers[SYSTEM_HEADERS.TRACE_ID] ||
    headers[SYSTEM_HEADERS.REQUEST_ID] ||
    UNTRACKED_TRACE_ID
  );
});
