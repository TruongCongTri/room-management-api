/**
 * Biên dịch nội dung mẫu an toàn, hỗ trợ truy xuất biến lồng nhau ({{invoice.totalAmount}}) và tự động escape HTML.
 * Mẫu mặc định phục vụ vận hành cho thuê: hóa đơn tháng (Zalo ZNS kèm VietQR), hợp đồng & thanh lý cọc (Email),
 * OTP (SMS) và cảnh báo nội bộ cho quản lý (Telegram).
 */

import { Injectable } from '@nestjs/common';

export const NOTIFICATION_TEMPLATES = {
  OTP_VERIFICATION: 'OTP_VERIFICATION',
  ACCOUNT_INVITATION: 'ACCOUNT_INVITATION',
  SECURITY_ALERT: 'SECURITY_ALERT',
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  INVOICE_OVERDUE: 'INVOICE_OVERDUE',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  CONTRACT_ACTIVATED: 'CONTRACT_ACTIVATED',
  CHECKOUT_SETTLED: 'CHECKOUT_SETTLED',
  PRIMARY_HOLDER_CHANGED: 'PRIMARY_HOLDER_CHANGED',
  RESIDENCE_ACTIONS_PENDING: 'RESIDENCE_ACTIONS_PENDING',
  METER_READINGS_MISSING: 'METER_READINGS_MISSING',
  METER_ANOMALY_ALERT: 'METER_ANOMALY_ALERT',
  COMPLIANCE_EXPIRY_ALERT: 'COMPLIANCE_EXPIRY_ALERT',
} as const;

const T = NOTIFICATION_TEMPLATES;

@Injectable()
export class TemplateRendererService {
  private readonly templateRegistry = new Map<string, { subject?: string; template: string }>();

  constructor() {
    // SMS
    this.registerTemplate(T.OTP_VERIFICATION, {
      subject: 'Mã xác thực OTP của bạn',
      template: 'Mã OTP của bạn là: {{otp}}. Mã có hiệu lực trong {{expiresInMinutes}} phút.',
    });
    this.registerTemplate(T.ACCOUNT_INVITATION, {
      subject: 'Tài khoản quản lý tòa nhà của bạn đã được tạo',
      template:
        'Chào {{user.name}}, tài khoản {{user.roleLabel}} của bạn đã được tạo. ' +
        'Mở ứng dụng, chọn "Kích hoạt tài khoản" và nhập số điện thoại này để nhận mã OTP, sau đó đặt mật khẩu.',
    });
    this.registerTemplate(T.SECURITY_ALERT, {
      subject: 'Cảnh báo bảo mật tài khoản',
      template: 'Cảnh báo bảo mật: {{alert.message}} lúc {{alert.occurredAt}}. Nếu không phải bạn, hãy đổi mật khẩu ngay.',
    });

    // Zalo ZNS / Email - khách thuê
    this.registerTemplate(T.INVOICE_ISSUED, {
      subject: 'Hóa đơn tiền phòng tháng {{invoice.billingMonth}} - Phòng {{room.number}}',
      template:
        'Chào {{tenant.name}}, hóa đơn tháng {{invoice.billingMonth}} phòng {{room.number}} là {{invoice.totalAmount}} VND ' +
        '(tiền phòng {{invoice.rentAmount}}, điện {{invoice.powerAmount}}, nước {{invoice.waterAmount}}, dịch vụ {{invoice.serviceAmount}}). ' +
        'Hạn thanh toán: {{invoice.dueDate}}. Quét mã VietQR: {{invoice.vietQrUrl}}',
    });
    this.registerTemplate(T.INVOICE_OVERDUE, {
      subject: 'Nhắc thanh toán hóa đơn quá hạn - Phòng {{room.number}}',
      template:
        'Chào {{tenant.name}}, hóa đơn tháng {{invoice.billingMonth}} ({{invoice.totalAmount}} VND) đã quá hạn {{invoice.overdueDays}} ngày. ' +
        'Phí phạt theo hợp đồng: {{invoice.penaltyAmount}} VND. Vui lòng thanh toán qua VietQR: {{invoice.vietQrUrl}}',
    });
    this.registerTemplate(T.PAYMENT_RECEIVED, {
      subject: 'Xác nhận đã nhận thanh toán - Phòng {{room.number}}',
      template: 'Đã nhận {{payment.amount}} VND cho hóa đơn tháng {{invoice.billingMonth}} lúc {{payment.paidAt}}. Cảm ơn bạn!',
    });
    this.registerTemplate(T.CONTRACT_ACTIVATED, {
      subject: 'Hợp đồng thuê phòng {{room.number}} đã có hiệu lực',
      template:
        'Chào {{tenant.name}}, hợp đồng {{contract.code}} phòng {{room.number}} có hiệu lực từ {{contract.startDate}}. ' +
        'Tiền cọc đã nhận: {{contract.depositAmount}} VND. Tải hợp đồng & biên bản bàn giao: {{contract.documentUrl}}',
    });
    this.registerTemplate(T.CHECKOUT_SETTLED, {
      subject: 'Biên bản thanh lý hợp đồng - Phòng {{room.number}}',
      template:
        'Chào {{tenant.name}}, quyết toán trả phòng {{room.number}} ngày {{settlement.checkoutDate}}: ' +
        '{{settlement.resultLabel}} {{settlement.netAmount}} VND. Xem biên bản: {{settlement.documentUrl}}',
    });

    this.registerTemplate(T.PRIMARY_HOLDER_CHANGED, {
      subject: 'Thay đổi người đứng tên hợp đồng - Phòng {{room.number}}',
      template:
        'Từ ngày {{transfer.effectiveDate}}, {{transfer.newHolderName}} là người đứng tên hợp đồng {{contract.code}} ' +
        'phòng {{room.number}} (thay {{transfer.previousHolderName}}). Hóa đơn từ kỳ tới sẽ gửi cho người đứng tên mới. ' +
        'Phụ lục hợp đồng: {{transfer.addendumUrl}}',
    });

    // Telegram - cảnh báo nội bộ cho quản lý tòa nhà
    this.registerTemplate(T.RESIDENCE_ACTIONS_PENDING, {
      template:
        '[{{building.name}}] Cư trú cần xử lý: {{declarationCount}} người cần khai báo tạm trú (CT01), ' +
        '{{deregistrationCount}} người cần xóa đăng ký tạm trú. Phòng: {{roomNumbers}}',
    });
    this.registerTemplate(T.METER_READINGS_MISSING, {
      template:
        '[{{building.name}}] Kỳ {{billingMonth}} còn {{missingCount}} phòng đang ở chưa có ảnh/chỉ số điện nước: {{roomNumbers}}',
    });
    this.registerTemplate(T.METER_ANOMALY_ALERT, {
      template:
        '[{{building.name}}] Phòng {{room.number}}: chỉ số bất thường ({{reading.type}} {{reading.consumption}}, ' +
        'trung bình {{reading.average}}). Người ghi: {{reading.recordedBy}}. Cần kiểm tra/duyệt reset đồng hồ.',
    });
    this.registerTemplate(T.COMPLIANCE_EXPIRY_ALERT, {
      template: '[{{building.name}}] {{compliance.itemLabel}} sẽ hết hạn ngày {{compliance.expiresAt}} ({{compliance.daysLeft}} ngày).',
    });
  }

  registerTemplate(name: string, config: { subject?: string; template: string }): void {
    this.templateRegistry.set(name, config);
  }

  /**
   * Biên dịch template với dữ liệu context (hỗ trợ nested properties)
   */
  render(templateStr: string, context: Record<string, any> = {}): string {
    return templateStr.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
      const val = this.resolvePath(context, path);
      if (val === undefined || val === null) {
        return '';
      }
      return this.escapeHtml(String(val));
    });
  }

  renderByTemplateName(
    templateName: string,
    context: Record<string, any> = {},
  ): { subject?: string; content: string } {
    const record = this.templateRegistry.get(templateName);
    if (!record) {
      throw new Error(`Notification template '${templateName}' not found in registry.`);
    }

    const subject = record.subject ? this.render(record.subject, context) : undefined;
    const content = this.render(record.template, context);

    return { subject, content };
  }

  private resolvePath(obj: any, path: string): any {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
