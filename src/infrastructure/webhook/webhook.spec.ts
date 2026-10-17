/**
 * Tạo test suite kiểm tra:HMAC Signer & Verifier: Tạo chữ ký chính xác và xác thực thành công.   Replay Attack Defense: Từ chối chữ ký khi timestamp bị lệch quá ngưỡng 300 giây.WebhookSignatureGuard: Ném UnauthorizedException khi thiếu header hoặc chữ ký không khớp.WebhookDispatcherService: Tạo đúng header chữ ký HMAC SHA-256 và phát request thành công qua AppHttpClient.   
 * 
 * 
*/

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WebhookSigner } from './security/webhook-signer';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppHttpClient } from '../http/client/app-http.client';
import { WEBHOOK_CONSTANTS } from './constants/webhook.constants';

describe('WebhookModule (Enterprise Ingress & Egress Suite)', () => {
  const testSecret = 'whsec_test_secret_key_123456';
  const samplePayload = JSON.stringify({ contractId: 'BK-100', status: 'CONFIRMED' });

  describe('WebhookSigner', () => {
    it('should generate valid HMAC SHA-256 signature and verify successfully', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookSigner.sign(samplePayload, testSecret, timestamp);

      expect(signature.startsWith('sha256=')).toBe(true);

      const isValid = WebhookSigner.verify(
        samplePayload,
        testSecret,
        signature,
        timestamp,
        300,
      );

      expect(isValid).toBe(true);
    });

    it('should reject when signature is altered or tampered with', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookSigner.sign(samplePayload, testSecret, timestamp);
      const tamperedSignature = signature.replace('a', 'b');

      const isValid = WebhookSigner.verify(
        samplePayload,
        testSecret,
        tamperedSignature,
        timestamp,
        300,
      );

      expect(isValid).toBe(false);
    });

    it('should reject replay attacks when timestamp exceeds tolerance window', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 phút trước (> 5 phút)
      const signature = WebhookSigner.sign(samplePayload, testSecret, oldTimestamp);

      const isValid = WebhookSigner.verify(
        samplePayload,
        testSecret,
        signature,
        oldTimestamp,
        300,
      );

      expect(isValid).toBe(false);
    });
  });

  describe('WebhookSignatureGuard', () => {
    let guard: WebhookSignatureGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new WebhookSignatureGuard(reflector);
    });

    const createMockContext = (headers: Record<string, string>, body: any): ExecutionContext =>
      ({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({ headers, body }),
        }),
      }) as unknown as ExecutionContext;

    it('should throw UnauthorizedException when signature or timestamp headers are missing', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({
        secret: testSecret,
      });

      const context = createMockContext({}, { test: 1 });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should allow valid incoming webhook request to pass through', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = { orderId: 'ORD-999' };
      const rawBodyStr = JSON.stringify(body);
      const signature = WebhookSigner.sign(rawBodyStr, testSecret, timestamp);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({
        secret: testSecret,
      });

      const context = createMockContext(
        {
          [WEBHOOK_CONSTANTS.DEFAULT_SIGNATURE_HEADER]: signature,
          [WEBHOOK_CONSTANTS.DEFAULT_TIMESTAMP_HEADER]: String(timestamp),
        },
        body,
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should verify against the RAW body bytes and resolve secrets asynchronously (multi-partner)', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      // Thứ tự khóa / khoảng trắng của đối tác khác JSON.stringify(body) → phải ký trên raw body
      const rawBody = Buffer.from('{ "orderId":"ORD-1",  "amount": 100 }');
      const signature = WebhookSigner.sign(rawBody.toString('utf8'), testSecret, timestamp);
      const secretResolver = jest.fn().mockResolvedValue(testSecret);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ secret: secretResolver });

      const request = {
        headers: {
          [WEBHOOK_CONSTANTS.DEFAULT_SIGNATURE_HEADER]: signature,
          [WEBHOOK_CONSTANTS.DEFAULT_TIMESTAMP_HEADER]: String(timestamp),
        },
        body: { orderId: 'ORD-1', amount: 100 },
        rawBody,
      };
      const context = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(secretResolver).toHaveBeenCalledWith(request);
    });
  });

  describe('WebhookDispatcherService', () => {
    let dispatcher: WebhookDispatcherService;
    let mockHttpClient: jest.Mocked<AppHttpClient>;
    let contextService: RequestContextService;

    beforeEach(() => {
      mockHttpClient = {
        post: jest.fn().mockResolvedValue({ success: true }),
      } as unknown as jest.Mocked<AppHttpClient>;

      contextService = new RequestContextService();
      jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-WH-999');
      jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_asia');

      dispatcher = new WebhookDispatcherService(mockHttpClient, contextService);
    });

    it('should sign payload and dispatch post request with security headers', async () => {
      const result = await dispatcher.dispatch(
        {
          event: 'contract.activated',
          data: { contractCode: 'BK-555' },
        },
        {
          url: 'https://partner.api.com/webhook',
          secret: testSecret,
        },
      );

      expect(result.success).toBe(true);
      const [url, body, options] = mockHttpClient.post.mock.calls[0] as [string, string, any];
      expect(url).toBe('https://partner.api.com/webhook');
      // Thân request chính là chuỗi đã ký → bên nhận tính lại chữ ký khớp từng byte
      expect(JSON.parse(body)).toEqual(
        expect.objectContaining({ event: 'contract.activated', traceId: 'TRACE-WH-999', tenantId: 'tenant_asia' }),
      );
      const timestamp = Number(options.headers[WEBHOOK_CONSTANTS.DEFAULT_TIMESTAMP_HEADER]);
      expect(options.headers[WEBHOOK_CONSTANTS.DEFAULT_SIGNATURE_HEADER]).toBe(
        WebhookSigner.sign(body, testSecret, timestamp),
      );
      expect(options.headers[WEBHOOK_CONSTANTS.DEFAULT_ID_HEADER]).toBe(result.webhookId);
    });

    it('should enqueue reliable deliveries with jobId = webhook id when a queue is available', async () => {
      const queue: any = { add: jest.fn().mockResolvedValue({ id: 'wh_1' }) };
      const reliable = new WebhookDispatcherService(mockHttpClient, contextService, undefined, queue);

      const result = await reliable.dispatchReliable(
        { id: 'wh_1', event: 'invoice.generated', data: { invoiceNo: 'AB12CD' } },
        { url: 'https://partner.api.com/webhook', secret: testSecret },
      );

      expect(result).toEqual(expect.objectContaining({ queued: true, webhookId: 'wh_1' }));
      expect(queue.add).toHaveBeenCalledWith('invoice.generated', expect.any(Object), expect.objectContaining({ jobId: 'wh_1' }));
      expect(mockHttpClient.post).not.toHaveBeenCalled();
    });
  });
});

// npx jest src/infrastructure/webhook/webhook.spec.ts