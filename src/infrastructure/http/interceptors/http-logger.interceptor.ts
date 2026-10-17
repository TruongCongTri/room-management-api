/**
 * Ghi log Request/Response gọi ra đối tác theo chuẩn PCI-DSS:
 *  - KHÔNG BAO GIỜ ghi body (CCCD, hộ chiếu, tài khoản ngân hàng có thể nằm trong payload gửi cổng hóa đơn điện tử / ngân hàng).
 *  - Che giá trị query string nhạy cảm (token, apiKey, signature, otp...) trong URL.
 *  - Ghi thời gian phản hồi để phát hiện đối tác chậm.
 */
import { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { AppLoggerService } from '../../../core/logger/app-logger.service';
import { RequestRuntimeState } from '../interfaces/http-client.interface';

const SENSITIVE_QUERY_KEY =
  /token|key|secret|password|passwd|signature|sig|otp|pin|cvv|cvc|card|pan|passport|auth|session/i;
/** Bí mật nằm trong path (vd: Telegram https://api.telegram.org/bot<id>:<token>/sendMessage) */
const SENSITIVE_PATH_SEGMENTS = [/\/bot\d+:[A-Za-z0-9_-]+/g];
const CONTEXT = 'AppHttpClient';

/** Che giá trị tham số nhạy cảm trong URL: ?apiKey=abc → ?apiKey=[REDACTED] */
export function maskUrl(rawUrl: string | undefined, baseURL?: string): string {
  if (!rawUrl) return '<unknown>';
  try {
    const url = new URL(rawUrl, baseURL ?? 'http://relative.invalid');
    // Chụp danh sách khóa trước khi sửa (set() thay đổi danh sách đang duyệt)
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    let masked = url.toString();
    for (const pattern of SENSITIVE_PATH_SEGMENTS) masked = masked.replace(pattern, '/bot[REDACTED]');
    return url.host === 'relative.invalid' ? masked.replace('http://relative.invalid', '') : masked;
  } catch {
    return rawUrl.split('?')[0].replace(SENSITIVE_PATH_SEGMENTS[0], '/bot[REDACTED]');
  }
}

export function createHttpLoggerInterceptors(logger: AppLoggerService) {
  return {
    onRequest(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
      (config as InternalAxiosRequestConfig & RequestRuntimeState)._startedAt ??= Date.now();
      logger.debug(`[HttpClient Request] ${config.method?.toUpperCase()} ${maskUrl(config.url, config.baseURL)}`, CONTEXT);
      return config;
    },
    onResponse(response: AxiosResponse): AxiosResponse {
      const config = response.config as InternalAxiosRequestConfig & RequestRuntimeState;
      const durationMs = config._startedAt ? Date.now() - config._startedAt : undefined;
      logger.debug(
        `[HttpClient Response] ${response.status} ${config.method?.toUpperCase()} ${maskUrl(config.url, config.baseURL)}` +
          (durationMs !== undefined ? ` in ${durationMs}ms` : ''),
        CONTEXT,
      );
      return response;
    },
  };
}
