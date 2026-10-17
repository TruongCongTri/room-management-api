import { AppLoggerService } from './app-logger.service';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextService } from '../context/request-context.service';

describe('AppLoggerService (Unit Test)', () => {
  let appLogger: AppLoggerService;
  let mockPinoLogger: jest.Mocked<PinoLogger>;
  let contextService: RequestContextService;

  beforeEach(() => {
    mockPinoLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    } as unknown as jest.Mocked<PinoLogger>;

    contextService = new RequestContextService();
    appLogger = new AppLoggerService(mockPinoLogger, contextService);
  });

  it('should enrich string log message with context traceId, userId, and tenantId', () => {
    // Giả lập ngữ cảnh đang chạy của request
    contextService.run(
      {
        traceId: 'TRACE-ORDER-888',
        clientIp: '192.168.1.50',
        startTime: Date.now(),
        user: {
          id: 'usr_buyer_99',
          email: 'buyer@rental.vn',
          tenantId: 'tenant_vietnam',
          departmentId: 'dep_SALES',
          roles: ['CUSTOMER'],
          rules: [],
        },
        metadata: new Map(),
      },
      () => {
        appLogger.log('Room contract process started', 'Contractservice');

        expect(mockPinoLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            context: 'Contractservice',
            traceId: 'TRACE-ORDER-888',
            userId: 'usr_buyer_99',
            tenantId: 'tenant_vietnam',
            departmentId: 'dep_SALES',
            clientIp: '192.168.1.50',
            isBackgroundJob: false,
          }),
          'Room contract process started',
        );
      },
    );
  });

  it('should enrich object payload with context and stack trace when logging error', () => {
    contextService.run(
      {
        traceId: 'TRACE-ERROR-111',
        clientIp: '127.0.0.1',
        startTime: Date.now(),
        metadata: new Map(),
      },
      () => {
        const errorStack = 'Error: Partner Timeout at ZaloZnsAdapter.ts:42';
        appLogger.error('Failed to issue invoice', errorStack, 'AviationAdapter');

        expect(mockPinoLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            context: 'AviationAdapter',
            traceId: 'TRACE-ERROR-111',
            stack: errorStack,
          }),
          'Failed to issue invoice',
        );
      },
    );
  });

  it('should serialize Error instances (message, stack, cause) instead of losing them', () => {
    const cause = new Error('socket hang up');
    const err = new Error('Payment gateway failed', { cause });

    appLogger.error(err, undefined, 'PaymentService');

    const [payload, msg] = (mockPinoLogger.error as jest.Mock).mock.calls[0];
    expect(msg).toBe('Payment gateway failed');
    expect(payload.err.message).toBe('Payment gateway failed');
    expect(payload.err.stack).toContain('Payment gateway failed');
    expect(payload.err.cause.message).toBe('socket hang up');
  });

  it('should not allow an object payload to overwrite context fields like traceId', () => {
    contextService.run(
      { traceId: 'TRACE-REAL', clientIp: '1.1.1.1', startTime: Date.now(), metadata: new Map() },
      () => {
        appLogger.log({ traceId: 'FORGED', event: 'x' }, 'Spoof');
      },
    );
    expect(mockPinoLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'TRACE-REAL', event: 'x' }),
    );
  });

  it('should log safely with default fallback context when executed outside HTTP request', () => {
    appLogger.warn('System routine background sweep');

    expect(mockPinoLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'Application',
        traceId: 'TRACE-UNTRACKED',
        userId: undefined,
        tenantId: undefined,
      }),
      'System routine background sweep',
    );
  });
});

// npx jest src/core/logger/app-logger.service.spec.ts