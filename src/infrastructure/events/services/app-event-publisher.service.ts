import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseDomainEvent } from '../bases/base-domain.event';
import { RequestContextService } from '../../../core/context/request-context.service';

@Injectable()
export class AppEventPublisher {
  private readonly logger = new Logger(AppEventPublisher.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly contextService: RequestContextService,
  ) {}

  /**
   * Phát Domain Event bất đồng bộ với cơ chế cô lập lỗi giữa các listener
   */
  async publishAsync<T extends BaseDomainEvent>(eventKey: string, event: T): Promise<void> {
    const traceId = event.metadata?.traceId || this.contextService.getTraceId();
    const tenantId = event.metadata?.tenantId || this.contextService.getTenantId();

    this.logger.debug(
      `[DomainEvent] Publishing event '${eventKey}' (EventId: ${event.metadata.eventId}, Trace: ${traceId})`,
    );

    try {
      // emitAsync trả về danh sách kết quả hoặc rejected promises từ các listeners
      const listeners = this.eventEmitter.listeners(eventKey);
      if (listeners.length === 0) {
        return;
      }

      // Thực thi độc lập từng listener để lỗi của một module không kéo sập module khác
      const results = await Promise.allSettled(
        listeners.map((listener) =>
          this.contextService.runWithContext(
            {
              traceId,
              tenantId,
              user: event.metadata.actorId
                ? {
                    id: event.metadata.actorId,
                    email: `${event.metadata.actorId}@internal.system`,
                    roles: ['SYSTEM_EVENT_LISTENER'],
                    rules: [],
                  }
                : undefined,
            },
            () => (listener as (...args: any[]) => Promise<any>)(event),
          ),
        ),
      );

      for (const res of results) {
        if (res.status === 'rejected') {
          this.logger.error(
            `[DomainEvent Error] Listener for '${eventKey}' failed: ${res.reason?.message}`,
            res.reason?.stack,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`Critical error dispatching event '${eventKey}': ${err.message}`, err.stack);
    }
  }
}