/**
 * Kiểm thử đơn vị toàn diện: src/infrastructure/queue/queue.spec.ts
Tạo test suite kiểm tra:

Producer Envelope: Tự động chèn traceId và tenantId vào job data khi gọi addJob[cite: 1].

Worker Context Restoration: Tự động gọi runWithContext để phục hồi ngữ cảnh cho code nghiệp vụ bên trong[cite: 1].

DLQ Routing Logic: Chuyển sang DLQ khi attemptsMade >= attempts[cite: 1].
 * 
 * */ 

import { BaseQueueProducer } from './producers/base-queue.producer';
import { BaseQueueWorker } from './consumers/base-queue.worker';
import { DlqMonitorService } from './consumers/dlq-monitor.service';
import { RequestContextService } from '../../core/context/request-context.service';
import { Queue, Job } from 'bullmq';

class TestQueueProducer extends BaseQueueProducer<{ email: string }> {
  constructor(queue: Queue, contextService: RequestContextService) {
    super(queue, contextService);
  }
}

class TestQueueWorker extends BaseQueueWorker<{ email: string }> {
  public executedPayload: any = null;
  public capturedTraceId: string | undefined = undefined;

  async handleJob(payload: { email: string }): Promise<any> {
    this.executedPayload = payload;
    this.capturedTraceId = this.contextService.getTraceId();
    return { success: true };
  }
}

describe('QueueModule (Enterprise BullMQ & DLQ Suite)', () => {
  let contextService: RequestContextService;
  let mockQueue: jest.Mocked<Queue>;

  beforeEach(() => {
    contextService = new RequestContextService();
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_101' }),
    } as unknown as jest.Mocked<Queue>;
  });

  describe('BaseQueueProducer', () => {
    it('should automatically wrap job data with active trace and tenant metadata', async () => {
      jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-QUEUE-555');
      jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_saigon');
      jest.spyOn(contextService, 'getUserId').mockReturnValue('usr_sender_1');

      const producer = new TestQueueProducer(mockQueue, contextService);
      const jobId = await producer.addJob(
        'sendWelcomeEmail',
        { email: 'client@rental.vn' },
        { jobId: 'welcome:usr_1' },
      );

      expect(jobId).toBe('job_101');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'sendWelcomeEmail',
        expect.objectContaining({
          metadata: {
            traceId: 'TRACE-QUEUE-555',
            tenantId: 'tenant_saigon',
            actorId: 'usr_sender_1',
            enqueuedAt: expect.any(String),
          },
          payload: { email: 'client@rental.vn' },
        }),
        // Retry/backoff mặc định đến từ BullModule.defaultJobOptions (cấu hình), producer chỉ chuyển tiếp options
        { jobId: 'welcome:usr_1' },
      );
    });
  });

  describe('DlqMonitorService', () => {
    const buildService = (dlq: any) => {
      const moduleRef: any = { get: jest.fn().mockReturnValue(dlq) };
      return new DlqMonitorService(moduleRef, {} as any, { queue: { prefix: 'tba:bull' } } as any);
    };

    it('should treat a job as exhausted only after its last attempt or an UnrecoverableError', () => {
      const service = buildService({});
      const job: any = { attemptsMade: 4, opts: { attempts: 5 } };

      expect(service.isExhausted(job)).toBe(false);
      expect(service.isExhausted({ ...job, attemptsMade: 5 })).toBe(true);
      const unrecoverable = Object.assign(new Error('bad payload'), { name: 'UnrecoverableError' });
      expect(service.isExhausted(job, unrecoverable)).toBe(true);
    });

    it('should copy the exhausted job to <queue>-dlq with a deterministic jobId (idempotent)', async () => {
      const dlq = { name: 'document-rendering-queue-dlq', add: jest.fn().mockResolvedValue({}) };
      const service = buildService(dlq);
      const job: any = {
        id: '77',
        name: 'issueInvoice',
        attemptsMade: 5,
        opts: { attempts: 5 },
        stacktrace: ['Error: PARTNER timeout'],
        data: { metadata: { traceId: 'TRACE-1', tenantId: 't1', enqueuedAt: '' }, payload: { invoiceNo: 'AB12CD' } },
      };

      await service.moveToDeadLetter('document-rendering-queue', job, new Error('PARTNER timeout'));

      expect(dlq.add).toHaveBeenCalledWith(
        'dlq:issueInvoice',
        expect.objectContaining({
          originalQueue: 'document-rendering-queue',
          originalJobId: '77',
          failedReason: 'PARTNER timeout',
          jobData: job.data,
        }),
        expect.objectContaining({ jobId: 'document-rendering-queue:77' }),
      );
    });
  });

  describe('BaseQueueWorker', () => {
    it('should restore trace and tenant context using runWithContext during execution', async () => {
      const worker = new TestQueueWorker(contextService);

      const mockJob = {
        id: 'job_101',
        name: 'sendWelcomeEmail',
        attemptsMade: 0,
        opts: { attempts: 5 },
        data: {
          metadata: {
            traceId: 'TRACE-RESTORED-888',
            tenantId: 'tenant_hanoi',
            actorId: 'usr_actor_99',
            enqueuedAt: new Date().toISOString(),
          },
          payload: { email: 'pilot@rental.vn' },
        },
      } as unknown as Job;

      const runWithContextSpy = jest.spyOn(contextService, 'runWithContext');

      const result = await worker.process(mockJob);

      expect(result).toEqual({ success: true });
      expect(runWithContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'TRACE-RESTORED-888',
          tenantId: 'tenant_hanoi',
        }),
        expect.any(Function),
      );
      expect(worker.executedPayload).toEqual({ email: 'pilot@rental.vn' });
    });
  });
});

// npx jest src/infrastructure/queue/queue.spec.ts