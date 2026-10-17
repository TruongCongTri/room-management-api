/**
 * Thực thi một tác vụ định kỳ dưới khóa phân tán + ngữ cảnh hệ thống (dùng chung cho @DistributedCron
 * và cron đăng ký động từ cấu hình):
 *  - Chỉ Pod lấy được khóa mới chạy (retryCount = 0), các Pod còn lại bỏ qua an toàn.
 *  - Watchdog gia hạn khóa khi tác vụ chạy lâu hơn TTL (không bị Pod khác chạy chồng).
 *  - Giữ khóa tối thiểu (Minimum Lock Retention) khi tác vụ xong quá nhanh → chống chạy lặp do lệch đồng hồ.
 *  - traceId dạng cron:<jobName>:<timestamp>, user hệ thống (bypass RLS có kiểm soát).
 */
import { Logger } from '@nestjs/common';
import { CronTime } from 'cron';
import { DistributedLockService } from '../../lock/services/distributed-lock.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import {
  SYSTEM_ROLE,
  SYSTEM_USER_ID,
} from '../../../core/context/request-context.model';
import { LockHandle } from '../../lock/interfaces/lock.interface';

/** Mặc định giữ khóa tối đa 30s sau khi chạy xong (đủ cho độ lệch NTP thông thường) */
const DEFAULT_MAX_HOLD_MS = 30_000;

export interface DistributedJobOptions {
  /** TTL khóa (ms), được watchdog gia hạn liên tục khi tác vụ còn chạy. Mặc định 60s */
  ttlMs?: number;
  /** Giữ khóa tối thiểu tính từ lúc bắt đầu. Mặc định: min(30s, 50% chu kỳ cron) */
  minHoldMs?: number;
}

/** Ước lượng chu kỳ (ms) giữa hai lần chạy liên tiếp của biểu thức cron */
export function estimateCronPeriodMs(cronTime: string | Date): number | undefined {
  if (cronTime instanceof Date) return undefined;
  try {
    const [first, second] = new CronTime(cronTime).sendAt(2) as unknown as Array<{ toMillis(): number }>;
    return second.toMillis() - first.toMillis();
  } catch {
    return undefined;
  }
}

export function resolveMinHoldMs(cronTime: string | Date, options: DistributedJobOptions): number {
  if (options.minHoldMs !== undefined) return options.minHoldMs;
  const period = estimateCronPeriodMs(cronTime);
  return period ? Math.min(DEFAULT_MAX_HOLD_MS, Math.floor(period / 2)) : DEFAULT_MAX_HOLD_MS;
}

export async function runDistributedJob(
  jobName: string,
  task: (handle: LockHandle) => Promise<unknown> | unknown,
  options: DistributedJobOptions & { minHoldMs: number },
  lockService: DistributedLockService | undefined = DistributedLockService.getInstance(),
): Promise<void> {
  const logger = new Logger(`DistributedCron:${jobName}`);

  if (!lockService) {
    logger.warn(`DistributedLockService is unavailable. Running '${jobName}' WITHOUT cluster lock!`);
  }

  // RequestContextService dùng AsyncLocalStorage tĩnh → khởi tạo không cần DI vẫn đúng ngữ cảnh
  const contextService = new RequestContextService();

  await contextService.runWithContext(
    {
      traceId: `cron:${jobName}:${Date.now()}`,
      userAgent: 'DistributedCronWorker',
      isBackgroundJob: true,
      user: {
        id: SYSTEM_USER_ID,
        email: 'cron@system.internal',
        roles: [SYSTEM_ROLE],
        rules: [],
      },
    },
    async () => {
      let handle: LockHandle | undefined;
      if (lockService) {
        try {
          handle = await lockService.acquire(`cron:${jobName}`, {
            ttlMs: options.ttlMs ?? 60_000,
            retryCount: 0,
            autoRenew: true,
          });
        } catch {
          logger.debug(`Job '${jobName}' is already being processed by another pod. Skipping execution.`);
          return;
        }
      }

      const startedAt = Date.now();
      try {
        logger.log(`Executing cron job '${jobName}'...`);
        await task(handle ?? { key: jobName, token: 'local', ttlMs: 0, acquiredAt: startedAt });
        logger.log(`Cron job '${jobName}' completed in ${Date.now() - startedAt}ms.`);
      } catch (err: any) {
        logger.error(`Error executing cron job '${jobName}': ${err.message}`, err.stack);
      } finally {
        if (handle && lockService) {
          await lockService.release(handle, { minHoldMs: options.minHoldMs });
        }
      }
    },
  );
}
