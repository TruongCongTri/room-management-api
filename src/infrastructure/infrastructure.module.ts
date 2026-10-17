import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { isEnvEnabled } from '../core/config/env-loader';
import { HttpClientModule } from './http/http.module';
import { TracingModule } from './tracing/tracing.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './cache/cache.module';
import { DistributedLockModule } from './lock/lock.module';
import { DomainEventsModule } from './events/events.module';
import { QueueModule } from './queue/queue.module';
import { AppScheduleModule } from './schedule/schedule.module';
import { StorageModule } from './storage/storage.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuditLogModule } from './audit/audit.module';
import { NotificationModule } from './notification/notification.module';
import { WebhookModule } from './webhook/webhook.module';
import { RealtimeWebSocketModule } from './websocket/websocket.module';
import { DocumentReportModule } from './document/document-report.module';

/**
 * Các dịch vụ hạ tầng kỹ thuật (plugins / drivers) dùng chung cho mọi module nghiệp vụ.
 *  - QueueModule (BullMQ) chỉ nạp khi REDIS_ENABLED=true; các module phụ thuộc tự fallback
 *    (Outbox → event bus nội bộ, Webhook → gửi đồng bộ).
 *  - WebSocket nạp theo WS_ENABLED.
 */
@Module({
  imports: [
    HttpClientModule,
    TracingModule,
    MetricsModule,
    HealthModule,
    CacheModule,
    DistributedLockModule,
    DomainEventsModule,
    ConditionalModule.registerWhen(QueueModule, (env) => isEnvEnabled(env.REDIS_ENABLED, true)),
    AppScheduleModule,
    StorageModule,
    OutboxModule,
    AuditLogModule,
    NotificationModule,
    WebhookModule,
    ConditionalModule.registerWhen(RealtimeWebSocketModule, (env) => isEnvEnabled(env.WS_ENABLED, true)),
    DocumentReportModule,
  ],
})
export class InfrastructureModule {}
