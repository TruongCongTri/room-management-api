import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { AppTracerService } from './services/app-tracer.service';
import { TracePropagatorService } from './services/trace-propagator.service';
import { getTracerProvider, shutdownTracing } from './otel.bootstrap';
import { ShutdownRegistry } from '../../core/shutdown/shutdown.registry';
import { ShutdownPhase } from '../../core/shutdown/shutdown.interface';

/** Pha 4 Graceful Shutdown: đẩy hết span trong buffer về backend trước khi process thoát */
@Injectable()
class TracingLifecycle implements OnModuleInit {
  private readonly logger = new Logger('Tracing');

  constructor(private readonly shutdownRegistry: ShutdownRegistry) {}

  onModuleInit(): void {
    if (!getTracerProvider()) return;
    this.logger.log('OpenTelemetry tracing is enabled (W3C TraceContext, OTLP/HTTP exporter).');
    this.shutdownRegistry.register('OpenTelemetryFlush', ShutdownPhase.FLUSH_BUFFERS, () => shutdownTracing(), 20);
  }
}

@Global()
@Module({
  providers: [AppTracerService, TracePropagatorService, TracingLifecycle],
  exports: [AppTracerService, TracePropagatorService],
})
export class TracingModule {}
