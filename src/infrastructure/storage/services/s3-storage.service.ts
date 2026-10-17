/**
 * Dịch vụ lưu trữ đối tượng toàn diện: tích hợp AWS SDK v3, tương thích AWS S3, MinIO và Supabase Storage (S3),
 * tạo Presigned Put/Get URL, thao tác buffer trực tiếp và ghi archive cho cold tier.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import {
  ArchiveObjectOptions,
  FileVisibility,
  PresignedUploadRequest,
  PresignedUploadResponse,
  PresignedDownloadOptions,
  UploadBufferOptions,
} from '../interfaces/storage.interface';
import { FileSanitizerUtil } from '../utils/file-sanitizer.util';
import { buildPublicObjectUrl, PublicUrlSettings } from './storage-url.signer';

export const S3_CLIENT = 'S3_CLIENT';

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly enabled: boolean;
  private readonly bucketName: string;
  private readonly coldBucketName: string;
  private readonly urlSettings: PublicUrlSettings;
  private readonly uploadTtlSeconds: number;
  private readonly downloadTtlSeconds: number;
  private readonly maxUploadBytes: number;

  constructor(
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    // Token tường minh: kiểu union `| undefined` được emit thành `Object` → Nest không resolve được
    // và @Optional() âm thầm inject undefined (bỏ qua toàn bộ cấu hình STORAGE_*)
    @Optional() @Inject(AppConfigService) configService: AppConfigService | undefined,
    private readonly contextService: RequestContextService,
  ) {
    const storage = configService?.storage;
    this.enabled = storage?.enabled ?? true;
    this.bucketName = storage?.bucket ?? 'room-management';
    this.coldBucketName = storage?.coldBucket ?? this.bucketName;
    this.uploadTtlSeconds = storage?.uploadUrlTtlSeconds ?? 900;
    this.downloadTtlSeconds = storage?.downloadUrlTtlSeconds ?? 300;
    this.maxUploadBytes = storage?.maxUploadBytes ?? 10 * 1024 * 1024;
    this.urlSettings = {
      bucket: this.bucketName,
      region: storage?.region ?? 'ap-southeast-1',
      endpoint: storage?.endpoint,
      forcePathStyle: storage?.forcePathStyle,
      publicBaseUrl: storage?.publicBaseUrl,
    };
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Object storage is disabled (STORAGE_ENABLED=false).');
    }
  }

  /**
   * Tạo Presigned URL để Client đẩy trực tiếp lên Cloud (Tiết kiệm RAM/Băng thông)
   */
  async generatePresignedUploadUrl(request: PresignedUploadRequest): Promise<PresignedUploadResponse> {
    this.assertEnabled();
    try {
      FileSanitizerUtil.assertExtensionMatchesContentType(request.fileName, request.contentType);
      if (request.contentLength !== undefined && (request.contentLength <= 0 || request.contentLength > this.maxUploadBytes)) {
        throw new Error(`File size must be between 1 byte and ${this.maxUploadBytes} bytes.`);
      }

      const tenantId = this.contextService.getTenantId() || 'global';
      const visibility = request.visibility || FileVisibility.PRIVATE;
      const category = request.category || 'general';
      const expiresIn = request.expiresInSeconds || this.uploadTtlSeconds;

      const fileKey = FileSanitizerUtil.buildObjectKey(tenantId, visibility, category, request.fileName);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        ContentType: request.contentType,
        // Ký kích thước vào URL: S3 từ chối upload có Content-Length khác (chặn file khổng lồ)
        ContentLength: request.contentLength,
        Metadata: {
          tenantId,
          visibility,
          uploadedBy: this.contextService.getUserId() || 'ANONYMOUS',
          traceId: this.contextService.getTraceId(),
        },
      });

      const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn });

      this.logger.debug(`[Storage] Generated Presigned Upload URL for Key: '${fileKey}'`);

      return {
        uploadUrl,
        fileKey,
        publicUrl: visibility === FileVisibility.PUBLIC ? buildPublicObjectUrl(this.urlSettings, fileKey) : undefined,
        expiresInSeconds: expiresIn,
        requiredHeaders: {
          'Content-Type': request.contentType,
          ...(request.contentLength !== undefined ? { 'Content-Length': String(request.contentLength) } : {}),
        },
      };
    } catch (err: any) {
      this.logger.error(`Failed to generate upload URL: ${err.message}`);
      throw new BadRequestException(err.message);
    }
  }

  /**
   * Tạo Presigned Download URL có chữ ký số để tải tài liệu Private nhạy cảm
   */
  async generatePresignedDownloadUrl(fileKey: string, options: PresignedDownloadOptions = {}): Promise<string> {
    this.assertEnabled();
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
      ResponseContentDisposition: options.responseContentDisposition,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: options.expiresInSeconds || this.downloadTtlSeconds });
  }

  /**
   * Tải trực tiếp Buffer lên S3 (Dành cho background workers xuất PDF/Excel)
   */
  async uploadBuffer(
    buffer: Buffer,
    fileName: string,
    options: UploadBufferOptions,
  ): Promise<{ fileKey: string; publicUrl?: string }> {
    this.assertEnabled();
    FileSanitizerUtil.assertExtensionMatchesContentType(fileName, options.contentType);

    const tenantId = this.contextService.getTenantId() || 'global';
    const visibility = options.visibility || FileVisibility.PRIVATE;
    const category = options.category || 'reports';
    const fileKey = FileSanitizerUtil.buildObjectKey(tenantId, visibility, category, fileName);

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: buffer,
        ContentType: options.contentType,
        Metadata: {
          tenantId,
          visibility,
          uploadedBy: this.contextService.getUserId() || 'SYSTEM_WORKER',
          traceId: this.contextService.getTraceId(),
        },
      }),
    );

    return {
      fileKey,
      publicUrl: visibility === FileVisibility.PUBLIC ? buildPublicObjectUrl(this.urlSettings, fileKey) : undefined,
    };
  }

  /**
   * Ghi đối tượng archive với KEY TẤT ĐỊNH vào bucket cold tier (audit tiering, export đối soát).
   * Chạy lại cùng key chỉ ghi đè → an toàn khi retry sau sự cố.
   */
  async putArchiveObject(key: string, body: Buffer, options: ArchiveObjectOptions): Promise<void> {
    this.assertEnabled();
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.coldBucketName,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentEncoding: options.contentEncoding,
        Metadata: options.metadata,
      }),
    );
  }

  /**
   * Xóa vĩnh viễn đối tượng khỏi S3 / MinIO
   */
  async deleteFile(fileKey: string): Promise<void> {
    this.assertEnabled();
    await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileKey }));
    this.logger.debug(`[Storage] Deleted Object Key: '${fileKey}'`);
  }

  /** STORAGE_ENABLED: readiness bỏ qua kiểm tra bucket khi tắt */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Kiểm tra bucket truy cập được (HeadBucket) - dùng cho readiness probe
   */
  async pingBucket(): Promise<void> {
    this.assertEnabled();
    await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
  }

  /**
   * Kiểm tra sự tồn tại của tệp tin trên Bucket
   */
  async exists(fileKey: string): Promise<boolean> {
    this.assertEnabled();
    try {
      await this.s3Client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: fileKey }));
      return true;
    } catch {
      return false;
    }
  }
}
