/**
 * Triển khai NotificationChannelAdapter tích hợp API Zalo OA (tin tư vấn) thông qua AppHttpClient.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationChannelAdapter, RenderedPayload } from './notification-channel.interface';
import {
  NotificationChannel,
  NotificationRecipient,
  ChannelDeliveryResult,
} from '../interfaces/notification.interface';
import { AppHttpClient } from '../../http/client/app-http.client';
import { AppConfigService } from '../../../core/config/app-config.service';

const ZALO_OA_MESSAGE_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';

interface ZaloResponse {
  error: number;
  message: string;
  data?: { message_id?: string };
}

@Injectable()
export class ZaloChannel implements NotificationChannelAdapter {
  private readonly logger = new Logger(ZaloChannel.name);
  readonly channelType = NotificationChannel.ZALO;

  constructor(
    private readonly httpClient: AppHttpClient,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async send(recipient: NotificationRecipient, payload: RenderedPayload): Promise<ChannelDeliveryResult> {
    const targetUserId = recipient.zaloUserId;
    if (!targetUserId) {
      return { channel: this.channelType, success: false, error: 'Recipient zaloUserId is missing.' };
    }

    const zalo = this.config?.notification.zalo;
    if (!zalo) {
      return { channel: this.channelType, success: false, error: 'Zalo channel is not configured (ZALO_OA_ACCESS_TOKEN).' };
    }

    try {
      const response = await this.httpClient.post<ZaloResponse>(
        ZALO_OA_MESSAGE_ENDPOINT,
        { recipient: { user_id: targetUserId }, message: { text: payload.content } },
        { headers: { access_token: zalo.accessToken, 'Content-Type': 'application/json' }, skipTracePropagation: true },
      );

      // Zalo trả HTTP 200 kèm mã lỗi nghiệp vụ trong body
      if (response.error !== 0) {
        return { channel: this.channelType, success: false, error: `Zalo error ${response.error}: ${response.message}` };
      }
      return { channel: this.channelType, success: true, messageId: response.data?.message_id };
    } catch (err: any) {
      this.logger.error(`[ZaloChannel] Failed to send Zalo message: ${err.message}`);
      return { channel: this.channelType, success: false, error: err.message || 'Zalo API delivery failed' };
    }
  }
}
