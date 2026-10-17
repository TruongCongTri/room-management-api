/**
 * Bộ dựng & ghi phản hồi lỗi dùng chung cho HttpExceptionFilter và AllExceptionsFilter:
 *  - RFC 7807 + envelope hệ thống, bản địa hóa thông điệp theo errorCode.
 *  - Ẩn stack trace (và chi tiết nội bộ) trên production.
 *  - Mức log theo mức độ: 5xx → error, 401/404 → debug (nhiễu từ bot), 4xx khác → warn.
 *  - Context không phải HTTP (WebSocket) → phát sự kiện 'exception' tới client thay vì res.json().
 */
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { ApiErrorResponse } from './error-response.interface';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import type { I18nService } from '../../core/i18n/i18n.service';

export const PROBLEM_JSON = 'application/problem+json';
const PROBLEM_TYPE_BASE = 'https://errors.room-management.local/';

export interface ErrorDescriptor {
  status: number;
  errorCode: string;
  message: string;
  details?: ApiErrorResponse['details'];
  exception: unknown;
  /** Tham số chèn vào bản dịch (vd: retryAfter) */
  messageParams?: Record<string, string | number>;
}

export interface ErrorWriterDeps {
  contextService: RequestContextService;
  logger: AppLoggerService;
  i18n?: I18nService;
  isProduction: boolean;
  context: string;
}

export function writeErrorResponse(host: ArgumentsHost, error: ErrorDescriptor, deps: ErrorWriterDeps): void {
  const type = typeof host.getType === 'function' ? host.getType() : 'http';
  const traceId = deps.contextService.getTraceId();

  if (type === 'ws') {
    const client = host.switchToWs().getClient();
    client?.emit?.('exception', { status: 'error', errorCode: error.errorCode, message: error.message, traceId });
    logError(error, deps, `[WS] ${error.errorCode}: ${error.message}`);
    return;
  }
  if (type !== 'http') {
    throw error.exception;
  }

  const ctx = host.switchToHttp();
  const response = ctx.getResponse();
  const request = ctx.getRequest();
  const path: string = request?.originalUrl || request?.url || '';

  const localized =
    deps.i18n && deps.i18n.has(error.errorCode) ? deps.i18n.translate(error.errorCode, error.messageParams) : undefined;
  const exceptionStack = error.exception instanceof Error ? error.exception.stack : undefined;

  const payload: ApiErrorResponse = {
    type: `${PROBLEM_TYPE_BASE}${error.errorCode}`,
    title: STATUS_CODES[error.status] ?? 'Error',
    status: error.status,
    detail: localized && localized !== error.message ? error.message : undefined,
    instance: path,
    success: false,
    statusCode: error.status,
    errorCode: error.errorCode,
    message: localized ?? error.message,
    details: error.details,
    timestamp: new Date().toISOString(),
    path,
    traceId,
    stack: !deps.isProduction && error.status >= 500 ? exceptionStack : undefined,
  };

  logError(error, deps, `[HTTP ${error.status}] ${request?.method} ${path} - ${error.errorCode}: ${error.message}`);

  if (response.headersSent) return;
  response.setHeader?.('Content-Type', PROBLEM_JSON);
  response.status(error.status).json(payload);
}

function logError(error: ErrorDescriptor, deps: ErrorWriterDeps, message: string): void {
  if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    deps.logger.error(message, error.exception instanceof Error ? error.exception.stack : undefined, deps.context);
  } else if (error.status === HttpStatus.UNAUTHORIZED || error.status === HttpStatus.NOT_FOUND) {
    deps.logger.debug(message, deps.context);
  } else {
    deps.logger.warn(message, deps.context);
  }
}
