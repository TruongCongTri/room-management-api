/**
 * Tạo test suite kiểm tra:
 *  MetricsService: Khởi tạo instrument OpenTelemetry (buckets theo giây) và runtime metrics.
 *  HttpMetricsMiddleware: ghi nhận cả response bị Guard chặn (401/429), chuẩn hóa route (:id),
 *  gom 404 không khớp route vào nhãn UNMATCHED (chống High Cardinality).
 *  MetricsController: ủy quyền cho Prometheus exporter, bảo vệ bằng bearer token tùy chọn.
 * */
import { EventEmitter } from 'events';
import { UnauthorizedException } from '@nestjs/common';
import { MetricsService } from './services/metrics.service';
import { HttpMetricsMiddleware, normalizeRouteLabel } from './middleware/http-metrics.middleware';
import { MetricsController } from './controllers/metrics.controller';
import { UNMATCHED_ROUTE } from './constants/metrics.constants';

function createResponse(statusCode: number) {
  const res: any = new EventEmitter();
  res.statusCode = statusCode;
  res.writableFinished = true;
  return res;
}

describe('MetricsModule (Enterprise OpenTelemetry Suite)', () => {
  let metricsService: MetricsService;

  beforeEach(() => {
    metricsService = new MetricsService();
    metricsService.onModuleInit();
  });

  afterEach(async () => {
    await metricsService.onApplicationShutdown();
  });

  // Xuất dữ liệu thật qua Prometheus exporter được kiểm chứng ở test/supporting-modules.e2e-spec.ts (GET /metrics)

  describe('Route normalization (Cardinality Protection)', () => {
    it('should prefer the Express route pattern when the request matched a handler', () => {
      const req: any = { route: { path: '/api/v1/contracts/:id' }, baseUrl: '' };
      expect(normalizeRouteLabel(req, 200)).toBe('/api/v1/contracts/:id');
    });

    it('should collapse unmatched 404 paths into a single label', () => {
      const req: any = { originalUrl: '/wp-admin/setup-config.php' };
      expect(normalizeRouteLabel(req, 404)).toBe(UNMATCHED_ROUTE);
    });

    it('should replace UUID and numeric segments with :id as a last resort', () => {
      const req: any = { originalUrl: '/api/v1/rooms/123e4567-e89b-42d3-a456-426614174000/legs/42?x=1' };
      expect(normalizeRouteLabel(req, 500)).toBe('/api/v1/rooms/:id/legs/:id');
    });
  });

  describe('HttpMetricsMiddleware', () => {
    it('should record duration and count for a response rejected by a guard (401)', () => {
      const middleware = new HttpMetricsMiddleware(metricsService);
      const recordSpy = jest.spyOn(metricsService.httpRequestDuration, 'record');
      const addCounterSpy = jest.spyOn(metricsService.httpRequestsTotal, 'add');

      const req: any = { method: 'post', originalUrl: '/api/v1/contracts', route: { path: '/api/v1/contracts' } };
      const res = createResponse(401);
      const next = jest.fn();

      middleware.use(req, res, next);
      res.emit('finish');
      res.emit('close'); // không được ghi nhận hai lần

      const labels = { method: 'POST', route: '/api/v1/contracts', status_code: '401' };
      expect(next).toHaveBeenCalled();
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(expect.any(Number), labels);
      expect(addCounterSpy).toHaveBeenCalledWith(1, labels);
    });

    it('should skip infrastructure endpoints (/health, /metrics)', () => {
      const middleware = new HttpMetricsMiddleware(metricsService);
      const addCounterSpy = jest.spyOn(metricsService.httpRequestsTotal, 'add');
      const res = createResponse(200);

      middleware.use({ method: 'GET', originalUrl: '/health/readiness' } as any, res, jest.fn());
      res.emit('finish');

      expect(addCounterSpy).not.toHaveBeenCalled();
    });
  });

  describe('MetricsController', () => {
    it('should delegate metrics scraping to OpenTelemetry exporter handler', () => {
      const controller = new MetricsController(metricsService);
      const handleScrapeSpy = jest.spyOn(metricsService, 'handleMetricsScrape').mockImplementation(() => {});

      const mockReq: any = { headers: {} };
      const mockRes: any = {};
      controller.getMetrics(mockReq, mockRes);

      expect(handleScrapeSpy).toHaveBeenCalledWith(mockReq, mockRes);
    });

    it('should require the configured bearer token', () => {
      const config: any = { metrics: { enabled: true, bearerToken: 'scrape-secret' } };
      const controller = new MetricsController(metricsService, config);
      const handleScrapeSpy = jest.spyOn(metricsService, 'handleMetricsScrape').mockImplementation(() => {});

      expect(() => controller.getMetrics({ headers: {} } as any, {} as any)).toThrow(UnauthorizedException);

      controller.getMetrics({ headers: { authorization: 'Bearer scrape-secret' } } as any, {} as any);
      expect(handleScrapeSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// npx jest src/infrastructure/metrics/metrics.spec.ts
