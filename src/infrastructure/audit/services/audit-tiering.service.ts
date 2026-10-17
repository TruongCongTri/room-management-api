/**
 * Chuyển log cũ hơn AUDIT_HOT_RETENTION_DAYS từ Hot DB (PostgreSQL) sang Cold Storage (S3 / MinIO; dùng
 * lifecycle policy của bucket để chuyển tiếp sang Glacier).
 *
 * An toàn dữ liệu:
 *  - Mỗi lô: SELECT ... FOR UPDATE SKIP LOCKED → nén NDJSON gzip → UPLOAD → chỉ khi upload thành công mới DELETE,
 *    tất cả trong MỘT transaction (upload lỗi → rollback, không mất bản ghi nào).
 *  - Key archive tất định theo khoảng id/thời gian → chạy lại sau sự cố chỉ ghi đè cùng một object.
 *  - Trigger WORM chỉ cho phép DELETE khi transaction bật cờ app.audit_tiering (SET LOCAL).
 */

import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { gzipSync } from 'zlib';
import { AppConfigService } from '../../../core/config/app-config.service';
import { S3StorageService } from '../../storage/services/s3-storage.service';
import { DistributedCronRegistrar } from '../../schedule/services/distributed-cron.registrar';

export const AUDIT_TIERING_FLAG = 'app.audit_tiering';
const MAX_BATCHES_PER_RUN = 1000;

interface AuditRow {
  id: string;
  created_at: Date;
  [column: string]: unknown;
}

@Injectable()
export class AuditTieringService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditTieringService.name);
  private readonly retentionDays: number;
  private readonly batchSize: number;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: AppConfigService,
    @Optional() private readonly storage?: S3StorageService,
    @Optional() private readonly cronRegistrar?: DistributedCronRegistrar,
  ) {
    this.retentionDays = config?.audit.hotRetentionDays ?? 90;
    this.batchSize = config?.audit.tieringBatchSize ?? 1000;
  }

  onApplicationBootstrap(): void {
    const audit = this.config?.audit;
    if (!audit?.tieringEnabled || !this.cronRegistrar) return;
    this.cronRegistrar.register('audit-tiering', audit.tieringCron, () => this.executeTiering(), {
      ttlMs: 30 * 60_000,
    });
  }

  /**
   * Quét và phân tầng dữ liệu (Hot/Cold Tiering Job)
   */
  async executeTiering(): Promise<{ archivedCount: number; batches: number }> {
    if (!this.storage || this.config?.storage.enabled === false) {
      this.logger.warn('[Audit Tiering] Object storage is disabled: skipping (hot rows are never purged without an archive).');
      return { archivedCount: 0, batches: 0 };
    }

    const cutoffDate = new Date(Date.now() - this.retentionDays * 24 * 3600 * 1000);
    this.logger.log(`[Audit Tiering] Archiving audit logs older than ${cutoffDate.toISOString()}...`);

    let archivedCount = 0;
    let batches = 0;
    while (batches < MAX_BATCHES_PER_RUN) {
      const archived = await this.archiveBatch(cutoffDate);
      if (archived === 0) break;
      archivedCount += archived;
      batches++;
      if (archived < this.batchSize) break;
    }

    this.logger.log(`[Audit Tiering] Archived and purged ${archivedCount} record(s) in ${batches} batch(es).`);
    return { archivedCount, batches };
  }

  private archiveBatch(cutoffDate: Date): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows: AuditRow[] = await manager.query(
        `SELECT * FROM audit_logs WHERE created_at < $1 ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [cutoffDate, this.batchSize],
      );
      if (rows.length === 0) return 0;

      // 1. Nén NDJSON (Newline Delimited JSON)
      const body = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8'));

      // 2. Upload lên Cold Storage; lỗi → ném ra → rollback, không xóa bản ghi nào
      const first = rows[0];
      const last = rows[rows.length - 1];
      const day = new Date(first.created_at).toISOString().slice(0, 10).replace(/-/g, '/');
      const key = `audit-archive/${day}/audit-logs-${first.id}-${last.id}.ndjson.gz`;
      await this.storage!.putArchiveObject(key, body, {
        contentType: 'application/x-ndjson',
        contentEncoding: 'gzip',
        metadata: { records: String(rows.length), cutoff: cutoffDate.toISOString() },
      });

      // 3. Mở khóa WORM trong phạm vi transaction này rồi xóa khỏi Hot DB
      await manager.query('SELECT set_config($1, $2, true)', [AUDIT_TIERING_FLAG, 'on']);
      await manager.query('DELETE FROM audit_logs WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);

      this.logger.log(`[Audit Tiering] Batch of ${rows.length} record(s) archived to ${key}`);
      return rows.length;
    });
  }
}
