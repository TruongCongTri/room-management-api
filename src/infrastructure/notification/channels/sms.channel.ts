/**
 * Kênh SMS (OTP, nhắc lịch bay) qua Twilio Messages REST API - không cần SDK, đi qua AppHttpClient
 * (timeout, mTLS, trace header, log đã che PII).
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

@Injectable()
export class SmsChannel implements NotificationChannelAdapter {
  private readonly logger = new Logger(SmsChannel.name);
  readonly channelType = NotificationChannel.SMS;

  constructor(
    private readonly httpClient: AppHttpClient,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async send(recipient: NotificationRecipient, payload: RenderedPayload): Promise<ChannelDeliveryResult> {
    if (!recipient.phone) {
      return { channel: this.channelType, success: false, error: 'Recipient phone number is missing.' };
    }

    const twilio = this.config?.notification.twilio;
    if (!twilio) {
      return { channel: this.channelType, success: false, error: 'SMS channel is not configured (TWILIO_*).' };
    }

    try {
      const response = await this.httpClient.post<{ sid: string }>(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`,
        new URLSearchParams({ To: recipient.phone, From: twilio.fromNumber, Body: payload.content }).toString(),
        {
          auth: { username: twilio.accountSid, password: twilio.authToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          // Không retry tự động: gửi trùng OTP gây nhầm lẫn và tốn phí
          retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
        },
      );
      return { channel: this.channelType, success: true, messageId: response.sid };
    } catch (err: any) {
      this.logger.warn(`[SmsChannel] Twilio delivery failed: ${err.message}`);
      return { channel: this.channelType, success: false, error: err.message };
    }
  }
}
