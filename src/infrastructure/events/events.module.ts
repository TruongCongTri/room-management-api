import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppEventPublisher } from './services/app-event-publisher.service';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),
  ],
  providers: [AppEventPublisher],
  exports: [AppEventPublisher, EventEmitterModule],
})
export class DomainEventsModule {}