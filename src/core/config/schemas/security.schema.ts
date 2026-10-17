/**
 * Nhóm biến: Mã hóa cấp trường (FLE), JWT, Rate limiting và Webhook ingress.
 */
import { z } from 'zod';
import {
  addIssue,
  assertPemOrPath,
  emptyToUndefined,
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

  if (env.NODE_ENV !== 'production') return;

  if (env.JWT_SECRET && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    addIssue(ctx, 'JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET must differ from JWT_SECRET in production');
  }
}
