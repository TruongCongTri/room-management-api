/**
 * Logger dùng chung toàn ứng dụng (được đăng ký qua app.useLogger trong main.ts):
 * mọi dòng log, kể cả từ `new Logger(Context)` của NestJS hay trong worker nền,
 * đều tự động mang traceId, userId, tenantId từ RequestContextService.
 */
import { Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextService } from '../context/request-context.service';
import { ShutdownRegistry } from '../shutdown/shutdown.registry';
import { ShutdownPhase } from '../shutdown/shutdown.interface';
import { serializeError } from './logger.serializers';

type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

@Injectable()
export class AppLoggerService implements LoggerService, OnModuleInit {
  constructor(
    private readonly pinoLogger: PinoLogger,
    private readonly contextService: RequestContextService,
    @Optional() private readonly shutdownRegistry?: ShutdownRegistry,
  ) {}

  onModuleInit(): void {
    // Pha 4: đẩy hết log còn trong buffer trước khi process thoát
    this.shutdownRegistry?.register(
      'PinoLoggerFlush',
      ShutdownPhase.FLUSH_BUFFERS,
      () =>
        new Promise<void>((resolve) => {
          const root = PinoLogger.root;
          if (!root?.flush) return resolve();
          root.flush(() => resolve());
        }),
    );
  }

  /**
   * Tự động làm giàu payload với ngữ cảnh request hiện tại
   */
  private enrichContext(context?: string): Record<string, unknown> {
    const store = this.contextService.getStore();
    return {
      context: context || 'Application',
      traceId: this.contextService.getTraceId(),
      userId: store?.user?.id,
      tenantId: this.contextService.getTenantId(),
      departmentId: store?.user?.departmentId,
      clientIp: store?.clientIp,
      isBackgroundJob: store?.isBackgroundJob || false,
    };
  }

  private write(
    level: PinoLevel,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ): void {
    const meta = { ...this.enrichContext(context), ...extra };

    if (message instanceof Error) {
      this.pinoLogger[level]({ ...meta, err: serializeError(message) }, message.message);
    } else if (message !== null && typeof message === 'object') {
      // Metadata ngữ cảnh luôn thắng để payload không thể ghi đè traceId/userId
      this.pinoLogger[level]({ ...(message as object), ...meta });
    } else {
      this.pinoLogger[level](meta, String(message));
    }
  }

  log(message: any, context?: string): void {
    this.write('info', message, context);
  }

  /**
   * Tương thích chữ ký NestJS: error(message, stack?, context?)
   */
  error(message: any, trace?: string, context?: string): void {
    this.write('error', message, context, trace ? { stack: trace } : undefined);
  }

  warn(message: any, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: any, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: any, context?: string): void {
    this.write('trace', message, context);
  }

  fatal(message: any, context?: string): void {
    this.write('fatal', message, context);
  }
}
