import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RequestContextService } from './request-context.service';
import { RequestContextData } from './request-context.model';
import { resolveTraceId } from './trace-id.util';
import { AppConfigService } from '../config/app-config.service';
import { resolveLocale } from '../i18n/locale.util';
import { SUPPORTED_LOCALES } from '../config/schemas/app.schema';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly contextService: RequestContextService,
    private readonly config: AppConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // 1. Nhận (đã kiểm tra định dạng) hoặc sinh mới traceId, đồng bộ vào response header
    const traceId = resolveTraceId(req, res);

    // 2. Client IP: req.ip đã tôn trọng cấu hình Express 'trust proxy' (TRUST_PROXY).
    //    KHÔNG đọc trực tiếp X-Forwarded-For vì client có thể giả mạo header này.
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';

    // 3. Ngôn ngữ phản hồi (thông điệp lỗi, email) theo Accept-Language hoặc ?lang=
    const queryLang = typeof req.query?.lang === 'string' ? req.query.lang : undefined;
    const locale = resolveLocale(
      req.headers['accept-language'],
      SUPPORTED_LOCALES,
      this.config.i18n.defaultLocale,
      queryLang,
    );

    const initialContext: RequestContextData = {
      traceId,
      clientIp,
      userAgent: req.headers['user-agent'],
      locale,
      startTime: Date.now(),
      isBackgroundJob: false,
      metadata: new Map<string, unknown>(),
    };

    // 4. Kích hoạt AsyncLocalStorage cho toàn bộ chu kỳ sống của request
    this.contextService.run(initialContext, () => next());
  }
}
