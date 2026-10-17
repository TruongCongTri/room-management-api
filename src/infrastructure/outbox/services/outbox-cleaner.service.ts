// Tự động dọn dẹp các sự kiện đã gửi thành công sau OUTBOX_RETENTION_DAYS để giải phóng tài nguyên database:

import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OUTBOX_DEFAULTS } from '../constants/outbox.constants';
import { AppConfigService } from '../../../core/config/app-config.service';
import { DistributedCronRegistrar } from '../../schedule/services/distributed-cron.registrar';

const DELETE_BATCH_SIZE = 5000;

/** Xóa theo lô nhỏ (LIMIT qua subquery) để không giữ khóa/lấp WAL quá lâu trên bảng lớn */
const PURGE_BATCH_SQL = `
  DELETE FROM outbox_events
   WHERE id IN (
     SELECT id FROM outbox_events
      WHERE status = 'PUBLISHED' AND processed_at < $1
      LIMIT $2
   )`;

@Injectable()
export class OutboxCleanerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxCleanerService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: AppConfigService,
    @Optional() private readonly cronRegistrar?: DistributedCronRegistrar,
  ) {}

  /** Đăng ký cron dọn dẹp theo OUTBOX_CLEANUP_CRON (chỉ một Pod chạy nhờ khóa phân tán) */
  onApplicationBootstrap(): void {
    const outbox = this.config?.outbox;
    if (!this.cronRegistrar || !outbox?.enabled) return;
    this.cronRegistrar.register('outbox-cleanup', outbox.cleanupCron, () => this.purgeOldProcessedEvents(), {
      ttlMs: 10 * 60_000,
    });
  }

  /**
   * Quét và xóa các bản ghi PUBLISHED đã vượt quá thời hạn lưu trữ
   */
  async purgeOldProcessedEvents(): Promise<number> {
    const retentionDays = this.config?.outbox.retentionDays ?? OUTBOX_DEFAULTS.RETENTION_DAYS;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);

    let total = 0;
    for (;;) {
      const result = await this.dataSource.query(PURGE_BATCH_SQL, [cutoffDate, DELETE_BATCH_SIZE]);
      const affected = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      total += affected;
      if (affected < DELETE_BATCH_SIZE) break;
    }

    if (total > 0) {
      this.logger.log(`[Outbox Cleaner] Purged ${total} processed outbox events older than ${cutoffDate.toISOString()}`);
    }
    return total;
  }
}
