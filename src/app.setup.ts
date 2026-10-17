/**
 * Cấu hình HTTP dùng chung cho main.ts và bộ kiểm thử e2e: đảm bảo e2e chạy đúng pipeline như production
 * (prefix, versioning, body limit, helmet, CORS, WebSocket adapter, Swagger, keep-alive).
 */
import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Server } from 'http';
import { AppConfigService } from './core/config/app-config.service';
import { AppLoggerService } from './core/logger/app-logger.service';
import { RedisConnectionFactory } from './core/redis/redis-connection.factory';
import { RedisIoAdapter } from './infrastructure/websocket/adapters/redis-io.adapter';
import { SwaggerConfigHelper } from './infrastructure/swagger/swagger.config';
import {
  buildCorsConfig,
  helmetSecurityConfig,
  swaggerHelmetConfig,
} from './core/security/headers/security-headers.config';

/** Endpoint hạ tầng nằm ngoài API_PREFIX và không gắn version (cấu hình probe/scrape ổn định) */
export const INFRA_ROUTES = [
  { path: 'health/liveness', method: RequestMethod.GET },
  { path: 'health/readiness', method: RequestMethod.GET },
  { path: 'metrics', method: RequestMethod.GET },
];

export async function configureApp(app: NestExpressApplication, config: AppConfigService): Promise<void> {
  // 1. Logger có cấu trúc và ngữ cảnh (traceId, userId, tenantId) cho toàn bộ lifecycle
  app.useLogger(app.get(AppLoggerService));

  // 2. Chỉ tin X-Forwarded-For từ reverse proxy đã cấu hình (K8s Ingress / Cloud ALB)
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // 3. Giới hạn kích thước payload (chống DoS bằng body khổng lồ), vẫn giữ rawBody cho webhook
  app.useBodyParser('json', { limit: config.http.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.http.bodyLimit, extended: true });

  // 4. Security Headers (CSP nới lỏng chỉ cho trang Swagger UI) & CORS Whitelist động
  const swaggerPrefix = `/${config.swagger.path}`;
  const strictHelmet = helmet(helmetSecurityConfig);
  const swaggerHelmet = helmet(swaggerHelmetConfig);
  const isSwaggerPath = (path: string) =>
    path === swaggerPrefix || path.startsWith(`${swaggerPrefix}/`) || path.startsWith(`${swaggerPrefix}-json`);
  app.use((req: any, res: any, next: any) =>
    config.swagger.enabled && isSwaggerPath(req.path) ? swaggerHelmet(req, res, next) : strictHelmet(req, res, next),
  );
  app.enableCors(buildCorsConfig(config.allowedOrigins));

  // 5. Quản trị định tuyến & Phiên bản API: /api/v1/... ; /health/* và /metrics nằm ngoài prefix
  app.setGlobalPrefix(config.apiPrefix, { exclude: INFRA_ROUTES });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.apiDefaultVersion });

  // 6. Socket.IO đồng bộ Multi-Pod qua Redis Pub/Sub (cùng cấu hình TLS / IP family với Redis chính)
  if (config.websocket.enabled) {
    const redisIoAdapter = new RedisIoAdapter(app, config, app.get(RedisConnectionFactory));
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
  }

  // 7. OpenAPI / Swagger Documentation (Governance & DX)
  SwaggerConfigHelper.setup(app, config);

  // 8. Keep-alive dài hơn idle timeout của Load Balancer → tránh 502 do LB dùng lại kết nối đã bị đóng
  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.headersTimeout = config.http.headersTimeoutMs;
}
