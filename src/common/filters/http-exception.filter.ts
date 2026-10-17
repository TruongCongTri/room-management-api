/**
 * Chuyên xử lý các ngoại lệ HTTP chủ động được ném từ ứng dụng (BadRequestException, UnauthorizedException,
 * ForbiddenException, NotFoundException, ThrottlerException...):
 *
 * */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { SystemErrorCode } from '../constants/error-codes.constant';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { writeErrorResponse } from './exception-response.writer';

const STATUS_ERROR_CODES: Partial<Record<number, SystemErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: SystemErrorCode.REQ_VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: SystemErrorCode.AUTH_UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
  [HttpStatus.NOT_FOUND]: SystemErrorCode.RES_NOT_FOUND,
  [HttpStatus.REQUEST_TIMEOUT]: SystemErrorCode.REQ_TIMEOUT,
  [HttpStatus.CONFLICT]: SystemErrorCode.RES_CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: SystemErrorCode.REQ_PAYLOAD_TOO_LARGE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: SystemErrorCode.REQ_IDEMPOTENCY_PAYLOAD_MISMATCH,
  [HttpStatus.TOO_MANY_REQUESTS]: SystemErrorCode.SEC_RATE_LIMIT_EXCEEDED,
  [HttpStatus.BAD_GATEWAY]: SystemErrorCode.EXT_PARTNER_TIMEOUT,
  [HttpStatus.SERVICE_UNAVAILABLE]: SystemErrorCode.SYS_SERVICE_UNAVAILABLE,
  [HttpStatus.GATEWAY_TIMEOUT]: SystemErrorCode.EXT_PARTNER_TIMEOUT,
};

export function mapStatusToErrorCode(status: number): SystemErrorCode {
  return STATUS_ERROR_CODES[status] ?? (status >= 500 ? SystemErrorCode.SYS_INTERNAL_ERROR : SystemErrorCode.REQ_VALIDATION_ERROR);
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly contextService: RequestContextService,
    private readonly logger: AppLoggerService,
    @Optional() private readonly i18n?: I18nService,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let message = exception.message;
    let errorCode: string = mapStatusToErrorCode(status);
    let details: any = undefined;

    // Phân tích chi tiết từ đối tượng phản hồi của NestJS
    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const respObj = exceptionResponse as Record<string, any>;
      errorCode = respObj.errorCode || errorCode;
      details = respObj.details || (Array.isArray(respObj.message) ? respObj.message : undefined);

      // ValidationPipe trả về mảng thông báo lỗi → chuẩn hóa message thành thông điệp chung
      message = Array.isArray(respObj.message)
        ? 'Validation failed for the submitted payload.'
        : typeof respObj.message === 'string'
          ? respObj.message
          : message;
    } else if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    }

    const retryAfter = status === HttpStatus.TOO_MANY_REQUESTS ? /after (\d+)s/i.exec(message)?.[1] : undefined;

    writeErrorResponse(
      host,
      { status, errorCode, message, details, exception, messageParams: retryAfter ? { retryAfter } : undefined },
      {
        contextService: this.contextService,
        logger: this.logger,
        i18n: this.i18n,
        isProduction: this.config?.isProduction ?? process.env.NODE_ENV === 'production',
        context: HttpExceptionFilter.name,
      },
    );
  }
}
