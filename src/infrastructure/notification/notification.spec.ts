/**
 * Tạo test suite kiểm tra:

Template Renderer: Phân giải biến lồng nhau ({{contract.code}}) và escape HTML[cite: 1].

Multi-Channel Routing: Gửi thông báo đến cả EMAIL và SMS trong cùng một lượt gọi[cite: 1].

Missing Recipient Handling: Báo lỗi chính xác ở kênh thiếu thông tin người nhận mà không ảnh hưởng kênh khác.

Channel Failure Isolation: Đảm bảo kết quả từ Promise.allSettled không làm gián đoạn toàn bộ request khi 1 kênh bị lỗi.
 * 
 * */ 


import { NotificationDispatcherService, maskRecipient } from './services/notification-dispatcher.service';
import { TemplateRendererService } from './templates/template-renderer.service';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { TelegramChannel } from './channels/telegram.channel';
import { ZaloChannel } from './channels/zalo.channel';
import { NotificationChannel } from './interfaces/notification.interface';
import { RequestContextService } from '../../core/context/request-context.service';

describe('NotificationModule (Enterprise Multi-Channel Suite)', () => {
  describe('TemplateRendererService', () => {
    let renderer: TemplateRendererService;

    beforeEach(() => {
      renderer = new TemplateRendererService();
    });

    it('should correctly render nested context variables and escape dangerous HTML', () => {
      const template = 'Xin chào {{user.name}}, mã của bạn: {{data.code}}';
      const context = {
        user: { name: '<script>alert("hack")</script>' },
        data: { code: 'BK-999' },
      };

      const rendered = renderer.render(template, context);

      expect(rendered).toContain('&lt;script&gt;');
      expect(rendered).not.toContain('<script>');
      expect(rendered).toContain('BK-999');
    });

    it('should render pre-registered templates by templateName', () => {
      const result = renderer.renderByTemplateName('OTP_VERIFICATION', {
        otp: '123456',
        expiresInMinutes: 5,
      });

      expect(result.subject).toBe('Mã xác thực OTP của bạn');
      expect(result.content).toBe('Mã OTP của bạn là: 123456. Mã có hiệu lực trong 5 phút.');
    });
  });

  describe('NotificationDispatcherService', () => {
    let dispatcher: NotificationDispatcherService;
    let emailChannel: jest.Mocked<EmailChannel>;
    let smsChannel: jest.Mocked<SmsChannel>;
    let telegramChannel: jest.Mocked<TelegramChannel>;
    let zaloChannel: jest.Mocked<ZaloChannel>;
    let contextService: RequestContextService;

    beforeEach(() => {
      contextService = new RequestContextService();
      jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-NOTIF-123');
      jest.spyOn(contextService, 'getTenantId').mockReturnValue('tenant_tokyo');

      emailChannel = {
        channelType: NotificationChannel.EMAIL,
        send: jest.fn().mockResolvedValue({
          channel: NotificationChannel.EMAIL,
          success: true,
          messageId: 'email_ok',
        }),
      } as unknown as jest.Mocked<EmailChannel>;

      smsChannel = {
        channelType: NotificationChannel.SMS,
        send: jest.fn().mockResolvedValue({
          channel: NotificationChannel.SMS,
          success: true,
          messageId: 'sms_ok',
        }),
      } as unknown as jest.Mocked<SmsChannel>;

      telegramChannel = {
        channelType: NotificationChannel.TELEGRAM,
        send: jest.fn().mockResolvedValue({
          channel: NotificationChannel.TELEGRAM,
          success: false,
          error: 'Connection timeout',
        }),
      } as unknown as jest.Mocked<TelegramChannel>;

      zaloChannel = {
        channelType: NotificationChannel.ZALO,
        send: jest.fn().mockResolvedValue({
          channel: NotificationChannel.ZALO,
          success: true,
          messageId: 'zalo_ok',
        }),
      } as unknown as jest.Mocked<ZaloChannel>;

      dispatcher = new NotificationDispatcherService(
        new TemplateRendererService(),
        contextService,
        emailChannel,
        smsChannel,
        telegramChannel,
        zaloChannel,
      );
    });

    it('should dispatch to multiple channels concurrently and isolate channel failure', async () => {
      const result = await dispatcher.dispatch({
        channels: [NotificationChannel.EMAIL, NotificationChannel.TELEGRAM],
        recipient: {
          email: 'resident@gmail.com',
          telegramChatId: 'chat_888',
        },
        payload: {
          subject: 'Room Status',
          content: 'Room is on time.',
        },
      });

      expect(emailChannel.send).toHaveBeenCalledTimes(1);
      expect(telegramChannel.send).toHaveBeenCalledTimes(1);

      // Email thành công, Telegram thất bại nhưng không quăng unhandled error
      expect(result.success).toBe(false);
      expect(result.results).toEqual([
        { channel: NotificationChannel.EMAIL, success: true, messageId: 'email_ok' },
        { channel: NotificationChannel.TELEGRAM, success: false, error: 'Connection timeout' },
      ]);
    });

    it('should successfully dispatch messages to ZALO channel', async () => {
    const result = await dispatcher.dispatch({
      channels: [NotificationChannel.ZALO],
      recipient: {
        zaloUserId: 'zalo_user_999888',
      },
      payload: {
        content: 'Mã xác thực Zalo OTP của bạn là: 123456',
      },
    });

    expect(zaloChannel.send).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.results[0]).toEqual({
      channel: NotificationChannel.ZALO,
      success: true,
      messageId: 'zalo_ok',
    });
  });
  });

  
  describe('Dry-run, masking & provider channels', () => {
    it('should not call providers in dry-run mode but still report per-channel results', async () => {
      const contextService = new RequestContextService();
      const email = { channelType: NotificationChannel.EMAIL, send: jest.fn() } as any;
      const dispatcher = new NotificationDispatcherService(
        new TemplateRendererService(),
        contextService,
        email,
        { channelType: NotificationChannel.SMS, send: jest.fn() } as any,
        { channelType: NotificationChannel.TELEGRAM, send: jest.fn() } as any,
        { channelType: NotificationChannel.ZALO, send: jest.fn() } as any,
        { notification: { dryRun: true } } as any,
      );

      const result = await dispatcher.dispatch({
        channels: [NotificationChannel.EMAIL],
        recipient: { email: 'resident@gmail.com' },
        payload: { subject: 'Hóa đơn tháng 10', content: 'INV-2026-10-P302' },
      });

      expect(email.send).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.results[0].messageId).toMatch(/^dry-run-email-/);
    });

    it('should mask recipient PII before logging', () => {
      expect(maskRecipient({ email: 'resident@gmail.com', phone: '0981234321', zaloUserId: 'z1' })).toEqual({
        email: 're***@gmail.com',
        phone: '098****321',
        zaloUserId: '***PROTECTED***',
      });
    });

    it('should report unconfigured provider channels instead of pretending success', async () => {
      const http = { post: jest.fn() } as any;
      const result = await new TelegramChannel(http, { notification: {} } as any).send(
        { telegramChatId: '1' },
        { content: 'alert' },
      );
      expect(result).toEqual(expect.objectContaining({ success: false }));
      expect(http.post).not.toHaveBeenCalled();
    });

    it('should treat Zalo business error codes in a 200 response as failures', async () => {
      const http = { post: jest.fn().mockResolvedValue({ error: -216, message: 'Access token is invalid' }) } as any;
      const zalo = new ZaloChannel(http, { notification: { zalo: { accessToken: 'tok' } } } as any);

      const result = await zalo.send({ zaloUserId: 'u1' }, { content: 'OTP 123456' });

      expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('-216') }));
    });
  });
});
