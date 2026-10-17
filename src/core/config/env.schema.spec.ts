import { validateEnv, describeEnvValue, applyEnvAliases } from './env.schema';
import { AppConfigService } from './app-config.service';
import { configServiceFrom } from './load-config';

describe('AppConfigModule - Env Validation & ConfigService (Unit Test)', () => {
  const KEY_V1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const KEY_V0 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  const validMockEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_MASTER_HOST: '127.0.0.1',
    DB_MASTER_USER: 'postgres',
    DB_MASTER_PASSWORD: 'secretpassword',
    DB_NAME: 'room_management_test',
    DB_REPLICA_HOST: '127.0.0.2',
    DB_REPLICA_USER: 'postgres',
    DB_REPLICA_PASSWORD: 'secretpassword',
    ENCRYPTION_KEY: KEY_V1,
    BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
    JWT_SECRET: 'super-secret-jwt-key-with-minimum-32-chars-long!',
    JWT_REFRESH_SECRET: 'super-secret-jwt-refresh-key-with-minimum-32-chars!',
  };

  const productionEnv: Record<string, string> = {
    ...validMockEnv,
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://app.rental.vn,*.rental.vn',
    REDIS_ENABLED: 'true',
  };

  const buildConfig = (env: Record<string, string>) => {
    const parsed = validateEnv(env);
    return new AppConfigService(configServiceFrom(parsed));
  };

  it('should successfully parse and coerce valid environment variables', () => {
    const parsed = validateEnv(validMockEnv);

    expect(parsed.PORT).toBe(4000); // Tự động coerce từ string sang number
    expect(parsed.DB_POOL_MAX).toBe(20); // Giá trị mặc định
    expect(parsed.REDIS_PORT).toBe(6379);
    expect(parsed.API_PREFIX).toBe('api'); // URI versioning tự thêm /v1
    expect(parsed.API_DEFAULT_VERSION).toBe('1');
    expect(parsed.TRUST_PROXY).toBe(false);
  });

  it('should parse boolean strings correctly ("false" must not become true)', () => {
    expect(validateEnv({ ...validMockEnv, REDIS_ENABLED: 'false' }).REDIS_ENABLED).toBe(false);
    expect(validateEnv({ ...validMockEnv, DB_LOG_QUERIES: '1' }).DB_LOG_QUERIES).toBe(true);
    // Biến để trống trong .env (KEY=) dùng giá trị mặc định thay vì 0 / lỗi
    expect(validateEnv({ ...validMockEnv, DB_MASTER_PORT: '', REDIS_TLS: '' }).DB_MASTER_PORT).toBe(5432);
  });

  it('should parse TRUST_PROXY as hop count, boolean or subnet list', () => {
    expect(validateEnv({ ...validMockEnv, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(validateEnv({ ...validMockEnv, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(validateEnv({ ...validMockEnv, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).TRUST_PROXY).toBe(
      'loopback, 10.0.0.0/8',
    );
  });

  it('should fail-fast when a mandatory variable (DB_MASTER_HOST) is missing', () => {
    const invalidEnv = { ...validMockEnv };
    delete invalidEnv.DB_MASTER_HOST;

    expect(() => validateEnv(invalidEnv)).toThrow(/CRITICAL APPLICATION BOOTSTRAP FAILURE/i);
  });

  it('should render a readable VARIABLE | CURRENT VALUE | PROBLEM table without leaking secrets', () => {
    let message = '';
    try {
      validateEnv({ ...validMockEnv, DB_MASTER_PASSWORD: '', PORT: 'abc' });
    } catch (err: any) {
      message = err.message;
    }

    expect(message).toMatch(/VARIABLE\s+\| CURRENT VALUE\s+\| PROBLEM/);
    expect(message).toMatch(/DB_MASTER_PASSWORD\s+\| <missing>/);
    expect(message).toMatch(/PORT\s+\| "abc"/);
    expect(message).not.toContain('secretpassword');
  });

  it('should mask secret-like variables when describing values', () => {
    expect(describeEnvValue('JWT_SECRET', 'abcdef')).toBe('<redacted, 6 chars>');
    expect(describeEnvValue('DB_MASTER_HOST', 'db.internal')).toBe('"db.internal"');
  });

  it('should require a BLIND_INDEX_PEPPER of at least 32 characters that differs from ENCRYPTION_KEY', () => {
    expect(() => validateEnv({ ...validMockEnv, BLIND_INDEX_PEPPER: '' })).toThrow(/BLIND_INDEX_PEPPER/);
    expect(() => validateEnv({ ...validMockEnv, BLIND_INDEX_PEPPER: 'short' })).toThrow(/at least 32 characters/);
    expect(() => validateEnv({ ...validMockEnv, BLIND_INDEX_PEPPER: KEY_V1 })).toThrow(/must differ from ENCRYPTION_KEY/);
  });

  it('should throw when ENCRYPTION_KEY is not exactly 64 hex characters', () => {
    expect(() => validateEnv({ ...validMockEnv, ENCRYPTION_KEY: 'too_short_key' })).toThrow(
      /ENCRYPTION_KEY must be exactly a 64-character HEX string/i,
    );
    // Đủ 64 ký tự nhưng không phải hex → Buffer.from(hex) sẽ ra khóa sai độ dài
    expect(() => validateEnv({ ...validMockEnv, ENCRYPTION_KEY: 'z'.repeat(64) })).toThrow(
      /ENCRYPTION_KEY must be exactly a 64-character HEX string/i,
    );
  });

  it('should validate ENCRYPTION_LEGACY_KEYS format and forbid redefining the active version', () => {
    expect(() =>
      validateEnv({ ...validMockEnv, ENCRYPTION_LEGACY_KEYS: 'v0:not-hex' }),
    ).toThrow(/ENCRYPTION_LEGACY_KEYS must be a comma-separated list/);

    expect(() =>
      validateEnv({ ...validMockEnv, ENCRYPTION_LEGACY_KEYS: `v1:${KEY_V0}` }),
    ).toThrow(/must not redefine the active version 'v1'/);

    const config = buildConfig({ ...validMockEnv, ENCRYPTION_LEGACY_KEYS: `v0:${KEY_V0}` });
    expect(config.security.encryptionLegacyKeys).toEqual([{ version: 'v0', key: KEY_V0 }]);
  });

  it('should throw an error when JWT_SECRET is shorter than 32 characters', () => {
    expect(() => validateEnv({ ...validMockEnv, JWT_SECRET: 'short_jwt_secret' })).toThrow(
      /JWT_SECRET must be at least 32 characters long/i,
    );
  });

  it('should forbid echoing OTP codes in production but allow it locally', () => {
    expect(validateEnv({ ...validMockEnv, AUTH_OTP_DEBUG_ECHO: 'true' }).AUTH_OTP_DEBUG_ECHO).toBe(true);
    expect(() => validateEnv({ ...productionEnv, AUTH_OTP_DEBUG_ECHO: 'true' })).toThrow(/AUTH_OTP_DEBUG_ECHO/);
    expect(() => validateEnv({ ...productionEnv, AUTH_OTP_DEBUG_ECHO: 'false' })).not.toThrow();
  });

  it('should validate session durations and derive the auth settings in seconds', () => {
    expect(() => validateEnv({ ...validMockEnv, JWT_REFRESH_EXPIRES_IN: 'seven days' })).toThrow(/JWT_REFRESH_EXPIRES_IN/);
    expect(() => validateEnv({ ...validMockEnv, AUTH_REFRESH_ABSOLUTE_EXPIRES_IN: '0d' })).toThrow(/AUTH_REFRESH_ABSOLUTE_EXPIRES_IN/);
    expect(() => validateEnv({ ...validMockEnv, AUTH_LOCK_BASE_SEC: '3600', AUTH_LOCK_MAX_SEC: '600' })).toThrow(/AUTH_LOCK_MAX_SEC/);

    const auth = buildConfig({ ...validMockEnv, JWT_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d', AUTH_MFA_ROLES: ' LANDLORD , ACCOUNTANT,' }).auth;
    expect(auth.accessTokenTtlSec).toBe(900);
    expect(auth.refreshIdleTtlSec).toBe(604_800);
    expect(auth.refreshAbsoluteTtlSec).toBe(2_592_000);
    expect(auth.mfaRoles).toEqual(['LANDLORD', 'ACCOUNTANT']);
  });

  it('should reject inconsistent pool and shutdown settings', () => {
    expect(() => validateEnv({ ...validMockEnv, DB_POOL_MIN: '50', DB_POOL_MAX: '10' })).toThrow(
      /DB_POOL_MIN must be <= DB_POOL_MAX/,
    );
    expect(() =>
      validateEnv({ ...validMockEnv, SHUTDOWN_DRAIN_DELAY_MS: '30000', SHUTDOWN_TIMEOUT_MS: '25000' }),
    ).toThrow(/SHUTDOWN_DRAIN_DELAY_MS must be < SHUTDOWN_TIMEOUT_MS/);
  });

  describe('DATABASE_* aliases (.env.local convention)', () => {
    it('should map DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME/SSL onto DB_MASTER_* without overriding canonical names', () => {
      const resolved = applyEnvAliases({
        DATABASE_HOST: 'localhost',
        DATABASE_PORT: '5432',
        DATABASE_USERNAME: 'postgres',
        DATABASE_PASSWORD: 'secret',
        DATABASE_NAME: 'room_management_db',
        DATABASE_SSL: 'false',
        DB_NAME: 'explicit_db',
      });
      expect(resolved).toEqual(
        expect.objectContaining({
          DB_MASTER_HOST: 'localhost',
          DB_MASTER_PORT: '5432',
          DB_MASTER_USER: 'postgres',
          DB_MASTER_PASSWORD: 'secret',
          DB_NAME: 'explicit_db',
          DB_SSL_MODE: 'disable',
        }),
      );
    });

    it('should reject a non-PostgreSQL DATABASE_TYPE', () => {
      expect(() => validateEnv({ DATABASE_TYPE: 'mysql' })).toThrow(/requires PostgreSQL/);
    });
  });

  describe('Production-only guard rails', () => {
    it('should accept a hardened production configuration', () => {
      expect(() => validateEnv(productionEnv)).not.toThrow();
    });

    it('should reject wildcard CORS in production', () => {
      expect(() => validateEnv({ ...productionEnv, ALLOWED_ORIGINS: '*' })).toThrow(
        /Wildcard '\*' CORS origin is not allowed in production/,
      );
    });

    it('should reject disabled Redis in production', () => {
      expect(() => validateEnv({ ...productionEnv, REDIS_ENABLED: 'false' })).toThrow(
        /Redis is mandatory in production/,
      );
    });

    it('should reject identical access/refresh JWT secrets in production', () => {
      expect(() =>
        validateEnv({ ...productionEnv, JWT_REFRESH_SECRET: productionEnv.JWT_SECRET }),
      ).toThrow(/JWT_REFRESH_SECRET must differ from JWT_SECRET/);
    });
  });

  describe('AppConfigService', () => {
    it('should expose strongly-typed grouped getters', () => {
      const appConfig = buildConfig(validMockEnv);

      expect(appConfig.isTest).toBe(true);
      expect(appConfig.database.master.host).toBe('127.0.0.1');
      expect(appConfig.database.replica?.host).toBe('127.0.0.2');
      expect(appConfig.redis.enabled).toBe(true);
      expect(appConfig.shutdown.timeoutMs).toBe(25000);
      expect(appConfig.logLevel).toBe('debug');
    });

    it('should fall back to master when no replica is configured', () => {
      const env = { ...validMockEnv };
      delete env.DB_REPLICA_HOST;
      delete env.DB_REPLICA_USER;
      delete env.DB_REPLICA_PASSWORD;

      expect(buildConfig(env).database.replica).toBeUndefined();
    });

    it('should split CORS origins', () => {
      expect(buildConfig(productionEnv).allowedOrigins).toEqual([
        'https://app.rental.vn',
        '*.rental.vn',
      ]);
    });

    it('should sanitize sensitive information', () => {
      const sanitized = buildConfig(validMockEnv).getSanitizedConfig();
      const serialized = JSON.stringify(sanitized);

      expect(sanitized.database.masterHost).toBe('127.0.0.1');
      expect(sanitized.security.encryptionKeyConfigured).toBe(true);
      expect(serialized).not.toContain('secretpassword');
      expect(serialized).not.toContain(KEY_V1);
      expect(serialized).not.toContain(validMockEnv.JWT_SECRET);
    });
  });
});

// npx jest src/core/config/env.schema.spec.ts
