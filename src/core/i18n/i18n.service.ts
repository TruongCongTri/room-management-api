/**
 * Bản địa hóa thông điệp phản hồi, mã lỗi và nội dung thông báo theo ngôn ngữ của request
 * (Accept-Language / ?lang= được RequestContextMiddleware phân giải), hỗ trợ tham số {{name}}.
 */
import { Injectable, Optional } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service';
import { AppConfigService } from '../config/app-config.service';
import { SupportedLocale, DEFAULT_LOCALE, TRANSLATION_DICTIONARY } from './i18n.constants';

@Injectable()
export class I18nService {
  private readonly defaultLocale: SupportedLocale;

  constructor(
    private readonly contextService: RequestContextService,
    @Optional() config?: AppConfigService,
  ) {
    this.defaultLocale = (config?.i18n.defaultLocale as SupportedLocale | undefined) ?? DEFAULT_LOCALE;
  }

  translate(key: string, params?: Record<string, string | number>, customLocale?: SupportedLocale): string {
    const locale = customLocale || this.resolveCurrentLocale();
    const message =
      TRANSLATION_DICTIONARY[locale]?.[key] ??
      TRANSLATION_DICTIONARY[this.defaultLocale]?.[key] ??
      TRANSLATION_DICTIONARY[DEFAULT_LOCALE][key] ??
      key;
    return params ? this.interpolate(message, params) : message;
  }

  /** Có bản dịch cho khóa này không (dùng để quyết định có thay thông điệp gốc hay không) */
  has(key: string): boolean {
    return key in TRANSLATION_DICTIONARY[DEFAULT_LOCALE];
  }

  currentLocale(): SupportedLocale {
    return this.resolveCurrentLocale();
  }

  private resolveCurrentLocale(): SupportedLocale {
    const locale = this.contextService.getLocale();
    return locale && locale in TRANSLATION_DICTIONARY ? (locale as SupportedLocale) : this.defaultLocale;
  }

  private interpolate(message: string, params: Record<string, string | number>): string {
    return message.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
      params[name] !== undefined ? String(params[name]) : match,
    );
  }
}
