/**
 * Ghi log dạng JSON chuẩn (NDJSON trên production),
 * dùng chung traceId với RequestContext (header x-correlation-id),
 * che dấu (masking) thông tin thẻ và mật khẩu tuân thủ PCI-DSS.
 */
import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { IncomingMessage, ServerResponse } from 'http';
import { AppConfigService } from '../config/app-config.service';
import { resolveTraceId } from '../context/trace-id.util';
import { AppLoggerService } from './app-logger.service';
import {
  AUTO_LOGGING_IGNORED_PATHS,
  REDACTION_CENSOR,
  SENSITIVE_REDACTION_PATHS,
} from './logger.constants';
import { loggerSerializers } from './logger.serializers';

type AuthenticatedRequest = IncomingMessage & {
  user?: { id?: string; tenantId?: string };
};

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,

          // Dùng chung traceId với RequestContextMiddleware (memo trên request)
          genReqId: (req: IncomingMessage, res: ServerResponse) =>
            resolveTraceId(req, res),

          // Gắn danh tính vào access log (đọc từ req.user vì ALS không đảm bảo ở sự kiện 'finish')
          customProps: (req: AuthenticatedRequest) => ({
            userId: req.user?.id,
            tenantId: req.user?.tenantId,
          }),

          customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },

          autoLogging: {
            ignore: (req: IncomingMessage) =>
              AUTO_LOGGING_IGNORED_PATHS.some((re) => re.test(req.url ?? '')),
          },

          // Tự động che dấu dữ liệu nhạy cảm theo chuẩn PCI-DSS & GDPR
          redact: {
            paths: SENSITIVE_REDACTION_PATHS,
            censor: REDACTION_CENSOR,
          },

          serializers: loggerSerializers,

          // Pretty-print chỉ khi phát triển cục bộ (LOG_PRETTY); production/test xuất NDJSON 1 dòng cho log shipper
          transport: config.logPretty
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                  translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        },
      }),
    }),
  ],
  providers: [AppLoggerService],
  exports: [AppLoggerService, PinoLoggerModule],
})
export class LoggerModule {}
