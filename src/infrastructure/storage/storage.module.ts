/**
 * Khởi tạo S3 Client tự động thích ứng giữa AWS S3, MinIO (local) và Supabase Storage (S3-compatible):
 *  - Không cấu hình access key → dùng credential provider chain của AWS (IAM Role / IRSA trên EKS).
 *  - Endpoint tùy biến → tắt checksum mặc định mới của SDK v3 (một số dịch vụ S3-compatible chưa hỗ trợ).
 */

import { Global, Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageService, S3_CLIENT } from './services/s3-storage.service';
import { AppConfigService } from '../../core/config/app-config.service';

@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const storage = config.storage;
        const customEndpoint = !!storage.endpoint;

        return new S3Client({
          region: storage.region,
          endpoint: storage.endpoint,
          forcePathStyle: storage.forcePathStyle,
          credentials:
            storage.accessKeyId && storage.secretAccessKey
              ? { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey }
              : undefined,
          ...(customEndpoint
            ? { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }
            : {}),
        });
      },
    },
    S3StorageService,
  ],
  exports: [S3StorageService],
})
export class StorageModule {}
