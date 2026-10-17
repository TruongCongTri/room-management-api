/**
 * Kiểm tra bucket S3 / MinIO truy cập được (HeadBucket, kèm đo độ trễ) - nơi lưu ảnh đồng hồ của bảo vệ,
 * hợp đồng đã ký và giấy tờ tùy thân. STORAGE_ENABLED=false → báo 'up' kèm mode=disabled.
 */
import { Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { S3StorageService } from '../../storage/services/s3-storage.service';

const HEAD_BUCKET_TIMEOUT_MS = 3000;

@Injectable()
export class StorageHealthIndicator {
  constructor(@Optional() private readonly storage?: S3StorageService) {}

  async isHealthy(key = 'object_storage'): Promise<HealthIndicatorResult> {
    if (!this.storage?.isEnabled) {
      return { [key]: { status: 'up', mode: 'disabled' } };
    }

    const startTime = Date.now();
    try {
      await Promise.race([
        this.storage.pingBucket(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`HeadBucket timed out after ${HEAD_BUCKET_TIMEOUT_MS}ms`)),
            HEAD_BUCKET_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
      return { [key]: { status: 'up', latencyMs: Date.now() - startTime } };
    } catch (err: any) {
      return { [key]: { status: 'down', message: err.message, latencyMs: Date.now() - startTime } };
    }
  }
}
