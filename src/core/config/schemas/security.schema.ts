/**
 * Nhóm biến: Mã hóa cấp trường (FLE), JWT, Rate limiting và Webhook ingress.
 */
import { z } from 'zod';
import { isValidDuration } from '../../security/jwt/duration';
import {
  addIssue,
  assertPemOrPath,
  emptyToUndefined,
  envBool,
  envEnum,
  envInt,
  envOptionalString,
  envString,
  ZodRefineCtx,
} from './env.helpers';

const HEX_256_BIT = /^[0-9a-fA-F]{64}$/;
const KEY_VERSION = /^[A-Za-z0-9_-]{1,16}$/;

export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export const isHmacAlgorithm = (alg: string): boolean => alg.startsWith('HS');

/** Danh sách khóa cũ phục vụ giải mã sau khi xoay khóa: "v0:<hex64>,v1:<hex64>" */
const legacyKeysSchema = envString('').refine(
  (raw) =>
    raw === '' ||
    raw.split(',').every((entry) => {
      const [version, key, ...rest] = entry.trim().split(':');
      return rest.length === 0 && KEY_VERSION.test(version ?? '') && HEX_256_BIT.test(key ?? '');
    }),
  'ENCRYPTION_LEGACY_KEYS must be a comma-separated list of "<version>:<64-hex-key>"',
);

export const securityEnvShape = {
  // Field-Level Encryption (AES-256-GCM)
  ENCRYPTION_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: 'ENCRYPTION_KEY must be exactly a 64-character HEX string (32 bytes)' })
      .regex(HEX_256_BIT, 'ENCRYPTION_KEY must be exactly a 64-character HEX string (32 bytes)'),
  ),
  ENCRYPTION_KEY_VERSION: envString('v1').pipe(
    z.string().regex(KEY_VERSION, 'ENCRYPTION_KEY_VERSION must match [A-Za-z0-9_-]{1,16}'),
  ),
  ENCRYPTION_LEGACY_KEYS: legacyKeysSchema,
  // Blind index (HMAC-SHA256) cho tra cứu chính xác trên cột mã hóa (CCCD, hộ chiếu).
  // KHÔNG xoay vòng như khóa AES: đổi pepper làm mất khả năng tra cứu cho tới khi tính lại toàn bộ cột *_hash.
  BLIND_INDEX_PEPPER: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: 'BLIND_INDEX_PEPPER must be at least 32 characters long' })
      .min(32, 'BLIND_INDEX_PEPPER must be at least 32 characters long'),
  ),

  // JWT: HS* dùng JWT_SECRET; RS*/ES* xác thực bằng JWT_PUBLIC_KEY (PEM nội tuyến hoặc đường dẫn file)
  JWT_ALGORITHM: envEnum(JWT_ALGORITHMS, 'HS256'),
  JWT_SECRET: envOptionalString(),
  JWT_PUBLIC_KEY: envOptionalString(),
  JWT_PRIVATE_KEY: envOptionalString(),
  JWT_ISSUER: envOptionalString(),
  JWT_AUDIENCE: envOptionalString(),
  JWT_EXPIRES_IN: envString('15m'),
  JWT_REFRESH_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: 'JWT_REFRESH_SECRET must be at least 32 characters long' })
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters long'),
  ),
  JWT_REFRESH_EXPIRES_IN: envString('7d'),
  JWT_CLOCK_TOLERANCE_SEC: envInt(5, 0, 300),

  // Đăng nhập bằng số điện thoại (IdentityModule, tài liệu 04 mục 1.4)
  // Phiên refresh: JWT_REFRESH_EXPIRES_IN là hạn TRƯỢT khi không dùng, AUTH_REFRESH_ABSOLUTE_EXPIRES_IN là hạn tuyệt đối
  AUTH_REFRESH_ABSOLUTE_EXPIRES_IN: envString('30d'),
  // Vai trò phải xác nhận OTP ở MỌI lần đăng nhập (vai trò liên quan tiền)
  AUTH_MFA_ROLES: envString('LANDLORD,ACCOUNTANT'),
  AUTH_OTP_TTL_SEC: envInt(300, 60, 900),
  AUTH_OTP_MAX_ATTEMPTS: envInt(5, 1, 10),
  AUTH_OTP_RESEND_COOLDOWN_SEC: envInt(60, 10, 600),
  AUTH_OTP_DAILY_LIMIT: envInt(5, 1, 50),
  AUTH_MFA_OTP_DAILY_LIMIT: envInt(20, 1, 200),
  AUTH_LOGIN_MAX_FAILURES: envInt(5, 1, 20),
  AUTH_LOGIN_FAILURE_WINDOW_SEC: envInt(900, 60, 86400),
  AUTH_LOCK_BASE_SEC: envInt(900, 60, 86400),
  AUTH_LOCK_MAX_SEC: envInt(86400, 60, 604800),
  // CHỈ local / kiểm thử: trả mã OTP trong response (debugCode) để test bằng Postman. Cấm trên production.
  AUTH_OTP_DEBUG_ECHO: envBool(false),

  // Rate Limiting (Throttler) - 3 tầng nghiệp vụ, cửa sổ chung THROTTLE_TTL (ms)
  THROTTLE_TTL: envInt(60000, 1000),
  THROTTLE_LIMIT: envInt(60, 1),
  THROTTLE_SEARCH_LIMIT: envInt(100, 1),
  THROTTLE_SENSITIVE_LIMIT: envInt(5, 1),

  // Webhook ingress: độ lệch thời gian tối đa (chống replay)
  WEBHOOK_TOLERANCE_SECONDS: envInt(300, 30, 3600),
};

type SecurityEnv = z.infer<z.ZodObject<typeof securityEnvShape>> & { NODE_ENV: string };

export function refineSecurityEnv(env: SecurityEnv, ctx: ZodRefineCtx): void {
  const legacyVersions = env.ENCRYPTION_LEGACY_KEYS.split(',')
    .map((entry) => entry.trim().split(':')[0])
    .filter(Boolean);
  if (legacyVersions.includes(env.ENCRYPTION_KEY_VERSION)) {
    addIssue(
      ctx,
      'ENCRYPTION_LEGACY_KEYS',
      `Legacy key list must not redefine the active version '${env.ENCRYPTION_KEY_VERSION}'`,
    );
  }

  if (env.BLIND_INDEX_PEPPER && env.BLIND_INDEX_PEPPER === env.ENCRYPTION_KEY) {
    addIssue(ctx, 'BLIND_INDEX_PEPPER', 'BLIND_INDEX_PEPPER must differ from ENCRYPTION_KEY (separate secrets for HMAC and AES)');
  }

  if (isHmacAlgorithm(env.JWT_ALGORITHM)) {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
      addIssue(ctx, 'JWT_SECRET', 'JWT_SECRET must be at least 32 characters long for HMAC-SHA256');
    }
  } else if (!env.JWT_PUBLIC_KEY) {
    addIssue(ctx, 'JWT_PUBLIC_KEY', `JWT_PUBLIC_KEY is required when JWT_ALGORITHM=${env.JWT_ALGORITHM}`);
  }
  assertPemOrPath(ctx, 'JWT_PUBLIC_KEY', env.JWT_PUBLIC_KEY);
  assertPemOrPath(ctx, 'JWT_PRIVATE_KEY', env.JWT_PRIVATE_KEY);

  for (const key of ['JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN', 'AUTH_REFRESH_ABSOLUTE_EXPIRES_IN'] as const) {
    if (!isValidDuration(env[key])) addIssue(ctx, key, `${key} must be a duration such as 900, 15m, 12h or 7d`);
  }
  if (env.AUTH_LOCK_MAX_SEC < env.AUTH_LOCK_BASE_SEC) {
    addIssue(ctx, 'AUTH_LOCK_MAX_SEC', 'AUTH_LOCK_MAX_SEC must be >= AUTH_LOCK_BASE_SEC');
  }

  if (env.NODE_ENV !== 'production') return;

  if (env.AUTH_OTP_DEBUG_ECHO) {
    addIssue(ctx, 'AUTH_OTP_DEBUG_ECHO', 'AUTH_OTP_DEBUG_ECHO must never be enabled in production (it returns OTP codes in responses)');
  }

  if (env.JWT_SECRET && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    addIssue(ctx, 'JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET must differ from JWT_SECRET in production');
  }
}
