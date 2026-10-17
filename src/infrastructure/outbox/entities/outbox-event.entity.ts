// Thực thể outbox_events lưu trữ trạng thái bất biến của sự kiện phát sinh từ domain transaction:

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { OutboxEventStatus } from '../constants/outbox.constants';

@Entity('outbox_events')
// Index phục vụ OutboxPollerService (FOR UPDATE SKIP LOCKED)
@Index('idx_outbox_poll_pending', ['status', 'nextRetryAt', 'createdAt'])
@Index('idx_outbox_bld_created', ['buildingId', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** NULL với sự kiện hệ thống không thuộc tòa nhà nào */
  @Column({ type: 'uuid', name: 'building_id', nullable: true })
  buildingId?: string | null;

  @Column({ type: 'varchar', length: 100, name: 'aggregate_type' })
  aggregateType: string; // Ví dụ: 'CONTRACT', 'METER_READING', 'INVOICE', 'CHECKOUT_SETTLEMENT'

  @Column({ type: 'varchar', length: 100, name: 'aggregate_id' })
  aggregateId: string;

  @Column({ type: 'varchar', length: 150, name: 'event_type' })
  eventType: string; // Ví dụ: 'contract.activated', 'meter_reading.recorded', 'checkout.settled'

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @Column({
    type: 'enum',
    enum: OutboxEventStatus,
    default: OutboxEventStatus.PENDING,
  })
  status: OutboxEventStatus;

  @Column({ type: 'int', default: 0, name: 'retry_count' })
  retryCount: number;

  @Column({ type: 'int', default: 5, name: 'max_retries' })
  maxRetries: number;

  /** Thời điểm được phép thử lại (FAILED) hoặc hết hạn lease (PROCESSING) */
  @Column({ type: 'timestamptz', nullable: true, name: 'next_retry_at' })
  nextRetryAt?: Date | null;

  @Column({ type: 'varchar', length: 128, name: 'trace_id' })
  traceId: string;

  /** W3C traceparent của request gốc: consumer nối tiếp distributed trace */
  @Column({ type: 'varchar', length: 64, nullable: true })
  traceparent?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'actor_id' })
  actorId?: string | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError?: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
