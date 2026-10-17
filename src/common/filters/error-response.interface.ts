/**
 * Khung định dạng phản hồi lỗi thống nhất toàn hệ thống:
 * Envelope nội bộ (success/statusCode/errorCode/traceId) kết hợp các trường RFC 7807 / RFC 9457
 * (type, title, status, detail, instance), Content-Type: application/problem+json.
 *
 * */

import { SystemErrorCode } from '../constants/error-codes.constant';

export interface ApiErrorResponse {
  // RFC 7807 Problem Details
  type: string;
  title: string;
  status: number;
  /** Mô tả kỹ thuật dành cho developer (không bản địa hóa) */
  detail?: string;
  instance: string;

  // Envelope chuẩn của hệ thống
  success: false;
  statusCode: number;
  errorCode: SystemErrorCode | string;
  /** Thông điệp hiển thị cho người dùng (đã bản địa hóa theo Accept-Language nếu có bản dịch) */
  message: string;
  details?: Record<string, any> | Array<any> | string;
  timestamp: string;
  path: string;
  traceId: string;
  stack?: string; // Chỉ xuất hiện trong môi trường Development/Test
}
