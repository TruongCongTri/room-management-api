import { resolveLocale } from './locale.util';
import { I18nService } from './i18n.service';
import { TRANSLATION_DICTIONARY } from './i18n.constants';
import { RequestContextService } from '../context/request-context.service';
import { SystemErrorCode } from '../../common/constants/error-codes.constant';

const SUPPORTED = ['vi', 'en', 'ja', 'ko'] as const;

describe('I18nModule', () => {
  describe('resolveLocale (Accept-Language negotiation)', () => {
    it('should honour q-weights and fall back from regional tags to base languages', () => {
      expect(resolveLocale('fr-FR,ja-JP;q=0.9,en;q=0.8', SUPPORTED, 'vi')).toBe('ja');
      expect(resolveLocale('ko-KR', SUPPORTED, 'vi')).toBe('ko');
      expect(resolveLocale('en;q=0.5,vi;q=0.9', SUPPORTED, 'en')).toBe('vi');
    });

    it('should use the default for unsupported, wildcard or missing headers', () => {
      expect(resolveLocale('de-DE,fr;q=0.8', SUPPORTED, 'vi')).toBe('vi');
      expect(resolveLocale('*', SUPPORTED, 'en')).toBe('en');
      expect(resolveLocale(undefined, SUPPORTED, 'vi')).toBe('vi');
    });

    it('should let ?lang= override the header', () => {
      expect(resolveLocale('vi', SUPPORTED, 'vi', 'en-US')).toBe('en');
      expect(resolveLocale('vi', SUPPORTED, 'vi', 'xx')).toBe('vi');
    });
  });

  describe('I18nService', () => {
    it('should translate using the locale of the current request and interpolate params', async () => {
      const contextService = new RequestContextService();
      const i18n = new I18nService(contextService);

      const message = await contextService.runWithContext({ isBackgroundJob: false, locale: 'en' }, async () =>
        i18n.translate('SEC_RATE_LIMIT_EXCEEDED', { retryAfter: 30 }),
      );

      expect(message).toBe('Too many requests. Please retry in 30 seconds.');
      expect(i18n.translate('RES_NOT_FOUND')).toBe(TRANSLATION_DICTIONARY.vi.RES_NOT_FOUND); // mặc định 'vi'
      expect(i18n.translate('UNKNOWN_KEY')).toBe('UNKNOWN_KEY');
    });

    it('should provide a translation for every system error code in all supported locales', () => {
      for (const locale of SUPPORTED) {
        const missing = Object.values(SystemErrorCode).filter((code) => !TRANSLATION_DICTIONARY[locale][code]);
        expect({ locale, missing }).toEqual({ locale, missing: [] });
      }
    });
  });
});
