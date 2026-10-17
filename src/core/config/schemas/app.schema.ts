/**
 * Nhóm biến: Runtime, HTTP server, API governance (Swagger, Versioning, I18n, Feature Flag)
 * và vòng đời Graceful Shutdown.
 */
import { z } from 'zod';
import {
  addIssue,
  emptyToUndefined,
  envEnum,
  envInt,
  envOptionalBool,
  envOptionalEnum,
  envOptionalString,
  envString,
  ZodRefineCtx,
} from './env.helpers';

export const SUPPORTED_LOCALES = ['vi', 'en', 'ja', 'ko'] as const;

/**
 * Express `trust proxy`: 'true' | 'false' | số hop | danh sách subnet (loopback, 10.0.0.0/8, ...).
 * Mặc định false: chỉ tin X-Forwarded-For khi đã cấu hình tường minh, chống giả mạo IP.
 */
const trustProxySchema = z
  .preprocess(emptyToUndefined, z.string().default('false'))
  .transform((raw): boolean | number | string => {
    const value = raw.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
  });

/** Chuẩn hóa prefix: bỏ dấu "/" ở hai đầu ("/api/" → "api") */
const apiPrefixSchema = envString('api').transform((value) => value.replace(/^\/+|\/+$/g, ''));

const featureFlagRuleSchema = z.object({
  enabled: z.boolean(),
  percentage: z.number().min(0).max(100).optional(),
  allowedTenantIds: z.array(z.string()).optional(),
  allowedUserIds: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export type FeatureFlagRule = z.infer<typeof featureFlagRuleSchema>;

/** FEATURE_FLAGS='{"evn_tiered_quota":{"enabled":true,"allowedTenantIds":["<building-uuid>"]}}' */
const featureFlagsSchema = envString('{}').transform((raw, ctx) => {
  try {
    const parsed = z.record(z.string(), featureFlagRuleSchema).safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    ctx.addIssue({
      code: 'custom',
      message: `FEATURE_FLAGS has an invalid rule: ${parsed.error.issues[0]?.message}`,
    });
  } catch {
    ctx.addIssue({ code: 'custom', message: 'FEATURE_FLAGS must be a valid JSON object' });
  }
  return z.NEVER;
});

export const appEnvShape = {
  NODE_ENV: envEnum(['development', 'production', 'test'] as const, 'development'),
  APP_NAME: envString('room-management-api'),
  APP_VERSION: envOptionalString(),

  // HTTP server. HOST bỏ trống = Node tự lắng nghe dual-stack ("::" nếu có IPv6, ngược lại 0.0.0.0)
  HOST: envOptionalString(),
  PORT: envInt(3000, 1, 65535),
  API_PREFIX: apiPrefixSchema,
  API_DEFAULT_VERSION: envString('1'),
  ALLOWED_ORIGINS: envString('*'),
  TRUST_PROXY: trustProxySchema,
  LOG_LEVEL: envOptionalEnum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const),
  LOG_PRETTY: envOptionalBool(),
  HTTP_REQUEST_TIMEOUT_MS: envInt(15000, 100),
  HTTP_BODY_LIMIT: envString('1mb').pipe(
    z.string().regex(/^\d+(b|kb|mb)$/i, 'HTTP_BODY_LIMIT must look like "1mb", "512kb" or "1048576b"'),
  ),
  // Phải LỚN HƠN idle timeout của Load Balancer (AWS ALB mặc định 60s) để tránh lỗi 502 ngẫu nhiên
  HTTP_KEEP_ALIVE_TIMEOUT_MS: envInt(65000, 1000),
  HTTP_HEADERS_TIMEOUT_MS: envInt(66000, 1000),

  // Swagger / OpenAPI (mặc định tắt trên production)
  SWAGGER_ENABLED: envOptionalBool(),
  SWAGGER_PATH: envString('api/docs').transform((value) => value.replace(/^\/+|\/+$/g, '')),

  // I18n
  I18N_DEFAULT_LOCALE: envEnum(SUPPORTED_LOCALES, 'vi'),

  // Feature flags: giá trị nền (JSON) + override runtime qua Redis
  FEATURE_FLAGS: featureFlagsSchema,
  FEATURE_FLAG_CACHE_TTL_MS: envInt(10000, 0),

  // Graceful Shutdown (SHUTDOWN_TIMEOUT_MS phải nhỏ hơn terminationGracePeriodSeconds của K8s)
  SHUTDOWN_DRAIN_DELAY_MS: envInt(5000, 0),
  SHUTDOWN_HOOK_TIMEOUT_MS: envInt(10000, 100),
  SHUTDOWN_TIMEOUT_MS: envInt(25000, 1000),
};

type AppEnv = z.infer<z.ZodObject<typeof appEnvShape>>;

export function refineAppEnv(env: AppEnv, ctx: ZodRefineCtx): void {
  if (env.SHUTDOWN_DRAIN_DELAY_MS >= env.SHUTDOWN_TIMEOUT_MS) {
    addIssue(ctx, 'SHUTDOWN_DRAIN_DELAY_MS', 'SHUTDOWN_DRAIN_DELAY_MS must be < SHUTDOWN_TIMEOUT_MS');
  }

  if (env.HTTP_HEADERS_TIMEOUT_MS <= env.HTTP_KEEP_ALIVE_TIMEOUT_MS) {
    addIssue(
      ctx,
      'HTTP_HEADERS_TIMEOUT_MS',
      'HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS',
    );
  }

  if (/^v/i.test(env.API_DEFAULT_VERSION)) {
    addIssue(ctx, 'API_DEFAULT_VERSION', 'API_DEFAULT_VERSION must not include the "v" prefix (use "1", not "v1")');
  }

  // URI versioning tự thêm "/v1": prefix chứa sẵn version sẽ sinh ra đường dẫn "/api/v1/v1/..."
  if (/(^|\/)v\d+$/i.test(env.API_PREFIX)) {
    addIssue(
      ctx,
      'API_PREFIX',
      `API_PREFIX must not end with a version segment (URI versioning appends "/v${env.API_DEFAULT_VERSION}" automatically)`,
    );
  }

  if (env.NODE_ENV !== 'production') return;

  if (
    env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .includes('*')
  ) {
    addIssue(ctx, 'ALLOWED_ORIGINS', "Wildcard '*' CORS origin is not allowed in production");
  }
}
