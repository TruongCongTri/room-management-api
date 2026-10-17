/**
 * Ghi nhận metric HTTP ở tầng middleware (thay vì interceptor) để bao phủ cả các response
 * bị Guard chặn trước khi vào interceptor: 401 (JWT), 403 (Permissions), 429 (Rate limit).
 *
 * Chuẩn hóa nhãn route chống bùng nổ cardinality:
 *  - Dùng route pattern của Express (/api/v1/properties/rooms/:id) khi request khớp handler.
 *  - 404 không khớp route nào → nhãn cố định 'UNMATCHED' (bot quét /wp-admin/... không sinh nhãn mới).
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service';
import { METRICS_IGNORED_PATHS, UNMATCHED_ROUTE } from '../constants/metrics.constants';

const UUID_SEGMENT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** Nhãn route ổn định cho metric (không bao giờ chứa ID động) */
export function normalizeRouteLabel(req: Request, statusCode: number): string {
  if (req.route && typeof req.route.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  if (statusCode === 404) return UNMATCHED_ROUTE;

  const rawPath = req.originalUrl?.split('?')[0] || req.url || 'unknown';
  return rawPath.replace(UUID_SEGMENT, ':id').replace(/\/\d+(?=\/|$)/g, '/:id');
}

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metricsService: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl?.split('?')[0] ?? req.url;
    if (METRICS_IGNORED_PATHS.some((re) => re.test(path))) return next();

    const method = req.method.toUpperCase();
    const startTime = process.hrtime.bigint();
    this.metricsService.httpActiveRequests.add(1, { method });

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      this.metricsService.httpActiveRequests.add(-1, { method });

      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      // Client ngắt kết nối trước khi có response → 499 (quy ước của Nginx) thay vì 200 sai lệch
      const statusCode = res.writableFinished ? res.statusCode : 499;
      const labels = {
        method,
        route: normalizeRouteLabel(req, statusCode),
        status_code: String(statusCode),
      };

      this.metricsService.httpRequestDuration.record(durationSeconds, labels);
      this.metricsService.httpRequestsTotal.add(1, labels);
    };

    res.once('finish', record);
    res.once('close', record);
    next();
  }
}
