/**
 * Tạo test suite kiểm tra:
 *  Atomic Transaction Persistence: Bản ghi Outbox được khởi tạo và lưu bằng đúng EntityManager của transaction.
 *  Claim không chặn (FOR UPDATE SKIP LOCKED + lease) và relay NGOÀI transaction.
 *  Delivery Success Transition: PUBLISHED khi gửi thành công.
 *  Exponential Retry & DLQ: tăng retry_count, dãn next_retry_at, DEAD_LETTER khi kiệt sức retry.
 *  Relay BullMQ idempotent (jobId = outbox event id).
 *
 * */

import { EntityManager, DataSource } from 'typeorm';
import { OutboxService } from './services/outbox.service';
import { OutboxPollerService } from './services/outbox-poller.service';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OutboxEventStatus } from './constants/outbox.constants';
import { RequestContextService } from '../../core/context/request-context.service';
import { OutboxRelayHandler } from './interfaces/outbox.interface';
import { BullMqOutboxRelay } from './relays/outbox-relays';

const claimedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  building_id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'PAYMENT',
  aggregate_id: 'PAY-100',
  event_type: 'payment.settled',
  payload: { success: true },
  retry_count: 0,
  max_retries: 5,
  trace_id: 'TRACE-1',
  traceparent: null,
  actor_id: 'usr_1',
  created_at: new Date(),
  ...overrides,
});

describe('OutboxModule (Enterprise Transactional Outbox Suite)', () => {
  let contextService: RequestContextService;

  beforeEach(() => {
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-OB-123');
    jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_sg');
    jest.spyOn(contextService, 'getUserId').mockReturnValue('usr_lead');
  });

  describe('OutboxService', () => {
    it('should create an outbox event inside the provided active transaction manager', async () => {
      const service = new OutboxService(contextService);
      const mockManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => Promise.resolve({ id: 'ob_uuid_1', ...data })),
      } as unknown as jest.Mocked<EntityManager>;

      const event = await service.createEventInTransaction(mockManager, {
        aggregateType: 'CONTRACT',
        aggregateId: 'BK-777',
        eventType: 'meter_reading.recorded',
        payload: { amount: 5000000 },
      });

      expect(mockManager.create).toHaveBeenCalledWith(
        OutboxEventEntity,
        expect.objectContaining({
          buildingId: 'tenant_sg',
          aggregateType: 'CONTRACT',
          aggregateId: 'BK-777',
          eventType: 'meter_reading.recorded',
          status: OutboxEventStatus.PENDING,
          traceId: 'TRACE-OB-123',
          actorId: 'usr_lead',
        }),
      );
      expect(mockManager.save).toHaveBeenCalled();
      expect(event.id).toBe('ob_uuid_1');
    });
  });

  describe('OutboxPollerService', () => {
    let query: jest.Mock;
    let relayHandler: jest.Mocked<OutboxRelayHandler>;
    let poller: OutboxPollerService;

    beforeEach(() => {
      query = jest.fn();
      relayHandler = { relay: jest.fn() };
      const dataSource = { isInitialized: true, query } as unknown as DataSource;
      poller = new OutboxPollerService(dataSource, relayHandler);
    });

    it('should claim with SKIP LOCKED + lease, relay outside the claim and mark PUBLISHED', async () => {
      query.mockResolvedValueOnce([[claimedRow()], 1]).mockResolvedValueOnce([[], 1]);
      relayHandler.relay.mockResolvedValue(undefined);

      const count = await poller.pollAndRelayEvents();

      expect(count).toBe(1);
      const [claimSql, claimParams] = query.mock.calls[0];
      expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
      expect(claimSql).toContain("SET status = 'PROCESSING'");
      expect(claimParams).toEqual([50, 60000]);
      expect(relayHandler.relay).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt_1', eventType: 'payment.settled', traceId: 'TRACE-1' }),
      );
      const [publishSql, publishParams] = query.mock.calls[1];
      expect(publishSql).toContain("status = 'PUBLISHED'");
      expect(publishParams).toEqual(['evt_1']);
    });

    it('should schedule an exponential retry when relay fails before max retries', async () => {
      query.mockResolvedValueOnce([[claimedRow({ retry_count: 1 })], 1]).mockResolvedValueOnce([[], 1]);
      relayHandler.relay.mockRejectedValue(new Error('Broker unreachable'));

      await poller.pollAndRelayEvents();

      const [, params] = query.mock.calls[1];
      expect(params[1]).toBe(OutboxEventStatus.FAILED);
      expect(params[2]).toBe(2); // retry_count tăng
      expect(params[3]).toBe('Broker unreachable');
      // attempt 2 → base 2000 * 2^1 = 4000, jitter trong [2000, 4000]
      expect(params[4]).toBeGreaterThanOrEqual(2000);
      expect(params[4]).toBeLessThanOrEqual(4000);
    });

    it('should transition to DEAD_LETTER when maximum retry attempts are exhausted', async () => {
      query.mockResolvedValueOnce([[claimedRow({ retry_count: 4 })], 1]).mockResolvedValueOnce([[], 1]);
      relayHandler.relay.mockRejectedValue(new Error('Broker unreachable'));

      await poller.pollAndRelayEvents();

      const [, params] = query.mock.calls[1];
      expect(params).toEqual(['evt_1', OutboxEventStatus.DEAD_LETTER, 5, 'Broker unreachable', null]);
    });

    it('should never run two batches concurrently in the same pod', async () => {
      let release!: (value: unknown) => void;
      query.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

      const first = poller.pollAndRelayEvents();
      await expect(poller.pollAndRelayEvents()).resolves.toBe(0);
      release([[], 0]);
      await first;
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('BullMqOutboxRelay', () => {
    it('should enqueue with jobId = outbox event id so re-relays are deduplicated', async () => {
      const queue: any = { add: jest.fn().mockResolvedValue({ id: 'evt_9' }) };
      await new BullMqOutboxRelay(queue).relay({
        id: 'evt_9',
        buildingId: 't1',
        eventType: 'meter_reading.recorded',
        aggregateType: 'CONTRACT',
        aggregateId: 'BK-1',
        payload: { total: 1 },
        traceId: 'TRACE-9',
      });

      expect(queue.add).toHaveBeenCalledWith(
        'meter_reading.recorded',
        expect.objectContaining({
          metadata: expect.objectContaining({ traceId: 'TRACE-9', tenantId: 't1' }),
          payload: expect.objectContaining({ eventId: 'evt_9', data: { total: 1 } }),
        }),
        { jobId: 'evt_9' },
      );
    });
  });
});
