/**
 * Khai báo phân quyền hiển thị, tham số Presigned URL và cấu trúc metadata:
 *
 */

export enum FileVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export interface PresignedUploadRequest {
  fileName: string;
  contentType: string;
  category?: string; // Xem STORAGE_CATEGORIES: 'meter-photos', 'identity-documents', 'contracts'...
  visibility?: FileVisibility;
  /**
   * Kích thước file chính xác (byte). Được ký vào URL (Content-Length) → S3 từ chối file có kích thước khác.
   * Phải <= STORAGE_MAX_UPLOAD_BYTES.
   */
  contentLength?: number;
  expiresInSeconds?: number; // Mặc định: STORAGE_UPLOAD_URL_TTL_SECONDS (900s)
}

export interface PresignedUploadResponse {
  uploadUrl: string; // URL để Client gửi lệnh HTTP PUT
  fileKey: string; // Khóa đối tượng dùng để lưu vào Database
  publicUrl?: string; // Trả về nếu visibility là PUBLIC
  expiresInSeconds: number;
  /** Header client BẮT BUỘC gửi kèm khi PUT (khớp chữ ký) */
  requiredHeaders: Record<string, string>;
}

export interface PresignedDownloadOptions {
  expiresInSeconds?: number; // Mặc định: STORAGE_DOWNLOAD_URL_TTL_SECONDS (300s)
  responseContentDisposition?: string; // Gợi ý tên file khi tải về
}

export interface UploadBufferOptions {
  contentType: string;
  category?: string;
  visibility?: FileVisibility;
}

export interface ArchiveObjectOptions {
  contentType: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
}
