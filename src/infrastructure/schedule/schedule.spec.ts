import { ConflictException } from '@nestjs/common';
import { DistributedLockService } from '../lock/services/distributed-lock.service';
import { RequestContextService } from '../../core/context/request-context.service';
import { DistributedCron } from './decorators/distributed-cron.decorator';
import { resolveMinHoldMs } from './services/distributed-job.runner';

class TestCronTask {
  public executedCount = 0;

  constructor(
    public readonly lockService: DistributedLockService,
    public readonly contextService: RequestContextService,
  ) {}

  @DistributedCron('0 0 * * *', 'daily-overdue-invoices', { ttlMs: 10000 })
  async handleDailySettlement() {
    this.executedCount++;
  }
}

describe('AppScheduleModule (Distributed Cron Lock Suite)', () => {
  let lockService: jest.Mocked<DistributedLockService>;
  let contextService: RequestContextService;
  let task: TestCronTask;

  beforeEach(() => {
    lockService = {
      acquire: jest.fn(),
      release: jest.fn(),
    } as unknown as jest.Mocked<DistributedLockService>;

    contextService = new RequestContextService();
    task = new TestCronTask(lockService, contextService);
  });

  it('should execute cron job when cluster lock is successfully acquired', async () => {
    const handle = {
      key: 'dlock:global:cron:daily-overdue-invoices',
      token: 'uuid_token',
      ttlMs: 10000,
      acquiredAt: Date.now(),
    };
    lockService.acquire.mockResolvedValue(handle);

    await task.handleDailySettlement();

    expect(lockService.acquire).toHaveBeenCalledWith('cron:daily-overdue-invoices', {
      ttlMs: 10000,
      retryCount: 0,
      autoRenew: true, // watchdog gia hạn khóa nếu tác vụ chạy lâu hơn TTL
    });
    expect(task.executedCount).toBe(1);
    // Daily cron → giữ khóa tối thiểu 30s chống chạy lặp do lệch đồng hồ giữa các Pod
    expect(lockService.release).toHaveBeenCalledWith(handle, { minHoldMs: 30000 });
  });

  it('should skip cron execution cleanly if another pod already holds the lock', async () => {
    // Giả lập Pod khác đã giữ lock dẫn đến ConflictException
    lockService.acquire.mockRejectedValue(new ConflictException('Resource locked'));

    await task.handleDailySettlement();

    expect(task.executedCount).toBe(0); // Bỏ qua an toàn, không ném lỗi unhandled
  });

  it('should run inside a system context with a cron traceId', async () => {
    lockService.acquire.mockResolvedValue({ key: 'k', token: 't', ttlMs: 1, acquiredAt: Date.now() });
    let observedTraceId: string | undefined;
    let privileged = false;

    class ContextProbe {
      constructor(public readonly lockService: DistributedLockService) {}

      @DistributedCron('*/10 * * * * *', 'probe-job')
      async run() {
        observedTraceId = contextService.getTraceId();
        privileged = contextService.isPrivileged();
      }
    }

    await new ContextProbe(lockService).run();

    expect(observedTraceId).toMatch(/^cron:probe-job:\d+$/);
    expect(privileged).toBe(true);
  });

  it('should cap the minimum hold to half of a short cron period', () => {
    expect(resolveMinHoldMs('*/10 * * * * *', {})).toBe(5000);
    expect(resolveMinHoldMs('0 0 * * *', {})).toBe(30000);
    expect(resolveMinHoldMs('0 0 * * *', { minHoldMs: 0 })).toBe(0);
  });
});

// npx jest src/infrastructure/schedule/schedule.spec.ts