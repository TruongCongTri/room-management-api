import {
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, lastValueFrom, EMPTY } from 'rxjs';
import { createHash } from 'crypto';
import { IdempotencyInterceptor, canonicalJson } from './idempotency.interceptor';
import { IdempotencyStorageService } from './idempotency-storage.service';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency.constants';

describe('IdempotencyInterceptor (Unit Test)', () => {
  let interceptor: IdempotencyInterceptor;
  let reflector: Reflector;
  let storageService: IdempotencyStorageService;

  const CLIENT_IP = '10.0.0.1';
  const anonymousScope = (key: string) => `-:ip:${CLIENT_IP}:${key}`;

  beforeEach(() => {
    reflector = new Reflector();
    storageService = new IdempotencyStorageService(null);
    interceptor = new IdempotencyInterceptor(reflector, storageService);
  });

  const createMockContext = (
    headers: Record<string, string>,
    body: any = {},
    extra: Record<string, unknown> = {},
  ): { context: ExecutionContext; responseHeaders: Record<string, string> } => {
    const responseHeaders: Record<string, string> = {};
    const context = {
      getType: () => 'http',
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/payments/charge',
          ip: CLIENT_IP,
          headers,
          body,
          ...extra,
        }),
        getResponse: () => ({
          statusCode: 201,
          status: jest.fn(),
          setHeader: (k: string, v: string) => {
            responseHeaders[k] = v;
          },
        }),
      }),
    } as unknown as ExecutionContext;

    return { context, responseHeaders };
  };

  const enable = (options: Record<string, unknown> = { required: true, ttlSeconds: 86400 }) =>
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);

  it('should throw BadRequestException if Idempotency-Key is missing on required endpoint', async () => {
    enable({ required: true });
    const { context } = createMockContext({});
    const callHandler: CallHandler = { handle: () => of({ success: true }) };

    const error = await interceptor.intercept(context, callHandler).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    // Mã nghiệp vụ riêng (không phải REQ_VALIDATION_ERROR chung) để client & i18n phân biệt được
    expect(error.getResponse()).toEqual(expect.objectContaining({ errorCode: 'REQ_MISSING_IDEMPOTENCY_KEY' }));
  });

  it('should reject malformed keys (too short / unsafe characters)', async () => {
    enable();
    const { context } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: 'bad key!' });
    await expect(interceptor.intercept(context, { handle: () => of({}) })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should execute handler and cache response on initial request', async () => {
    enable();
    const key = 'idem-unique-key-001';
    const { context } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { amount: 500 });

    const mockResponse = { transactionId: 'tx_123', status: 'SUCCESS' };
    const handlerFn = jest.fn().mockReturnValue(of(mockResponse));

    const result = await lastValueFrom(await interceptor.intercept(context, { handle: handlerFn }));

    expect(result).toEqual(mockResponse);
    expect(handlerFn).toHaveBeenCalledTimes(1);

    // Kết quả đã được lưu (đã await) TRƯỚC khi response được trả về
    const saved = await storageService.getRecord(anonymousScope(key));
    expect(saved?.status).toBe('COMPLETED');
    expect(saved?.statusCode).toBe(201);
    expect(saved?.response).toEqual(mockResponse);
  });

  it('should return cached response immediately without calling handler on second request', async () => {
    enable();
    const key = 'idem-unique-key-002';
    const { context, responseHeaders } = createMockContext(
      { [IDEMPOTENCY_KEY_HEADER]: key },
      { orderId: 'ord_999' },
    );

    const initialResult = { invoiceCode: 'VN-123456', room: '12A' };
    const handlerFn = jest.fn().mockReturnValue(of(initialResult));
    const callHandler: CallHandler = { handle: handlerFn };

    await lastValueFrom(await interceptor.intercept(context, callHandler));
    const cachedResult = await lastValueFrom(await interceptor.intercept(context, callHandler));

    expect(cachedResult).toEqual(initialResult);
    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(responseHeaders['X-Cache-Lookup']).toBe('HIT-IDEMPOTENT');
  });

  it('should complete the record for handlers that emit nothing (void)', async () => {
    enable();
    const key = 'idem-void-handler';
    const { context } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key });

    await lastValueFrom(await interceptor.intercept(context, { handle: () => EMPTY }), {
      defaultValue: undefined,
    });

    const saved = await storageService.getRecord(anonymousScope(key));
    expect(saved?.status).toBe('COMPLETED');
  });

  it('should throw ConflictException if identical key is sent while previous request is IN_PROGRESS', async () => {
    enable({ required: true, lockTimeoutSeconds: 60 });
    const key = 'idem-concurrent-key';
    const body = { amount: 1000 };
    const { context } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, body);

    const matchingFingerprint = createHash('sha256')
      .update(`POST:/payments/charge:${canonicalJson(body)}`)
      .digest('hex');
    await storageService.acquireLock(anonymousScope(key), matchingFingerprint, 60);

    await expect(interceptor.intercept(context, { handle: () => of({ ok: true }) })).rejects.toThrow(
      ConflictException,
    );
  });

  it('should reject reuse of the same key with a different body (422)', async () => {
    enable();
    const key = 'idem-reused-key';
    const callHandler: CallHandler = { handle: () => of({ ok: true }) };

    const { context: original } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { roomId: 'VN101' });
    await lastValueFrom(await interceptor.intercept(original, callHandler));

    const { context: tampered } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { roomId: 'VN999' });
    const error = await interceptor.intercept(tampered, callHandler).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toEqual(expect.objectContaining({ errorCode: 'REQ_IDEMPOTENCY_PAYLOAD_MISMATCH' }));
  });

  it('should treat bodies with different key order as the same payload', async () => {
    enable();
    const key = 'idem-key-order';
    const handlerFn = jest.fn().mockReturnValue(of({ ok: true }));

    const { context: first } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { a: 1, b: { c: 2, d: 3 } });
    await lastValueFrom(await interceptor.intercept(first, { handle: handlerFn }));

    const { context: second } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { b: { d: 3, c: 2 }, a: 1 });
    await lastValueFrom(await interceptor.intercept(second, { handle: handlerFn }));

    expect(handlerFn).toHaveBeenCalledTimes(1);
  });

  it('should isolate identical keys between different users (no cross-user response leak)', async () => {
    enable();
    const key = 'shared-key-value-1';
    const body = { amount: 10 };

    const { context: alice } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, body, {
      user: { id: 'usr_alice', tenantId: 't1' },
    });
    const { context: bob } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, body, {
      user: { id: 'usr_bob', tenantId: 't1' },
    });

    const aliceResult = await lastValueFrom(
      await interceptor.intercept(alice, { handle: () => of({ owner: 'alice' }) }),
    );
    const bobResult = await lastValueFrom(
      await interceptor.intercept(bob, { handle: () => of({ owner: 'bob' }) }),
    );

    expect(aliceResult).toEqual({ owner: 'alice' });
    expect(bobResult).toEqual({ owner: 'bob' });
  });

  it('should release lock upon handler failure to allow client retries', async () => {
    enable({ required: true, lockTimeoutSeconds: 60 });
    const key = 'idem-failed-key';
    const { context } = createMockContext({ [IDEMPOTENCY_KEY_HEADER]: key }, { amount: 200 });

    const failingHandler: CallHandler = {
      handle: () => throwError(() => new Error('Downstream Payment Gateway Down')),
    };

    await expect(
      lastValueFrom(await interceptor.intercept(context, failingHandler)),
    ).rejects.toThrow('Downstream Payment Gateway Down');

    expect(await storageService.getRecord(anonymousScope(key))).toBeNull();
  });
});

// npx jest src/core/security/idempotency/idempotency.interceptor.spec.ts
