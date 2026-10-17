/**
 * Tạo test suite kiểm tra:
 *  TransformInterceptor: Bọc dữ liệu thành công vào Envelope chuẩn và xử lý phân trang.   
 *  TimeoutInterceptor: Ném RequestTimeoutException khi tiến trình xử lý vượt quá thời hạn.   
 *  AuditInterceptor: Tự động ghi vết log thành công và lỗi cho các phương thức mutating (POST, DELETE), bỏ qua GET
 * 
 * */ 

import { ExecutionContext, CallHandler, RequestTimeoutException, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, delay, lastValueFrom } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor';
import { TimeoutInterceptor } from './timeout.interceptor';
import { AuditInterceptor } from './audit.interceptor';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppLoggerService } from '../../core/logger/app-logger.service';

describe('Common Interceptors (Enterprise Suite)', () => {
  let contextService: RequestContextService;
  let logger: jest.Mocked<AppLoggerService>;

  beforeEach(() => {
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-INT-123');
    jest.spyOn(contextService, 'getDurationMs').mockReturnValue(45);
    jest.spyOn(contextService, 'getUserId').mockReturnValue('usr_operator_1');
    jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_vn');
    jest.spyOn(contextService, 'getClientIp').mockReturnValue('127.0.0.1');

    logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<AppLoggerService>;
  });

  const mockHandler = () => {};
  class MockController {}

  const createMockContext = (method = 'GET', url = '/api/v1/rooms'): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => mockHandler,
      getClass: () => MockController,
      switchToHttp: () => ({
        getRequest: () => ({ method, url }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    }) as unknown as ExecutionContext;

  describe('TransformInterceptor', () => {
    let interceptor: TransformInterceptor<any>;

    beforeEach(() => {
      interceptor = new TransformInterceptor(contextService);
    });

    it('should wrap standard payload into API Envelope format', async () => {
      const context = createMockContext();
      const callHandler: CallHandler = { handle: () => of({ contractId: 'BK-100' }) };

      const stream$ = interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual({
        success: true,
        statusCode: 200,
        data: { contractId: 'BK-100' },
        meta: {
          traceId: 'TRACE-INT-123',
          timestamp: expect.any(String),
          durationMs: 45,
          pagination: undefined,
        },
      });
    });

    it('should extract pagination metadata when response matches paginated structure', async () => {
      const context = createMockContext();
      const paginatedData = {
        items: [{ id: 1 }, { id: 2 }],
        total: 50,
        page: 1,
        limit: 10,
      };
      const callHandler: CallHandler = { handle: () => of(paginatedData) };

      const stream$ = interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.meta.pagination).toEqual({
        page: 1,
        limit: 10,
        totalItems: 50,
        totalPages: 5,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });
  });

  describe('TimeoutInterceptor', () => {
    let interceptor: TimeoutInterceptor;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      interceptor = new TimeoutInterceptor(reflector, contextService);
      (interceptor as any).defaultTimeoutMs = 50; // Giới hạn 50ms cho test
    });

    it('should throw RequestTimeoutException when operation exceeds timeout threshold', async () => {
      const context = createMockContext();
      // Giả lập tác vụ mất 150ms (vượt quá 50ms)
      const callHandler: CallHandler = {
        handle: () => of('TOO_SLOW').pipe(delay(150)),
      };

      const stream$ = interceptor.intercept(context, callHandler);

      await expect(lastValueFrom(stream$)).rejects.toThrow(RequestTimeoutException);
    });
  });

  describe('AuditInterceptor', () => {
    let interceptor: AuditInterceptor;

    beforeEach(() => {
      interceptor = new AuditInterceptor(contextService, logger);
    });

    it('should ignore safe read operations like GET', async () => {
      const context = createMockContext('GET', '/api/v1/contracts');
      const callHandler: CallHandler = { handle: () => of({ ok: true }) };

      const stream$ = interceptor.intercept(context, callHandler);
      await lastValueFrom(stream$);

      expect(logger.log).not.toHaveBeenCalled();
    });

    it('should record audit log on successful mutating method (POST)', async () => {
      const context = createMockContext('POST', '/api/v1/contracts');
      const callHandler: CallHandler = { handle: () => of({ success: true }) };

      const stream$ = interceptor.intercept(context, callHandler);
      await lastValueFrom(stream$);

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'AUDIT_MUTATION_SUCCESS',
          actorId: 'usr_operator_1',
          tenantId: 'tenant_vn',
          method: 'POST',
          endpoint: '/api/v1/contracts',
        }),
        AuditInterceptor.name,
      );
    });

    it('should record warning audit log on failed mutating method (DELETE)', async () => {
      const context = createMockContext('DELETE', '/api/v1/contracts/123');
      const callHandler: CallHandler = {
        handle: () => throwError(() => new Error('Record locked')),
      };

      const stream$ = interceptor.intercept(context, callHandler);

      try {
        await lastValueFrom(stream$);
      } catch {
        // Expected
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'AUDIT_MUTATION_FAILED',
          method: 'DELETE',
          errorMessage: 'Record locked',
        }),
        AuditInterceptor.name,
      );
    });
  });
  describe('Envelope opt-out & raw payloads', () => {
    it('should not wrap responses of routes marked with @SkipEnvelope()', async () => {
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const interceptor = new TransformInterceptor(contextService, reflector);

      const result = await lastValueFrom(
        interceptor.intercept(createMockContext(), { handle: () => of({ status: 'ok' }) }),
      );
      expect(result).toEqual({ status: 'ok' });
    });

    it('should pass StreamableFile / Buffer through untouched (file downloads)', async () => {
      const interceptor = new TransformInterceptor(contextService);
      const file = new StreamableFile(Buffer.from('%PDF-1.7'));

      const result = await lastValueFrom(interceptor.intercept(createMockContext(), { handle: () => of(file) }));
      expect(result).toBe(file);
    });
  });

  describe('AuditInterceptor persistence', () => {
    it('should persist an immutable audit record with route, status and duration', async () => {
      const auditWriter = { record: jest.fn().mockResolvedValue(undefined) } as any;
      const interceptor = new AuditInterceptor(contextService, logger, new Reflector(), auditWriter);
      const context = {
        getType: () => 'http',
        getHandler: () => mockHandler,
        getClass: () => MockController,
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'PATCH',
            originalUrl: '/api/v1/contracts/bk_9?notify=true',
            baseUrl: '',
            route: { path: '/api/v1/contracts/:id' },
            params: { id: 'bk_9' },
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));

      expect(auditWriter.record).toHaveBeenCalledWith({
        action: 'UPDATE',
        resource: '/api/v1/contracts/:id',
        resourceId: 'bk_9',
        metadata: expect.objectContaining({ method: 'PATCH', path: '/api/v1/contracts/bk_9', statusCode: 200, outcome: 'SUCCESS' }),
      });
    });

    it('should skip routes marked with @SkipAudit()', async () => {
      const auditWriter = { record: jest.fn() } as any;
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const interceptor = new AuditInterceptor(contextService, logger, reflector, auditWriter);

      await lastValueFrom(interceptor.intercept(createMockContext('POST'), { handle: () => of({}) }));

      expect(auditWriter.record).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
    });
  });
});

// npx jest src/common/interceptors/interceptors.spec.ts