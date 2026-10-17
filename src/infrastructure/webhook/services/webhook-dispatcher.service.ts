/**
 * Phát webhook ra đối tác (Egress) có ký số HMAC:
 *  - dispatch(): gửi đồng bộ, retry ngắn trong request (AppHttpClient, Exponential Backoff + Jitter).
 *  - dispatchReliable(): đưa vào hàng đợi `webhook-dispatch-queue` → BullMQ retry dài hạn với backoff,
 *    kiệt sức → Dead-Letter Queue để đối soát. Không có Redis → gửi đồng bộ.
 * Thân request gửi đi chính là chuỗi đã ký (không để axios serialize lại → lệch chữ ký).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { AppHttpClient } from '../../http/client/app-http.client';
import { RequestContextService } from '../../../core/context/request-context.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { WebhookSigner } from '../security/webhook-signer';
import {
  WebhookDispatchJob,
  WebhookDispatchOptions,
  WebhookDispatchPayload,
  WebhookDispatchResult,
} from '../interfaces/webhook.interface';
import { WEBHOOK_CONSTANTS } from '../constants/webhook.constants';
import { QUEUE_NAMES } from '../../queue/constants/queue.constant';
import { BaseQueueProducer } from '../../queue/producers/base-queue.producer';

class WebhookQueueProducer extends BaseQueueProducer<WebhookDispatchJob> {}

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly producer?: WebhookQueueProducer;

  constructor(
    private readonly httpClient: AppHttpClient,
    private readonly contextService: RequestContextService,
    @Optional() private readonly config?: AppConfigService,
    @Optional() @InjectQueue(QUEUE_NAMES.WEBHOOK_DISPATCH) queue?: Queue,
  ) {
    if (queue) this.producer = new WebhookQueueProducer(queue, contextService);
  }

  /**
   * Ký số và phát Webhook ra bên ngoài với chữ ký bảo mật (đồng bộ)
   */
  async dispatch<T = any>(
    payload: WebhookDispatchPayload<T>,
    options: WebhookDispatchOptions,
  ): Promise<WebhookDispatchResult> {
    const webhookId = payload.id || randomUUID();
    const timestamp = payload.timestamp || Math.floor(Date.now() / 1000);

    const normalizedPayload = {
      ...payload,
      id: webhookId,
      timestamp,
      traceId: payload.traceId || this.contextService.getTraceId(),
      tenantId: payload.tenantId || this.contextService.getTenantId(),
    };

    const payloadString = JSON.stringify(normalizedPayload);
    const signature = WebhookSigner.sign(payloadString, options.secret, timestamp);

    const sigHeader = options.signatureHeader || WEBHOOK_CONSTANTS.DEFAULT_SIGNATURE_HEADER;
    const timeHeader = options.timestampHeader || WEBHOOK_CONSTANTS.DEFAULT_TIMESTAMP_HEADER;

    try {
      this.logger.debug(`[Webhook Egress] Dispatching event '${payload.event}' (${webhookId}) to ${options.url}`);

      await this.httpClient.post<unknown>(options.url, payloadString, {
        headers: {
          [sigHeader]: signature,
          [timeHeader]: String(timestamp),
          [WEBHOOK_CONSTANTS.DEFAULT_ID_HEADER]: webhookId,
          'Content-Type': 'application/json',
        },
        timeout: options.timeoutMs || this.config?.webhook.dispatchTimeoutMs || 10000,
        // Bên nhận loại bỏ trùng lặp theo x-webhook-id → an toàn để retry POST
        retry: {
          maxRetries: options.maxRetries ?? 3,
          initialDelayMs: 500,
          maxDelayMs: 3000,
          retryableStatuses: [408, 429, 500, 502, 503, 504],
          retryNonIdempotent: true,
        },
      });

      this.logger.log(`[Webhook Egress Success] Event '${payload.event}' (${webhookId}) delivered to ${options.url}`);
      return { success: true, statusCode: 200, deliveredAt: new Date().toISOString(), webhookId };
    } catch (err: any) {
      this.logger.error(
        `[Webhook Egress Failure] Failed delivering event '${payload.event}' (${webhookId}) to ${options.url}: ${err.message}`,
      );
      return {
        success: false,
        statusCode: err.response?.status,
        deliveredAt: new Date().toISOString(),
        webhookId,
        error: err.message,
      };
    }
  }

  /**
   * Gửi bền vững qua hàng đợi: đối tác sập nhiều giờ vẫn nhận được khi phục hồi (hoặc vào DLQ để đối soát).
   */
  async dispatchReliable<T = any>(
    payload: WebhookDispatchPayload<T>,
    options: WebhookDispatchOptions,
  ): Promise<WebhookDispatchResult> {
    const webhookId = payload.id || randomUUID();

    if (!this.producer) {
      return this.dispatch({ ...payload, id: webhookId }, options);
    }

    await this.producer.addJob(
      payload.event,
      { payload: { ...payload, id: webhookId }, options },
      {
        jobId: webhookId,
        attempts: this.config?.webhook.dispatchMaxAttempts ?? 8,
        backoff: { type: 'exponential', delay: 5000, jitter: 1 },
      },
    );
    return { success: true, queued: true, deliveredAt: new Date().toISOString(), webhookId };
  }
}
