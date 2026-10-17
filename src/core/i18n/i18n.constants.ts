import { SUPPORTED_LOCALES } from '../config/schemas/app.schema';
import { vi } from './locales/vi';
import { en } from './locales/en';
import { ja } from './locales/ja';
import { ko } from './locales/ko';

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'vi';

export type TranslationDictionary = Record<string, string>;

/**
 * Từ điển thông điệp theo ngôn ngữ (khóa = SystemErrorCode hoặc khóa nghiệp vụ).
 * Bản tiếng Việt là nguồn chuẩn: khóa thiếu ở ngôn ngữ khác sẽ rơi về tiếng Việt rồi tới chính khóa.
 */
export const TRANSLATION_DICTIONARY: Record<SupportedLocale, TranslationDictionary> = { vi, en, ja, ko };
