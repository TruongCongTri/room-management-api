import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.schema';
import {
  DatabaseConnectionConfig,
  describeDatabaseTarget,
  resolveDatabaseConfig,
} from './resolvers/database.resolver';
import {
  describeRedisTarget,
  RedisConnectionConfig,
  resolveRedisConfig,
} from './resolvers/redis.resolver';
import { readPemOrPath } from './resolvers/pem.util';
import { isHmacAlgorithm, JwtAlgorithm } from './schemas/security.schema';
import { parseDurationSeconds } from '../security/jwt/duration';
import { FeatureFlagRule } from './schemas/app.schema';
import {
  EVN_RESIDENTIAL_TIERS,
  EVN_RULES,
  VN_BUSINESS_TIMEZONE,
} from '../../common/constants/vn-rental.constant';

export type { DatabaseNodeConfig, DatabaseConnectionConfig } from './resolvers/database.resolver';
export type { RedisConnectionConfig } from './resolvers/redis.resolver';

@Injectable()
export class AppConfigService {
  // Cấu hình bất biến sau khi boot → phân giải một lần (đọc file CA/PEM, parse URL)
  private databaseCache?: DatabaseConnectionConfig;
  private redisCache?: RedisConnectionConfig;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  private get<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
    return this.configService.get(key, { infer: true });
  }

  /** Toàn bộ cấu hình đã xác thực (dùng cho resolver thuần không phụ thuộc NestJS) */
  private get env(): EnvConfig {
    return new Proxy({} as EnvConfig, {
      get: (_target, key: string) => this.get(key as keyof EnvConfig),
    });
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------

  get nodeEnv(): EnvConfig['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get app() {
    return {
      name: this.get('APP_NAME'),
      version: this.get('APP_VERSION') ?? process.env.npm_package_version ?? '0.0.0',
    };
  }

  get host(): string | undefined {
    return this.get('HOST');
  }

  get port(): number {
    return this.get('PORT');
  }

  get apiPrefix(): string {
    return this.get('API_PREFIX');
  }

  get apiDefaultVersion(): string {
    return this.get('API_DEFAULT_VERSION');
  }

  get trustProxy(): boolean | number | string {
    return this.get('TRUST_PROXY');
  }

  get logLevel(): NonNullable<EnvConfig['LOG_LEVEL']> {
    return this.get('LOG_LEVEL') ?? (this.isProduction ? 'info' : 'debug');
  }

  /** Pretty-print chỉ dành cho máy local; production/test xuất NDJSON một dòng */
  get logPretty(): boolean {
    return this.get('LOG_PRETTY') ?? this.isDevelopment;
  }

  get allowedOrigins(): string[] {
    return this.get('ALLOWED_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  get http() {
    return {
      requestTimeoutMs: this.get('HTTP_REQUEST_TIMEOUT_MS'),
      bodyLimit: this.get('HTTP_BODY_LIMIT'),
      keepAliveTimeoutMs: this.get('HTTP_KEEP_ALIVE_TIMEOUT_MS'),
      headersTimeoutMs: this.get('HTTP_HEADERS_TIMEOUT_MS'),
    };
  }

  get swagger() {
    return {
      enabled: this.get('SWAGGER_ENABLED') ?? !this.isProduction,
      path: this.get('SWAGGER_PATH'),
    };
  }

  get i18n() {
    return { defaultLocale: this.get('I18N_DEFAULT_LOCALE') };
  }

  get featureFlags(): { defaults: Record<string, FeatureFlagRule>; cacheTtlMs: number } {
    return {
      defaults: this.get('FEATURE_FLAGS'),
      cacheTtlMs: this.get('FEATURE_FLAG_CACHE_TTL_MS'),
    };
  }

  get shutdown() {
    return {
      drainDelayMs: this.get('SHUTDOWN_DRAIN_DELAY_MS'),
      hookTimeoutMs: this.get('SHUTDOWN_HOOK_TIMEOUT_MS'),
      timeoutMs: this.get('SHUTDOWN_TIMEOUT_MS'),
    };
  }

  // ---------------------------------------------------------------------------
  // Data stores
  // ---------------------------------------------------------------------------

  /** PostgreSQL: local (biến rời / IPv6) hoặc Supabase (DATABASE_URL, pooler IPv4 / direct IPv6) */
  get database(): DatabaseConnectionConfig {
    this.databaseCache ??= resolveDatabaseConfig(this.env);
    return this.databaseCache;
  }

  /** Redis: Docker local (biến rời) hoặc managed (REDIS_URL rediss://), hoặc Sentinel */
  get redis(): RedisConnectionConfig {
    this.redisCache ??= resolveRedisConfig(this.env);
    return this.redisCache;
  }

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------

  get security() {
    const legacyKeys = this.get('ENCRYPTION_LEGACY_KEYS')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [version, key] = entry.split(':');
        return { version, key };
      });

    const algorithm: JwtAlgorithm = this.get('JWT_ALGORITHM');
    const hmac = isHmacAlgorithm(algorithm);

    return {
      encryptionKey: this.get('ENCRYPTION_KEY'),
      encryptionKeyVersion: this.get('ENCRYPTION_KEY_VERSION'),
      encryptionLegacyKeys: legacyKeys,
      blindIndexPepper: this.get('BLIND_INDEX_PEPPER'),
      jwt: {
        algorithm,
        secret: this.get('JWT_SECRET'),
        // Khóa xác thực chữ ký: secret (HMAC) hoặc public key PEM (RSA / ECDSA)
        verifyKey: hmac
          ? (this.get('JWT_SECRET') as string)
          : (readPemOrPath(this.get('JWT_PUBLIC_KEY')) as string),
        // Khóa ký token (chỉ module auth / test cần): secret (HMAC) hoặc private key PEM
        signKey: hmac ? this.get('JWT_SECRET') : readPemOrPath(this.get('JWT_PRIVATE_KEY')),
        issuer: this.get('JWT_ISSUER'),
        audience: this.get('JWT_AUDIENCE'),
        expiresIn: this.get('JWT_EXPIRES_IN'),
        refreshSecret: this.get('JWT_REFRESH_SECRET'),
        refreshExpiresIn: this.get('JWT_REFRESH_EXPIRES_IN'),
        clockToleranceSec: this.get('JWT_CLOCK_TOLERANCE_SEC'),
      },
    };
  }

  /** Đăng nhập bằng số điện thoại, OTP, khóa đăng nhập, phiên refresh (IdentityModule) */
  get auth() {
    return {
      accessTokenTtlSec: parseDurationSeconds(this.get('JWT_EXPIRES_IN')),
      refreshIdleTtlSec: parseDurationSeconds(this.get('JWT_REFRESH_EXPIRES_IN')),
      refreshAbsoluteTtlSec: parseDurationSeconds(this.get('AUTH_REFRESH_ABSOLUTE_EXPIRES_IN')),
      refreshTokenPepper: this.get('JWT_REFRESH_SECRET') as string,
      mfaRoles: this.get('AUTH_MFA_ROLES')
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
      otp: {
        ttlSec: this.get('AUTH_OTP_TTL_SEC'),
        maxAttempts: this.get('AUTH_OTP_MAX_ATTEMPTS'),
        resendCooldownSec: this.get('AUTH_OTP_RESEND_COOLDOWN_SEC'),
        dailyLimit: this.get('AUTH_OTP_DAILY_LIMIT'),
        mfaDailyLimit: this.get('AUTH_MFA_OTP_DAILY_LIMIT'),
        debugEcho: this.get('AUTH_OTP_DEBUG_ECHO'),
      },
      login: {
        maxFailures: this.get('AUTH_LOGIN_MAX_FAILURES'),
        failureWindowSec: this.get('AUTH_LOGIN_FAILURE_WINDOW_SEC'),
        lockBaseSec: this.get('AUTH_LOCK_BASE_SEC'),
        lockMaxSec: this.get('AUTH_LOCK_MAX_SEC'),
      },
    };
  }

  get throttler() {
    return {
      ttl: this.get('THROTTLE_TTL'),
      limit: this.get('THROTTLE_LIMIT'),
      searchLimit: this.get('THROTTLE_SEARCH_LIMIT'),
      sensitiveLimit: this.get('THROTTLE_SENSITIVE_LIMIT'),
    };
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  get health() {
    return {
      heapLimitBytes: this.get('HEALTH_HEAP_LIMIT_MB') * 1024 * 1024,
      rssLimitBytes: this.get('HEALTH_RSS_LIMIT_MB') * 1024 * 1024,
      diskPath:
        this.get('HEALTH_DISK_PATH') ??
        (process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/'),
      diskThresholdPercent: this.get('HEALTH_DISK_THRESHOLD_PERCENT'),
    };
  }

  get metrics() {
    return {
      enabled: this.get('METRICS_ENABLED'),
      bearerToken: this.get('METRICS_BEARER_TOKEN'),
    };
  }

  get tracing() {
    return {
      enabled: this.get('OTEL_ENABLED'),
      serviceName: this.get('OTEL_SERVICE_NAME') ?? this.app.name,
      endpoint: this.get('OTEL_EXPORTER_OTLP_ENDPOINT'),
      samplerRatio: this.get('OTEL_TRACES_SAMPLER_RATIO'),
    };
  }

  // ---------------------------------------------------------------------------
  // Integration & Infrastructure
  // ---------------------------------------------------------------------------

  get resilience() {
    return {
      timeoutMs: this.get('CIRCUIT_BREAKER_TIMEOUT_MS'),
      resetTimeoutMs: this.get('CIRCUIT_BREAKER_RESET_TIMEOUT_MS'),
      errorThresholdPercentage: this.get('CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT'),
      volumeThreshold: this.get('CIRCUIT_BREAKER_VOLUME_THRESHOLD'),
      bulkheadMaxConcurrent: this.get('BULKHEAD_MAX_CONCURRENT'),
      bulkheadMaxQueue: this.get('BULKHEAD_MAX_QUEUE'),
    };
  }

  get httpClient() {
    return {
      timeoutMs: this.get('HTTP_CLIENT_TIMEOUT_MS'),
      maxRetries: this.get('HTTP_CLIENT_MAX_RETRIES'),
    };
  }

  get queue() {
    return {
      prefix: this.get('QUEUE_PREFIX'),
      defaultAttempts: this.get('QUEUE_DEFAULT_ATTEMPTS'),
      backoffDelayMs: this.get('QUEUE_BACKOFF_DELAY_MS'),
      workerConcurrency: this.get('QUEUE_WORKER_CONCURRENCY'),
    };
  }

  get cache() {
    return {
      defaultTtlSeconds: this.get('CACHE_DEFAULT_TTL_SECONDS'),
      memoryMaxEntries: this.get('CACHE_MEMORY_MAX_ENTRIES'),
      l1TtlSeconds: this.get('CACHE_L1_TTL_SECONDS'),
      xfetchBeta: this.get('CACHE_XFETCH_BETA'),
    };
  }

  get lock() {
    return {
      defaultTtlMs: this.get('LOCK_DEFAULT_TTL_MS'),
      retryCount: this.get('LOCK_RETRY_COUNT'),
      retryDelayMs: this.get('LOCK_RETRY_DELAY_MS'),
      maxRetryDelayMs: this.get('LOCK_MAX_RETRY_DELAY_MS'),
    };
  }

  get outbox() {
    return {
      enabled: this.get('OUTBOX_ENABLED'),
      pollIntervalMs: this.get('OUTBOX_POLL_INTERVAL_MS'),
      batchSize: this.get('OUTBOX_BATCH_SIZE'),
      maxRetries: this.get('OUTBOX_MAX_RETRIES'),
      baseRetryDelayMs: this.get('OUTBOX_BASE_RETRY_DELAY_MS'),
      leaseMs: this.get('OUTBOX_LEASE_MS'),
      retentionDays: this.get('OUTBOX_RETENTION_DAYS'),
      cleanupCron: this.get('OUTBOX_CLEANUP_CRON'),
    };
  }

  get audit() {
    return {
      httpEnabled: this.get('AUDIT_HTTP_ENABLED'),
      tieringEnabled: this.get('AUDIT_TIERING_ENABLED'),
      hotRetentionDays: this.get('AUDIT_HOT_RETENTION_DAYS'),
      tieringCron: this.get('AUDIT_TIERING_CRON'),
      tieringBatchSize: this.get('AUDIT_TIERING_BATCH_SIZE'),
    };
  }

  get storage() {
    return {
      enabled: this.get('STORAGE_ENABLED'),
      endpoint: this.get('STORAGE_ENDPOINT'),
      region: this.get('STORAGE_REGION'),
      bucket: this.get('STORAGE_BUCKET'),
      coldBucket: this.get('STORAGE_COLD_BUCKET') ?? this.get('STORAGE_BUCKET'),
      accessKeyId: this.get('STORAGE_ACCESS_KEY'),
      secretAccessKey: this.get('STORAGE_SECRET_KEY'),
      forcePathStyle: this.get('STORAGE_FORCE_PATH_STYLE'),
      publicBaseUrl: this.get('STORAGE_PUBLIC_BASE_URL'),
      uploadUrlTtlSeconds: this.get('STORAGE_UPLOAD_URL_TTL_SECONDS'),
      downloadUrlTtlSeconds: this.get('STORAGE_DOWNLOAD_URL_TTL_SECONDS'),
      maxUploadBytes: this.get('STORAGE_MAX_UPLOAD_BYTES'),
    };
  }

  get notification() {
    return {
      dryRun: this.get('NOTIFICATION_DRY_RUN') ?? !this.isProduction,
      mailFrom: this.get('MAIL_FROM'),
      smtp: this.get('SMTP_HOST')
        ? {
            host: this.get('SMTP_HOST') as string,
            port: this.get('SMTP_PORT'),
            secure: this.get('SMTP_SECURE'),
            user: this.get('SMTP_USER'),
            password: this.get('SMTP_PASSWORD'),
          }
        : undefined,
      telegram: this.get('TELEGRAM_BOT_TOKEN')
        ? {
            botToken: this.get('TELEGRAM_BOT_TOKEN') as string,
            defaultChatId: this.get('TELEGRAM_DEFAULT_CHAT_ID'),
          }
        : undefined,
      zalo: this.get('ZALO_OA_ACCESS_TOKEN')
        ? { accessToken: this.get('ZALO_OA_ACCESS_TOKEN') as string }
        : undefined,
      twilio: this.get('TWILIO_ACCOUNT_SID')
        ? {
            accountSid: this.get('TWILIO_ACCOUNT_SID') as string,
            authToken: this.get('TWILIO_AUTH_TOKEN') as string,
            fromNumber: this.get('TWILIO_FROM_NUMBER') as string,
          }
        : undefined,
    };
  }

  get websocket() {
    return { enabled: this.get('WS_ENABLED') };
  }

  get webhook() {
    return {
      toleranceSeconds: this.get('WEBHOOK_TOLERANCE_SECONDS'),
      dispatchTimeoutMs: this.get('WEBHOOK_DISPATCH_TIMEOUT_MS'),
      dispatchMaxAttempts: this.get('WEBHOOK_DISPATCH_MAX_ATTEMPTS'),
    };
  }

  get pdf() {
    return {
      fontPath: this.get('PDF_FONT_PATH'),
      boldFontPath: this.get('PDF_FONT_BOLD_PATH'),
    };
  }

  /**
   * Xuất cấu hình đã che dấu (Masked) để phục vụ in log khi khởi động hoặc API giám sát.
   * Chỉ chứa giá trị không nhạy cảm; secret chỉ được báo là "đã cấu hình".
   */
  /** Thuế cho thuê tài sản 2026 (ngưỡng 1 tỷ, GTGT 5%, TNCN 5% trên phần vượt ngưỡng) */
  get tax() {
    return {
      exemptThresholdVnd: this.get('TAX_EXEMPT_THRESHOLD_VND'),
      vatRatePercent: this.get('TAX_VAT_RATE_PERCENT'),
      pitRatePercent: this.get('TAX_PIT_RATE_PERCENT'),
    };
  }

  /** Biểu giá điện sinh hoạt bậc thang (giá lấy từ cấu hình, độ rộng bậc theo quy định) */
  get evn() {
    const prices = this.get('EVN_TIER_PRICES_VND');
    return {
      tiers: EVN_RESIDENTIAL_TIERS.map((tier, i) => ({ ...tier, priceVnd: prices[i] })),
      vatRatePercent: this.get('EVN_VAT_RATE_PERCENT'),
      householdQuotaHeadcount: this.get('EVN_HOUSEHOLD_QUOTA_HEADCOUNT'),
      flatRateTier: EVN_RULES.FLAT_RATE_TIER,
    };
  }

  get billing() {
    return {
      timeZone: VN_BUSINESS_TIMEZONE,
      cycleDay: this.get('BILLING_CYCLE_DAY'),
      paymentDueDays: this.get('BILLING_PAYMENT_DUE_DAYS'),
      depositMonths: this.get('DEPOSIT_MONTHS'),
    };
  }

  getSanitizedConfig(): Record<string, any> {
    const db = this.database;
    const redis = this.redis;
    const security = this.security;
    const notification = this.notification;
    const storage = this.storage;

    return {
      app: this.app,
      nodeEnv: this.nodeEnv,
      port: this.port,
      apiPrefix: this.apiPrefix,
      apiDefaultVersion: this.apiDefaultVersion,
      trustProxy: this.trustProxy,
      logLevel: this.logLevel,
      allowedOrigins: this.allowedOrigins,
      http: this.http,
      database: {
        provider: db.provider,
        master: describeDatabaseTarget(db.master),
        masterHost: db.master.host,
        replica: db.replica ? describeDatabaseTarget(db.replica) : null,
        replicaHost: db.replica?.host ?? null,
        dbName: db.master.database,
        sslMode: db.sslMode,
        sslCaConfigured: db.ssl !== false && !!db.ssl.ca,
        ipFamily: db.ipFamily,
        poolMode: db.poolMode,
        pool: db.pool,
        statementTimeoutMs: db.statementTimeoutMs,
        rlsRoleCheck: db.rlsRoleCheck,
      },
      redis: {
        enabled: redis.enabled,
        target: describeRedisTarget(redis),
        mode: redis.mode,
        source: redis.source,
        host: redis.host,
        port: redis.port,
        db: redis.db,
        tls: redis.tls !== false,
        family: redis.family,
        passwordConfigured: !!redis.password,
      },
      throttler: this.throttler,
      resilience: this.resilience,
      shutdown: this.shutdown,
      tracing: this.tracing,
      metrics: { enabled: this.metrics.enabled, tokenConfigured: !!this.metrics.bearerToken },
      queue: this.queue,
      outbox: this.outbox,
      audit: this.audit,
      storage: {
        enabled: storage.enabled,
        endpoint: storage.endpoint ?? 'aws',
        bucket: storage.bucket,
        credentialsConfigured: !!storage.accessKeyId,
      },
      notification: {
        dryRun: notification.dryRun,
        smtp: !!notification.smtp,
        telegram: !!notification.telegram,
        zalo: !!notification.zalo,
        twilio: !!notification.twilio,
      },
      security: {
        encryptionKeyConfigured: !!security.encryptionKey,
        encryptionKeyVersion: security.encryptionKeyVersion,
        legacyEncryptionKeyVersions: security.encryptionLegacyKeys.map((k) => k.version),
        jwtAlgorithm: security.jwt.algorithm,
        jwtSecretConfigured: !!security.jwt.secret,
        jwtRefreshSecretConfigured: !!security.jwt.refreshSecret,
        jwtIssuer: security.jwt.issuer ?? null,
        jwtAudience: security.jwt.audience ?? null,
      },
      tax: this.tax,
      evn: this.evn,
      billing: this.billing,
    };
  }
}
