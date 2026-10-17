/**
 * Nạp file .env vào process.env (không ghi đè biến đã tồn tại). Không phụ thuộc NestJS để dùng được
 * ở giai đoạn sớm nhất (OpenTelemetry bootstrap chạy trước khi bất kỳ module NestJS nào được nạp).
 */
import { config as loadDotenv } from 'dotenv';
import { ENV_FILE_PATHS } from './env-files';

let envFilesLoaded = false;

export function loadEnvFiles(): void {
  if (envFilesLoaded) return;
  loadDotenv({ path: ENV_FILE_PATHS, quiet: true });
  envFilesLoaded = true;
}

const FALSE_VALUES = new Set(['false', '0', 'no', 'off', 'n', 'disabled']);

/** Đọc biến boolean thô từ process.env với cùng quy ước của z.stringbool() */
export function isEnvEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return !FALSE_VALUES.has(value.trim().toLowerCase());
}
