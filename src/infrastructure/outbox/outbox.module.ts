import { Global, Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OutboxService } from './services/outbox.service';
import { OutboxPollerService } from './services/outbox-poller.service';
import { OutboxCleanerService } from './services/outbox-cleaner.service';
import { OUTBOX_RELAY_HANDLER } from './constants/outbox.constants';
import { OutboxRelayHandler } from './interfaces/outbox.interface';
import { BullMqOutboxRelay, InProcessOutboxRelay } from './relays/outbox-relays';
import { QUEUE_NAMES } from '../queue/constants/queue.constant';
import { AppEventPublisher } from '../events/services/app-event-publisher.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEventEntity])],
  providers: [
    OutboxService,
    OutboxPollerService,
    OutboxCleanerService,
    {
      // Relay mặc định: BullMQ (khi QueueModule được nạp do REDIS_ENABLED=true), ngược lại event bus nội bộ.
      // Override provider này để relay sang Kafka / RabbitMQ.
      provide: OUTBOX_RELAY_HANDLER,
      inject: [AppEventPublisher, { token: getQueueToken(QUEUE_NAMES.DOMAIN_EVENTS), optional: true }],
      useFactory: (publisher: AppEventPublisher, domainEventsQueue?: Queue): OutboxRelayHandler => {
        if (domainEventsQueue) {
          return new BullMqOutboxRelay(domainEventsQueue);
        }
        new Logger('OutboxModule').warn(
          'BullMQ is not available (REDIS_ENABLED=false): outbox events are relayed to the in-process event bus.',
        );
        return new InProcessOutboxRelay(publisher);
      },
    },
  ],
  exports: [OutboxService, OutboxPollerService, OutboxCleanerService, OUTBOX_RELAY_HANDLER],
})
export class OutboxModule {}
