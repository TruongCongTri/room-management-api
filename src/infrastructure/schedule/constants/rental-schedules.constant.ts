/**
 * Lịch chạy định kỳ của nền tảng cho thuê (tài liệu 01, mục 6.2) - tính theo giờ Việt Nam.
 * Dùng với @DistributedCron(schedule.cron, schedule.lockKey, { timeZone: schedule.timeZone, ttlMs: schedule.ttlMs }).
 */
import { VN_BUSINESS_TIMEZONE } from '../../../common/constants/vn-rental.constant';

export interface RentalSchedule {
  cron: string;
  /** Khóa phân tán: chỉ một Pod thực thi */
  lockKey: string;
  timeZone: string;
  /** TTL khóa đủ dài cho cả lần chạy (watchdog vẫn gia hạn khi cần) */
  ttlMs: number;
  description: string;
}

const schedule = (cron: string, lockKey: string, ttlMs: number, description: string): RentalSchedule => ({
  cron,
  lockKey,
  timeZone: VN_BUSINESS_TIMEZONE,
  ttlMs,
  description,
});

export const RENTAL_SCHEDULES = {
  /** 00:00 ngày 28 hằng tháng: tính tiền điện nước + lập hóa đơn cho cả 80 phòng */
  MONTHLY_BILLING: schedule('0 0 28 * *', 'cron:monthly-billing', 30 * 60_000, 'Monthly utility billing & invoice compilation'),
  /** 08:00 hằng ngày: quét hóa đơn quá hạn và áp phí phạt chậm thanh toán theo hợp đồng */
  OVERDUE_INVOICES: schedule('0 8 * * *', 'cron:overdue-invoices', 10 * 60_000, 'Overdue invoice scan & late penalties'),
  /** 02:00 hằng ngày: hạn bảo hiểm cháy nổ / bình chữa cháy (PCCC) và hạn tạm trú CT01 */
  COMPLIANCE_EXPIRY: schedule('0 2 * * *', 'cron:compliance-expiry', 10 * 60_000, 'PCCC & residence (CT01) expiry check'),
  /** 03:00 Chủ nhật: lưu trữ audit > 90 ngày sang cold storage */
  AUDIT_TIERING: schedule('0 3 * * 0', 'cron:audit-tiering', 60 * 60_000, '90-day audit log archival'),
  /** 03:30 Chủ nhật: dọn outbox đã publish > 7 ngày */
  OUTBOX_CLEANUP: schedule('30 3 * * 0', 'cron:outbox-cleanup', 15 * 60_000, '7-day published outbox cleanup'),
} as const;
