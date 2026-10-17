import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppEventPublisher } from './services/app-event-publisher.service';
import { BaseDomainEvent } from './bases/base-domain.event';
import { RequestContextService } from '../../core/context/request-context.service';

class OrderCreatedEvent extends BaseDomainEvent<{ orderId: string }> {}

describe('DomainEventsModule (Enterprise Event-Driven Suite)', () => {
  let publisher: AppEventPublisher;
  let eventEmitter: EventEmitter2;
  let contextService: RequestContextService;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    contextService = new RequestContextService();
    jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-EVENT-001');

    publisher = new AppEventPublisher(eventEmitter, contextService);
  });

  it('should publish event and preserve trace context across async listeners', async () => {
    let capturedTraceId = '';

    eventEmitter.on('order.created', async (event: OrderCreatedEvent) => {
      capturedTraceId = contextService.getTraceId();
      return event.payload.orderId;
    });

    const event = new OrderCreatedEvent({ orderId: 'ORD-999' }, { traceId: 'TRACE-EVENT-001' });
    await publisher.publishAsync('order.created', event);

    expect(capturedTraceId).toBe('TRACE-EVENT-001');
  });

  it('should isolate listener failures without crashing other listeners', async () => {
    let listener2Executed = false;

    // Listener 1: ném lỗi
    eventEmitter.on('contract.activated', async () => {
      throw new Error('Analytics DB crashed');
    });

    // Listener 2: gửi email
    eventEmitter.on('contract.activated', async () => {
      listener2Executed = true;
    });

    const event = new OrderCreatedEvent({ orderId: 'ORD-888' });
    await expect(publisher.publishAsync('contract.activated', event)).resolves.not.toThrow();

    expect(listener2Executed).toBe(true);
  });

  it('should capture trace, tenant and actor from the active request context automatically', async () => {
    const tenantId = '33333333-3333-4333-8333-333333333333';
    let listenerTenant: string | undefined;
    eventEmitter.on('order.created', async () => {
      listenerTenant = new RequestContextService().getTenantId();
    });

    await new RequestContextService().runWithContext(
      {
        traceId: 'TRACE-HTTP-42',
        isBackgroundJob: false,
        user: { id: 'usr_9', email: 'a@b.c', tenantId, roles: [], rules: [] },
      },
      async () => {
        const event = new OrderCreatedEvent({ orderId: 'ORD-1' });
        expect(event.metadata).toEqual(
          expect.objectContaining({ traceId: 'TRACE-HTTP-42', tenantId, actorId: 'usr_9' }),
        );
        await publisher.publishAsync('order.created', event);
      },
    );

    // Listener chạy trong context được khôi phục từ metadata của sự kiện (tenant không bị mất)
    expect(listenerTenant).toBe(tenantId);
  });
});

// npx jest src/infrastructure/events/events.spec.ts