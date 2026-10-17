/**
 * Chống tấn công Path Traversal, file thực thi trá hình và kiến tạo đường dẫn cô lập theo từng tòa nhà:
 *
 */

import { randomUUID } from 'crypto';
import { extname, basename } from 'path';
import { FileVisibility } from '../interfaces/storage.interface';

/** Whitelist Content-Type → phần mở rộng hợp lệ tương ứng */
const ALLOWED_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  // Tờ khai thuế 01/BĐS, hồ sơ cư trú dạng bảng (chỉ do hệ thống sinh, không nhận upload từ client)
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

/** Content-Type client được phép upload qua Presigned PUT (ảnh đồng hồ, CCCD/hộ chiếu, hợp đồng đã ký) */
export const CLIENT_UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

/** Danh mục lưu trữ chuẩn (thư mục cấp 1 sau visibility) */
export const STORAGE_CATEGORIES = {
  METER_PHOTOS: 'meter-photos',
  IDENTITY_DOCUMENTS: 'identity-documents',
  SIGNED_CONTRACTS: 'contracts',
  CONTRACT_ADDENDA: 'contract-addenda',
  HANDOVER_MINUTES: 'handover-minutes',
  RESIDENCE_FORMS: 'residence-ct01',
  SETTLEMENTS: 'settlements',
  TAX_EXPORTS: 'tax-exports',
  ROOM_PHOTOS: 'room-photos',
} as const;

export class FileSanitizerUtil {
  /**
   * Làm sạch tên file, loại bỏ ký tự lạ và đường dẫn tương đối (Path Traversal defense)
   */
  static sanitizeFileName(rawName: string): string {
    // Chuẩn hóa cả dấu "\" (đường dẫn Windows) trước khi lấy basename
    const base = basename(rawName.replace(/\\/g, '/'));
    // Chỉ giữ lại chữ cái, số, dấu gạch ngang, gạch dưới và dấu chấm; không cho tên bắt đầu bằng '.'
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    return cleaned.slice(-150) || 'file';
  }

  /**
   * Kiểm tra Content-Type có nằm trong danh mục an toàn
   */
  static validateContentType(contentType: string): void {
    if (!ALLOWED_TYPES[contentType.toLowerCase()]) {
      throw new Error(`Content-Type '${contentType}' is not permitted for storage upload.`);
    }
  }

  /**
   * Ép phần mở rộng khớp Content-Type (chặn "invoice.pdf.exe", "avatar.php" khai báo image/png)
   */
  static assertExtensionMatchesContentType(fileName: string, contentType: string): void {
    FileSanitizerUtil.validateContentType(contentType);
    const extension = extname(FileSanitizerUtil.sanitizeFileName(fileName)).toLowerCase();
    if (!ALLOWED_TYPES[contentType.toLowerCase()].includes(extension)) {
      throw new Error(`File extension '${extension || '(none)'}' does not match Content-Type '${contentType}'.`);
    }
  }

  /**
   * Tạo Object Key có cấu trúc phân tầng thời gian và cô lập theo tòa nhà
   * Cấu trúc: buildings/{buildingId}/{visibility}/{category}/{YYYY}/{MM}/{uuid}_{sanitizedName}
   */
  static buildObjectKey(
    buildingId: string,
    visibility: FileVisibility,
    category: string,
    rawFileName: string,
  ): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    const safeBuilding = buildingId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeCategory = category.replace(/[^a-zA-Z0-9_-]/g, '_') || 'general';
    const cleanName = this.sanitizeFileName(rawFileName);
    return `buildings/${safeBuilding}/${visibility}/${safeCategory}/${year}/${month}/${randomUUID()}_${cleanName}`;
  }
}
