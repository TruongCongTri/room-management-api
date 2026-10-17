/** Tiện ích kiểm thử dùng chung của IdentityModule (không được import từ mã chạy thật) */
import { validateEnv } from '../../core/config/env.schema';
import { configServiceFrom } from '../../core/config/load-config';
import { AppConfigService } from '../../core/config/app-config.service';

export const IDENTITY_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DB_MASTER_HOST: 'localhost',
  DB_MASTER_USER: 'postgres',
  DB_MASTER_PASSWORD: 'postgres',
  DB_NAME: 'db',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
  JWT_SECRET: 'unit-test-jwt-secret-with-at-least-32-chars',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret-with-at-least-32-chars',
};

export function identityTestConfig(env: Record<string, string> = {}): AppConfigService {
  return new AppConfigService(configServiceFrom(validateEnv({ ...IDENTITY_TEST_ENV, ...env })));
}

/** Bắt lỗi HTTP và trả về những gì client nhận được */
export async function httpErrorOf(promise: Promise<unknown>): Promise<{
  status: number;
  errorCode: string;
  retryAfterSeconds?: number;
  details?: any;
}> {
  try {
    await promise;
  } catch (err: any) {
    const response = typeof err.getResponse === 'function' ? err.getResponse() : {};
    return {
      status: typeof err.getStatus === 'function' ? err.getStatus() : 500,
      errorCode: response.errorCode,
      retryAfterSeconds: response.retryAfterSeconds,
      details: response.details,
    };
  }
  throw new Error('Expected the call to fail');
}
