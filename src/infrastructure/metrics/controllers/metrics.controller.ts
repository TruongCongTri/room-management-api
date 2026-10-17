/**
 * Cung cấp endpoint /metrics đạt chuẩn Prometheus / OpenMetrics.
 * Nằm ngoài API_PREFIX, không gắn version, không rate limit. Khi cổng HTTP lộ ra Internet,
 * đặt METRICS_BEARER_TOKEN để chỉ Prometheus (gửi Authorization: Bearer <token>) đọc được.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipEnvelope } from '../../../common/interceptors/skip-envelope.decorator';
import { SkipAllThrottles } from '../../../core/security/throttler/throttler.decorators';
import { AppConfigService } from '../../../core/config/app-config.service';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
@Public() // Prometheus Scraper không dùng JWT của người dùng
@SkipAllThrottles()
@SkipEnvelope()
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly config?: AppConfigService,
  ) {}

  @Get()
  getMetrics(@Req() req: Request, @Res() res: Response): void {
    const metrics = this.config?.metrics;
    if (metrics && !metrics.enabled) {
      throw new NotFoundException();
    }

    if (metrics?.bearerToken) {
      const provided = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!safeEqual(provided, metrics.bearerToken)) {
        throw new UnauthorizedException('Invalid metrics scrape token.');
      }
    }

    this.metricsService.handleMetricsScrape(req, res);
  }
}
