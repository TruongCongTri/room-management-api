/**
 * Bộ điều phối trung tâm: Biên dịch template, điều phối song song đa kênh qua Promise.allSettled,
 * và che giấu thông tin người nhận trong log.
 * NOTIFICATION_DRY_RUN (mặc định bật ngoài production): chỉ ghi log đã che PII, không gửi thật.
 *
 * */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  SendNotificationOptions,
  NotificationDispatchResult,
  ChannelDeliveryResult,
  NotificationChannel,
  NotificationRecipient,
} from '../interfaces/notification.interface';
import { NotificationChannelAdapter, RenderedPayload } from '../channels/notification-channel.interface';
import { TemplateRendererService } from '../templates/template-renderer.service';
import { EmailChannel } from '../channels/email.channel';
import { SmsChannel } from '../channels/sms.channel';
import { TelegramChannel } from '../channels/telegram.channel';
import { ZaloChannel } from '../channels/zalo.channel';
import { RequestContextService } from '../../../core/context/request-context.service';
import { AppConfigService } from '../../../core/config/app-config.service';

/** Che thông tin người nhận: tr***@gmail.com, 098****321 */
export function maskRecipient(recipient: NotificationRecipient): Record<string, string> {
  const masked: Record<string, string> = {};
  if (recipient.email) {
    const [user, domain] = recipient.email.split('@');
    masked.email = `${user.slice(0, 2)}***@${domain ?? ''}`;
  }
  if (recipient.phone) {
    masked.phone = recipient.phone.replace(/(\+?\d{3})\d+(\d{3})/, '$1****$2');
  }
  if (recipient.telegramChatId) masked.telegramChatId = '***PROTECTED***';
  if (recipient.zaloUserId) masked.zaloUserId = '***PROTECTED***';
  if (recipient.deviceTokens?.length) masked.deviceTokens = `${recipient.deviceTokens.length} token(s)`;
  return masked;
}

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private readonly channelMap = new Map<NotificationChannel, NotificationChannelAdapter>();
  private readonly dryRun: boolean;

  constructor(
    private readonly templateRenderer: TemplateRendererService,
    private readonly contextService: RequestContextService,
    emailChannel: EmailChannel,
    smsChannel: SmsChannel,
    telegramChannel: TelegramChannel,
    zaloChannel: ZaloChannel,
    @Optional() config?: AppConfigService,
  ) {
    this.channelMap.set(NotificationChannel.EMAIL, emailChannel);
    this.channelMap.set(NotificationChannel.SMS, smsChannel);
    this.channelMap.set(NotificationChannel.TELEGRAM, telegramChannel);
    this.channelMap.set(NotificationChannel.ZALO, zaloChannel);
    this.dryRun = config?.notification.dryRun ?? false;
  }

  /** Đăng ký thêm kênh (vd: PUSH qua Firebase Admin) từ module nghiệp vụ */
  registerChannel(adapter: NotificationChannelAdapter): void {
    this.channelMap.set(adapter.channelType, adapter);
  }

  /**
   * Điều phối gửi thông báo đa kênh đồng thời có cô lập lỗi
   */
  async dispatch(options: SendNotificationOptions): Promise<NotificationDispatchResult> {
    const traceId = this.contextService.getTraceId();
    const tenantId = this.contextService.getTenantId();

    // 1. Biên dịch nội dung thông báo qua Template Engine
    let rendered: RenderedPayload;
    if (options.payload.templateName) {
      const renderedTemplate = this.templateRenderer.renderByTemplateName(
        options.payload.templateName,
        options.payload.context,
      );
      rendered = {
        subject: options.payload.subject || renderedTemplate.subject,
        content: renderedTemplate.content,
        attachments: options.payload.attachments,
      };
    } else {
      rendered = {
        subject: options.payload.subject,
        content: options.payload.content || '',
        attachments: options.payload.attachments,
      };
    }

    const deliveryTasks = options.channels.map(async (channelType): Promise<ChannelDeliveryResult> => {
      const adapter = this.channelMap.get(channelType);
      if (!adapter) {
        return { channel: channelType, success: false, error: `Channel adapter '${channelType}' is not registered.` };
      }
      if (this.dryRun) {
        return { channel: channelType, success: true, messageId: `dry-run-${channelType.toLowerCase()}-${Date.now()}` };
      }
      return adapter.send(options.recipient, rendered);
    });

    // 2. Chạy độc lập các kênh bằng Promise.allSettled để tránh sập dây chuyền
    const settledResults = await Promise.allSettled(deliveryTasks);

    const finalResults: ChannelDeliveryResult[] = settledResults.map((res, index) =>
      res.status === 'fulfilled'
        ? res.value
        : {
            channel: options.channels[index],
            success: false,
            error: res.reason?.message || 'Unknown channel execution failure.',
          },
    );

    const isAllSuccessful = finalResults.every((r) => r.success);

    // 3. Ghi log kiểm soát với thông tin người nhận đã được che giấu
    this.logger.log(
      {
        event: 'NOTIFICATION_DISPATCH_COMPLETED',
        traceId,
        tenantId,
        dryRun: this.dryRun,
        recipient: maskRecipient(options.recipient),
        channels: options.channels,
        overallSuccess: isAllSuccessful,
        details: finalResults,
      },
      NotificationDispatcherService.name,
    );

    return { success: isAllSuccessful, results: finalResults };
  }
}
