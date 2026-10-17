/**
 * Điều phối 2 Probe độc lập: Liveness (chỉ thăm dò tiến trình/RAM sống còn) và Readiness
 * (kiểm tra toàn bộ hạ tầng ngoại vi kèm chặn traffic khi tắt Pod).
 *
 * Đường dẫn cố định /health/* (nằm ngoài API_PREFIX, không gắn version) để cấu hình probe của K8s
 * không đổi khi API lên version mới; không bị rate limit và không yêu cầu JWT.
 */

import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from '../indicators/database.health';
import { RedisHealthIndicator } from '../indicators/redis.health';
import { StorageHealthIndicator } from '../indicators/storage.health';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipEnvelope } from '../../../common/interceptors/skip-envelope.decorator';
import { SkipAllThrottles } from '../../../core/security/throttler/throttler.decorators';
import { GracefulShutdownService } from '../../../core/shutdown/graceful-shutdown.service';
import { AppConfigService } from '../../../core/config/app-config.service';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
@Public()
@SkipAllThrottles()
@SkipEnvelope()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly dbIndicator: DatabaseHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly shutdownService: GracefulShutdownService,
    private readonly config: AppConfigService,
    private readonly storageIndicator: StorageHealthIndicator,
  ) {}

  /**
   * KUBERNETES LIVENESS PROBE:
   * Chỉ kiểm tra Event Loop của Node.js còn chạy và bộ nhớ Heap không bị tràn (OOM).
   * Tuyệt đối không kiểm tra DB/Redis tại đây để tránh Restart Storm dây chuyền.
   */
  @Get('liveness')
  @HealthCheck()
  checkLiveness() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', this.config.health.heapLimitBytes),
    ]);
  }

  /**
   * KUBERNETES READINESS PROBE:
   * Kiểm tra ứng dụng có sẵn sàng nhận traffic người dùng hay không.
   * Tự động trả về 503 khi Pod nhận SIGTERM để Ingress gỡ IP khỏi Load Balancer.
   */
  @Get('readiness')
  @HealthCheck()
  async checkReadiness() {
    // 1. Chốt chặn vòng đời: Nếu Pod đang trong tiến trình Graceful Shutdown, từ chối nhận traffic
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({
        status: 'SHUTTING_DOWN',
        message: 'Pod is currently shutting down and draining traffic.',
      });
    }

    const { diskPath, diskThresholdPercent, rssLimitBytes } = this.config.health;

    // 2. Kiểm tra sâu toàn bộ các tài nguyên hạ tầng bắt buộc
    return this.health.check([
      () => this.dbIndicator.isHealthy('database'),
      () => this.redisIndicator.isHealthy('redis'),
      () => this.storageIndicator.isHealthy('object_storage'),
      () => this.disk.checkStorage('storage_disk', { path: diskPath, thresholdPercent: diskThresholdPercent }),
      () => this.memory.checkRSS('memory_rss', rssLimitBytes),
    ]);
  }
}
