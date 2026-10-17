import { Global, Module } from '@nestjs/common';
import { TemplateRendererService } from './templates/template-renderer.service';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { TelegramChannel } from './channels/telegram.channel';
import { NotificationDispatcherService } from './services/notification-dispatcher.service';
import { ZaloChannel } from './channels/zalo.channel';

@Global()
@Module({
  providers: [
    TemplateRendererService,
    EmailChannel,
    SmsChannel,
    TelegramChannel,
    ZaloChannel,
    NotificationDispatcherService,
  ],
  exports: [NotificationDispatcherService, TemplateRendererService],
})
export class NotificationModule {}
