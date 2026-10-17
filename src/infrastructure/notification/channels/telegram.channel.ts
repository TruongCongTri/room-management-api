/**
 * Kênh Telegram Bot API (cảnh báo vận hành nội bộ, kênh hỗ trợ khách hàng).
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

const TELEGRAM_MAX_LENGTH = 4096;

@Injectable()
export class TelegramChannel implements NotificationChannelAdapter {
  private readonly logger = new Logger(TelegramChannel.name);
  readonly channelType = NotificationChannel.TELEGRAM;

  constructor(
    private readonly httpClient: AppHttpClient,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async send(recipient: NotificationRecipient, payload: RenderedPayload): Promise<ChannelDeliveryResult> {
    const telegram = this.config?.notification.telegram;
    if (!telegram) {
      return { channel: this.channelType, success: false, error: 'Telegram channel is not configured (TELEGRAM_BOT_TOKEN).' };
    }

    const chatId = recipient.telegramChatId || telegram.defaultChatId;
    if (!chatId) {
      return { channel: this.channelType, success: false, error: 'Telegram chatId is not configured.' };
    }

    const text = [payload.subject, payload.content].filter(Boolean).join('\n\n').slice(0, TELEGRAM_MAX_LENGTH);

    try {
      // skipTracePropagation: không gửi header nội bộ (x-building-id, traceparent) sang dịch vụ bên thứ ba
      const response = await this.httpClient.post<{ ok: boolean; result?: { message_id: number } }>(
        `https://api.telegram.org/bot${telegram.botToken}/sendMessage`,
        { chat_id: chatId, text, disable_web_page_preview: true },
        { skipTracePropagation: true },
      );
      return { channel: this.channelType, success: true, messageId: String(response.result?.message_id ?? '') };
    } catch (err: any) {
      // Không log URL gốc: chứa bot token
      this.logger.warn(`[TelegramChannel] Delivery failed: ${err.response?.status ?? err.code ?? 'error'}`);
      return { channel: this.channelType, success: false, error: `Telegram API error (${err.response?.status ?? err.code ?? 'network'})` };
    }
  }
}
