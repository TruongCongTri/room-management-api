/**
 * Chốt chặn cuối cùng (Catch-All Safety Net) bắt mọi lỗi không mong muốn (Uncaught Exceptions, Lỗi cú pháp/Logic,
 * Lỗi PostgreSQL Database, lỗi body-parser của Express):
 *  - Phân loại mã lỗi PostgreSQL → 409 / 400 / 503 an toàn, KHÔNG để lộ schema hay dữ liệu (detail chỉ có ngoài production).
 *  - Lỗi không xác định trên production → thông điệp chung, không lộ message nội bộ (đường dẫn, IP DB, tên cột).
 *
 * */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { QueryFailedError, TypeORMError } from 'typeorm';
import { SystemErrorCode } from '../constants/error-codes.constant';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { ErrorDescriptor, writeErrorResponse } from './exception-response.writer';
import { mapStatusToErrorCode } from './http-exception.filter';

const GENERIC_INTERNAL_MESSAGE = 'An unexpected internal server error occurred.';

/** Mã lỗi PostgreSQL (SQLSTATE) → phản hồi an toàn cho client */
const PG_ERRORS: Record<string, { status: number; errorCode: SystemErrorCode; message: string }> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    errorCode: SystemErrorCode.DB_UNIQUE_CONSTRAINT_VIOLATION,
    message: 'A record with the same unique identifier already exists.',
  },
  '23503': {
    status: HttpStatus.BAD_REQUEST,
    errorCode: SystemErrorCode.DB_FOREIGN_KEY_VIOLATION,
    message: 'Referenced entity does not exist.',
  },
  '23502': {
    status: HttpStatus.BAD_REQUEST,
    errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
    message: 'A required field is missing.',
  },
  '23514': {
    status: HttpStatus.BAD_REQUEST,
    errorCode: SystemErrorCode.DB_CHECK_CONSTRAINT_VIOLATION,
    message: 'The submitted data violates a business constraint.',
  },
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
    message: 'A field has an invalid format.',
  },
  '40P01': {
    status: HttpStatus.CONFLICT,
    errorCode: SystemErrorCode.RES_CONCURRENCY_CONFLICT,
    message: 'Transaction deadlock encountered. Please retry the operation.',
  },
  '40001': {
    status: HttpStatus.CONFLICT,
    errorCode: SystemErrorCode.RES_CONCURRENCY_CONFLICT,
    message: 'Concurrent update detected. Please retry the operation.',
  },
  '55P03': {
    status: HttpStatus.CONFLICT,
    errorCode: SystemErrorCode.RES_LOCKED,
    message: 'The resource is locked by another transaction.',
  },
  '57014': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: SystemErrorCode.SYS_DATABASE_ERROR,
    message: 'The database query took too long and was cancelled.',
  },
  '42501': {
    status: HttpStatus.FORBIDDEN,
    errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
    message: 'The operation is not permitted on this data.',
  },
  '53300': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: SystemErrorCode.SYS_SERVICE_UNAVAILABLE,
    message: 'The database is temporarily unavailable.',
  },
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly contextService: RequestContextService,
    private readonly logger: AppLoggerService,
    @Optional() private readonly i18n?: I18nService,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const isProduction = this.config?.isProduction ?? process.env.NODE_ENV === 'production';
    writeErrorResponse(host, this.describe(exception, isProduction), {
      contextService: this.contextService,
      logger: this.logger,
      i18n: this.i18n,
      isProduction,
      context: AllExceptionsFilter.name,
    });
  }

  private describe(exception: unknown, isProduction: boolean): ErrorDescriptor {
    // 1. HttpException lọt tới đây (HttpExceptionFilter thường xử lý trước)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse() as any;
      return {
        status,
        errorCode: res?.errorCode || mapStatusToErrorCode(status),
        message: typeof res === 'string' ? res : typeof res?.message === 'string' ? res.message : exception.message,
        details: res?.details,
        exception,
      };
    }

    // 2. Lỗi từ PostgreSQL qua TypeORM (mã SQLSTATE nằm trong driverError/code)
    if (exception instanceof QueryFailedError) {
      const dbError = exception as QueryFailedError & { code?: string; detail?: string; driverError?: any };
      const code = dbError.code ?? dbError.driverError?.code;
      const mapped = code ? PG_ERRORS[code] : undefined;
      return {
        status: mapped?.status ?? HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: mapped?.errorCode ?? SystemErrorCode.SYS_DATABASE_ERROR,
        message: mapped?.message ?? 'Database query execution failed.',
        // detail của PostgreSQL có thể chứa dữ liệu (vd: Key (email)=(a@b.com)) → chỉ trả về ngoài production
        details: !isProduction ? (dbError.detail ?? dbError.driverError?.detail) : undefined,
        exception,
      };
    }

    // 3. Các lỗi TypeORM chung khác (OptimisticLockVersionMismatchError, EntityNotFoundError...)
    if (exception instanceof TypeORMError) {
      if (exception.name === 'OptimisticLockVersionMismatchError') {
        return {
          status: HttpStatus.CONFLICT,
          errorCode: SystemErrorCode.RES_CONCURRENCY_CONFLICT,
          message: 'The resource was updated concurrently by another transaction. Please reload.',
          exception,
        };
      }
      if (exception.name === 'EntityNotFoundError') {
        return {
          status: HttpStatus.NOT_FOUND,
          errorCode: SystemErrorCode.RES_NOT_FOUND,
          message: 'The requested resource was not found.',
          exception,
        };
      }
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: SystemErrorCode.SYS_DATABASE_ERROR,
        message: 'Data persistence layer failure.',
        exception,
      };
    }

    // 4. Lỗi kiểu http-errors từ Express middleware (body-parser: JSON hỏng, payload quá lớn)
    const httpLike = exception as { status?: number; statusCode?: number; type?: string; expose?: boolean };
    const httpLikeStatus = httpLike?.status ?? httpLike?.statusCode;
    if (typeof httpLikeStatus === 'number' && httpLikeStatus >= 400 && httpLikeStatus < 500) {
      return {
        status: httpLikeStatus,
        errorCode:
          httpLike.type === 'entity.parse.failed'
            ? SystemErrorCode.REQ_MALFORMED_PAYLOAD
            : mapStatusToErrorCode(httpLikeStatus),
        message: httpLike.expose && exception instanceof Error ? exception.message : 'The request could not be processed.',
        exception,
      };
    }

    // 5. Lỗi thuần Javascript / không xác định
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: SystemErrorCode.SYS_INTERNAL_ERROR,
      message: !isProduction && exception instanceof Error ? exception.message : GENERIC_INTERNAL_MESSAGE,
      exception,
    };
  }
}
