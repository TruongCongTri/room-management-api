/**
 * Kênh Email qua SMTP (Nodemailer): AWS SES SMTP, SendGrid, Mailgun, Gmail Workspace, Mailpit/MailHog local...
 * Bỏ trống SMTP_HOST → kênh báo "chưa cấu hình" (dispatcher dry-run vẫn hoạt động ngoài production).
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { NotificationChannelAdapter, RenderedPayload } from './notification-channel.interface';
import {
  NotificationChannel,
  NotificationRecipient,
  ChannelDeliveryResult,
} from '../interfaces/notification.interface';
import { AppConfigService } from '../../../core/config/app-config.service';

@Injectable()
export class EmailChannel implements NotificationChannelAdapter, OnModuleDestroy {
  private readonly logger = new Logger(EmailChannel.name);
  readonly channelType = NotificationChannel.EMAIL;
  private transporter?: Transporter;

  constructor(@Optional() private readonly config?: AppConfigService) {}

  onModuleDestroy(): void {
    this.transporter?.close();
  }

  private getTransporter(): Transporter | undefined {
    const smtp = this.config?.notification.smtp;
    if (!smtp) return undefined;
    this.transporter ??= createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure, // true: SMTPS 465; false: STARTTLS 587
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      pool: true,
      maxConnections: 5,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    return this.transporter;
  }

  async send(recipient: NotificationRecipient, payload: RenderedPayload): Promise<ChannelDeliveryResult> {
    if (!recipient.email) {
      return { channel: this.channelType, success: false, error: 'Recipient email address is missing.' };
    }

    const transporter = this.getTransporter();
    if (!transporter) {
      return { channel: this.channelType, success: false, error: 'Email channel is not configured (SMTP_HOST).' };
    }

    try {
      const info = await transporter.sendMail({
        from: this.config?.notification.mailFrom,
        to: recipient.name ? { name: recipient.name, address: recipient.email } : recipient.email,
        subject: payload.subject ?? '',
        html: payload.content,
        attachments: payload.attachments,
      });
      return { channel: this.channelType, success: true, messageId: info.messageId };
    } catch (err: any) {
      this.logger.warn(`[EmailChannel] SMTP delivery failed: ${err.message}`);
      return { channel: this.channelType, success: false, error: err.message };
    }
  }
}
