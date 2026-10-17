import './instrumentation'; // OpenTelemetry phải khởi động trước mọi import khác
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AppConfigService } from './core/config/app-config.service';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Đóng các kết nối keep-alive nhàn rỗi để server.close() không bị treo tới watchdog timeout
    forceCloseConnections: true,
    // [BẮT BUỘC CHO WEBHOOK]: Giữ nguyên raw body Buffer để tính toán chữ ký số HMAC SHA-256
    rawBody: true,
    // Body parser được cấu hình trong configureApp() với giới hạn kích thước từ HTTP_BODY_LIMIT
    bodyParser: false,
  });

  const config = app.get(AppConfigService);
  await configureApp(app, config);

  // Kích hoạt Graceful Shutdown Hooks cho tín hiệu SIGTERM/SIGINT
  app.enableShutdownHooks();

  if (config.host) {
    await app.listen(config.port, config.host);
  } else {
    await app.listen(config.port);
  }

  const logger = new Logger('Bootstrap');
  logger.log(
    `Application listening on ${await app.getUrl()} (${config.nodeEnv}) - API: /${config.apiPrefix}/v${config.apiDefaultVersion}`,
  );
  logger.log({ msg: 'Effective configuration', config: config.getSanitizedConfig() });
}

process.on('unhandledRejection', (reason) => {
  new Logger('Process').error(
    `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
  );
});

process.on('uncaughtException', (err) => {
  new Logger('Process').fatal(`Uncaught exception: ${err.message}`, err.stack);
  process.exit(1);
});

bootstrap().catch((err) => {
  // Ghi thẳng stderr nếu crash trước khi logger khởi tạo (ví dụ: fail-fast env schema validation)
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
