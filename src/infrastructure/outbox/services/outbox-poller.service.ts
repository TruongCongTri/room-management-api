/**
 * Bộ quét Outbox chạy nền trên MỌI Pod, an toàn khi scale ngang:
 *  1. CLAIM: một câu UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING * ngắn gọn
 *     đánh dấu batch là PROCESSING kèm lease (next_retry_at). Pod khác bỏ qua các dòng đang bị khóa.
 *  2. RELAY: gửi từng sự kiện sang broker NGOÀI transaction (không giữ khóa dòng trong lúc chờ mạng).
 *  3. SETTLE: PUBLISHED / FAILED (Exponential Backoff + Jitter) / DEAD_LETTER khi kiệt sức retry.
 * Pod chết giữa chừng → lease hết hạn → batch được Pod khác nhận lại (at-least-once, relay phải idempotent).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  OUTBOX_DEFAULTS,
  OUTBOX_RELAY_HANDLER,
  OutboxEventStatus,
} from '../constants/outbox.constants';
import { OutboxRelayEvent, OutboxRelayHandler } from '../interfaces/outbox.interface';
import { RequestContextService } from '../../../core/context/request-context.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { ShutdownRegistry } from '../../../core/shutdown/shutdown.registry';
import { ShutdownPhase } from '../../../core/shutdown/shutdown.interface';

const CLAIM_SQL = `
  UPDATE outbox_events
     SET status = 'PROCESSING',
         next_retry_at = now() + make_interval(secs => $2::double precision / 1000)
   WHERE id IN (
     SELECT id FROM outbox_events
      WHERE (status IN ('PENDING', 'FAILED') AND (next_retry_at IS NULL OR next_retry_at <= now()))
         OR (status = 'PROCESSING' AND next_retry_at <= now())
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, building_id, aggregate_type, aggregate_id, event_type, payload,
            retry_count, max_retries, trace_id, traceparent, actor_id, created_at`;

const MARK_PUBLISHED_SQL = `
  UPDATE outbox_events
     SET status = 'PUBLISHED', processed_at = now(), last_error = NULL, next_retry_at = NULL
   WHERE id = $1 AND status = 'PROCESSING'`;

const MARK_FAILED_SQL = `
  UPDATE outbox_events
     SET status = $2::outbox_events_status_enum,
         retry_count = $3,
         last_error = $4,
         next_retry_at = CASE WHEN $5::double precision IS NULL THEN NULL
                              ELSE now() + make_interval(secs => $5::double precision / 1000) END
   WHERE id = $1 AND status = 'PROCESSING'`;

interface ClaimedRow {
  id: string;
  building_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, any>;
  retry_count: number;
  max_retries: number;
  trace_id: string;
  traceparent: string | null;
  actor_id: string | null;
  created_at: Date;
}

@Injectable()
export class OutboxPollerService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPollerService.name);
  private readonly contextService = new RequestContextService();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private currentBatch: Promise<number> | null = null;

  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly baseRetryDelayMs: number;
  private readonly leaseMs: number;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(OUTBOX_RELAY_HANDLER) private readonly relayHandler: OutboxRelayHandler,
    @Optional() config?: AppConfigService,
    @Optional() private readonly shutdownRegistry?: ShutdownRegistry,
  ) {
    const outbox = config?.outbox;
    this.enabled = outbox?.enabled ?? true;
    this.pollIntervalMs = outbox?.pollIntervalMs ?? OUTBOX_DEFAULTS.POLL_INTERVAL_MS;
    this.batchSize = outbox?.batchSize ?? OUTBOX_DEFAULTS.BATCH_SIZE;
    this.baseRetryDelayMs = outbox?.baseRetryDelayMs ?? OUTBOX_DEFAULTS.BASE_RETRY_DELAY_MS;
    this.leaseMs = outbox?.leaseMs ?? OUTBOX_DEFAULTS.LEASE_MS;
  }

  onModuleInit(): void {
    // Pha 2: ngừng nhận batch mới và chờ batch đang relay hoàn tất trước khi đóng DB pool
    this.shutdownRegistry?.register(
      'OutboxPollerStop',
      ShutdownPhase.PAUSE_CONSUMERS,
      () => this.stop(),
      30,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn('OUTBOX_ENABLED=false: outbox events will not be relayed by this instance.');
      return;
    }
    this.scheduleNext(this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.currentBatch?.catch(() => undefined);
  }

  /** setTimeout nối tiếp (không phải setInterval) → không bao giờ có hai batch chồng nhau trong một Pod */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      const processed = await this.pollAndRelayEvents();
      // Còn backlog → quét tiếp ngay; hết việc → chờ chu kỳ bình thường
      this.scheduleNext(processed >= this.batchSize ? 0 : this.pollIntervalMs);
    }, delayMs);
    this.timer.unref();
  }

  /**
   * Nhận một batch và relay. Trả về số sự kiện đã xử lý (thành công hoặc thất bại).
   */
  async pollAndRelayEvents(): Promise<number> {
    if (this.currentBatch) return 0;
    this.currentBatch = this.contextService
      .runAsSystem('OUTBOX_POLLER', () => this.processBatch())
      .catch((err: any) => {
        // Bảng chưa migrate / DB tạm thời mất kết nối: ghi log và thử lại ở chu kỳ sau
        this.logger.error(`Outbox polling failed: ${err.message}`);
        return 0;
      })
      .finally(() => {
        this.currentBatch = null;
      });
    return this.currentBatch;
  }

  private async processBatch(): Promise<number> {
    if (!this.dataSource.isInitialized) return 0;

    const result = await this.dataSource.query(CLAIM_SQL, [this.batchSize, this.leaseMs]);
    // node-postgres trả về [rows, rowCount] cho UPDATE ... RETURNING qua TypeORM
    const rows: ClaimedRow[] = (Array.isArray(result?.[0]) ? result[0] : result) ?? [];
    rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    for (const row of rows) {
      await this.relayOne(row);
    }
    return rows.length;
  }

  private async relayOne(row: ClaimedRow): Promise<void> {
    const event: OutboxRelayEvent = {
      id: row.id,
      buildingId: row.building_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      traceId: row.trace_id,
      traceparent: row.traceparent,
      actorId: row.actor_id,
      createdAt: row.created_at,
    };

    // Log/span của relay mang traceId của request gốc đã sinh ra sự kiện
    await this.contextService.runWithContext(
      { traceId: row.trace_id, tenantId: row.building_id ?? undefined, isBackgroundJob: true },
      async () => {
        try {
          await this.relayHandler.relay(event);
          await this.dataSource.query(MARK_PUBLISHED_SQL, [row.id]);
        } catch (err: any) {
          await this.markFailed(row, err);
        }
      },
    );
  }

  private async markFailed(row: ClaimedRow, err: any): Promise<void> {
    const retryCount = row.retry_count + 1;
    const message = String(err?.message ?? err).slice(0, 2000);

    if (retryCount >= row.max_retries) {
      this.logger.error(
        `[Outbox DLQ] Event #${row.id} (${row.event_type}) exhausted all ${row.max_retries} retries. Moved to DEAD_LETTER: ${message}`,
      );
      await this.dataSource.query(MARK_FAILED_SQL, [row.id, OutboxEventStatus.DEAD_LETTER, retryCount, message, null]);
      return;
    }

    // Exponential Backoff + Full Jitter: delay ∈ [base*2^(n-1)/2, base*2^(n-1)]
    const exponential = this.baseRetryDelayMs * 2 ** (retryCount - 1);
    const delayMs = Math.round(exponential / 2 + Math.random() * (exponential / 2));
    this.logger.warn(`[Outbox] Relay of event #${row.id} failed (attempt ${retryCount}/${row.max_retries}); retry in ${delayMs}ms: ${message}`);
    await this.dataSource.query(MARK_FAILED_SQL, [row.id, OutboxEventStatus.FAILED, retryCount, message, delayMs]);
  }
}
