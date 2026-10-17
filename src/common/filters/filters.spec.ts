import { ArgumentsHost, BadRequestException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { HttpExceptionFilter } from './http-exception.filter';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';
import { SystemErrorCode } from '../constants/error-codes.constant';

describe('Common Exception Filters (Enterprise RFC 7807)', () => {
  let contextService: RequestContextService;
  let logger: jest.Mocked<AppLoggerService>;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-TEST-777');

    logger = {
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<AppLoggerService>;

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      method: 'POST',
      url: '/api/v1/contracts',
      originalUrl: '/api/v1/contracts',
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe('HttpExceptionFilter', () => {
    let filter: HttpExceptionFilter;

    beforeEach(() => {
      filter = new HttpExceptionFilter(contextService, logger);
    });

    it('should format standard 401 UnauthorizedException into RFC 7807 envelope', () => {
      const exception = new UnauthorizedException('Token expired or invalid');

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          statusCode: 401,
          errorCode: SystemErrorCode.AUTH_UNAUTHORIZED,
          message: 'Token expired or invalid',
          traceId: 'TRACE-TEST-777',
          path: '/api/v1/contracts',
          // RFC 7807 Problem Details
          type: 'https://errors.room-management.local/AUTH_UNAUTHORIZED',
          title: 'Unauthorized',
          status: 401,
          instance: '/api/v1/contracts',
        }),
      );
      // 401 là nhiễu thường gặp (token hết hạn, bot) → mức debug
      expect(logger.debug).toHaveBeenCalled();
    });

    it('should localize the user-facing message by errorCode and keep the developer detail', () => {
      const i18n: any = { has: () => true, translate: jest.fn().mockReturnValue('Phiên đăng nhập đã hết hạn.') };
      const localizedFilter = new HttpExceptionFilter(contextService, logger, i18n);

      localizedFilter.catch(new UnauthorizedException({ errorCode: 'AUTH_TOKEN_EXPIRED', message: 'jwt expired' }), mockHost);

      expect(i18n.translate).toHaveBeenCalledWith('AUTH_TOKEN_EXPIRED', undefined);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'AUTH_TOKEN_EXPIRED',
          message: 'Phiên đăng nhập đã hết hạn.',
          detail: 'jwt expired',
        }),
      );
    });

    it('should emit an exception event instead of writing HTTP for WebSocket contexts', () => {
      const client = { emit: jest.fn() };
      const wsHost = {
        getType: () => 'ws',
        switchToWs: () => ({ getClient: () => client }),
      } as unknown as ArgumentsHost;

      filter.catch(new UnauthorizedException('bad token'), wsHost);

      expect(client.emit).toHaveBeenCalledWith('exception', expect.objectContaining({ errorCode: 'AUTH_UNAUTHORIZED' }));
      expect(mockResponse.json).not.toHaveBeenCalled();
    });

    it('should format 400 ValidationPipe array errors into structured details', () => {
      const validationErrors = ['email must be an email', 'password is too short'];
      const exception = new BadRequestException({ message: validationErrors });

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          statusCode: 400,
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: validationErrors,
        }),
      );
    });
  });

  describe('AllExceptionsFilter', () => {
    let filter: AllExceptionsFilter;

    beforeEach(() => {
      filter = new AllExceptionsFilter(contextService, logger);
    });

    it('should intercept PostgreSQL unique violation (code 23505) and translate to 409 Conflict', () => {
      const dbError: any = new Error('duplicate key value violates unique constraint');
      dbError.code = '23505';
      dbError.detail = 'Key (contract_reference)=(BK-12345) already exists.';
      const queryFailedError = new QueryFailedError('INSERT INTO...', [], dbError);

      filter.catch(queryFailedError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          statusCode: 409,
          errorCode: SystemErrorCode.DB_UNIQUE_CONSTRAINT_VIOLATION,
          message: 'A record with the same unique identifier already exists.',
          details: dbError.detail,
        }),
      );
      // Xung đột dữ liệu do client → cảnh báo, không phải lỗi hệ thống
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should never expose PostgreSQL detail (may contain PII) in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const dbError: any = Object.assign(new Error('duplicate key'), {
        code: '23505',
        detail: 'Key (email)=(vip@rental.vn) already exists.',
      });

      filter.catch(new QueryFailedError('INSERT', [], dbError), mockHost);

      const body = mockResponse.json.mock.calls[0][0];
      expect(body.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('vip@rental.vn');
      process.env.NODE_ENV = originalEnv;
    });

    it('should handle unhandled runtime errors with 500 and conceal stack trace in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const unhandledError = new Error('Unexpected Null Pointer Dereference');

      filter.catch(unhandledError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          statusCode: 500,
          errorCode: SystemErrorCode.SYS_INTERNAL_ERROR,
          // Production: không lộ message nội bộ (đường dẫn file, IP DB, tên cột...)
          message: 'An unexpected internal server error occurred.',
          stack: undefined, // Phải che giấu stack trên production
        }),
      );
      expect(JSON.stringify(mockResponse.json.mock.calls[0][0])).not.toContain('Null Pointer');
      expect(logger.error).toHaveBeenCalled();

      process.env.NODE_ENV = originalEnv;
    });
  });
});

// npx jest src/common/filters/filters.spec.ts