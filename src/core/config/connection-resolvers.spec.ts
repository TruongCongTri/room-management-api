/**
 * Kiểm thử phân giải cấu hình kết nối cho các môi trường triển khai thực tế:
 *  - PostgreSQL local (biến rời, IPv6 ::1) và Supabase (pooler IPv4 / direct IPv6, TLS, transaction mode).
 *  - Redis Docker local và Redis managed (rediss:// TLS + SNI, IPv6, Sentinel).
 */
import { validateEnv, describeEnvValue } from './env.schema';
import { resolveDatabaseConfig, describeDatabaseTarget } from './resolvers/database.resolver';
import { buildRedisOptions, describeRedisTarget, resolveRedisConfig } from './resolvers/redis.resolver';
import { buildDriverExtra } from '../database/database.options';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
  JWT_SECRET: 'super-secret-jwt-key-with-minimum-32-chars-long!',
  JWT_REFRESH_SECRET: 'super-secret-jwt-refresh-key-with-minimum-32-chars!',
};

const LOCAL_DB: Record<string, string> = {
  DB_MASTER_HOST: '::1',
  DB_MASTER_USER: 'postgres',
  DB_MASTER_PASSWORD: 'postgres',
  DB_NAME: 'room_management',
};

describe('Database connection resolver', () => {
  it('should resolve a local PostgreSQL over IPv6 loopback with a pinned family and no TLS', () => {
    const env = validateEnv({ ...BASE_ENV, ...LOCAL_DB, DB_IP_FAMILY: '6' });
    const db = resolveDatabaseConfig(env);

    expect(db.master).toEqual({ host: '::1', port: 5432, username: 'postgres', password: 'postgres', database: 'room_management' });
    expect(db.provider).toBe('postgres');
    expect(db.ipFamily).toBe(6);
    expect(db.ssl).toBe(false);
    expect(db.poolMode).toBe('session');
    expect(db.replica).toBeUndefined();
    expect(describeDatabaseTarget(db.master)).toBe('postgres@[::1]:5432/room_management');
  });

  it('should reject a family that contradicts an IP literal host', () => {
    expect(() => validateEnv({ ...BASE_ENV, ...LOCAL_DB, DB_IP_FAMILY: '4' })).toThrow(/DB_IP_FAMILY=4 contradicts/);
  });

  it('should parse the Supabase session pooler URL (IPv4) and require TLS by default', () => {
    const env = validateEnv({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres.abcdefghijkl:S3cr%40t@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      DB_IP_FAMILY: '4',
    });
    const db = resolveDatabaseConfig(env);

    expect(db.provider).toBe('supabase-pooler');
    expect(db.master.username).toBe('postgres.abcdefghijkl');
    expect(db.master.password).toBe('S3cr@t'); // URL-decoded
    expect(db.sslMode).toBe('require');
    expect(db.ssl).toEqual({ rejectUnauthorized: false });
    expect(db.poolMode).toBe('session');
    expect(db.ipFamily).toBe(4);
  });

  it('should detect the Supabase transaction pooler (:6543) and omit unsupported startup parameters', () => {
    const env = validateEnv({
      ...BASE_ENV,
      DATABASE_URL: 'postgres://postgres.ref123:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require',
    });
    const db = resolveDatabaseConfig(env);
    const extra = buildDriverExtra(db);

    expect(db.poolMode).toBe('transaction');
    expect(extra.statement_timeout).toBeUndefined();
    expect(extra.idle_in_transaction_session_timeout).toBeUndefined();
    expect(extra.query_timeout).toBe(db.statementTimeoutMs + 1000); // timeout phía driver vẫn được giữ
  });

  it('should send server-side timeouts as startup parameters in session mode and pin the socket family', () => {
    const db = resolveDatabaseConfig(validateEnv({ ...BASE_ENV, ...LOCAL_DB, DB_IP_FAMILY: '6', DB_LOCK_TIMEOUT_MS: '3000' }));
    const extra = buildDriverExtra(db);

    expect(extra.statement_timeout).toBe(15000);
    expect(extra.idle_in_transaction_session_timeout).toBe(30000);
    expect(extra.lock_timeout).toBe(3000);
    expect(typeof extra.stream).toBe('function');
  });

  it('should treat the Supabase direct host as IPv6-capable and map verify-full with a CA', () => {
    const env = validateEnv({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres:pw@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=verify-full',
      DB_SSL_CA: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
    });
    const db = resolveDatabaseConfig(env);

    expect(db.provider).toBe('supabase-direct');
    expect(db.ssl).toEqual({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' });
  });

  it('should fail fast with an actionable message when neither DATABASE_URL nor DB_MASTER_* is provided', () => {
    expect(() => validateEnv(BASE_ENV)).toThrow(/DB_MASTER_HOST is required \(or set DATABASE_URL\)/);
  });

  it('should reject non-postgres URLs and unknown sslmode values', () => {
    expect(() => validateEnv({ ...BASE_ENV, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/postgres:\/\/ or postgresql:\/\//);
    expect(() =>
      validateEnv({ ...BASE_ENV, DATABASE_URL: 'postgresql://u:p@h:5432/db?sslmode=allow' }),
    ).toThrow(/unsupported sslmode 'allow'/);
  });

  it('should never print the password of a connection string in the boot error table', () => {
    expect(describeEnvValue('DATABASE_URL', 'postgresql://postgres.ref:TopSecret@aws-0.pooler.supabase.com:5432/postgres')).not.toContain('TopSecret');
  });
});

describe('Redis connection resolver', () => {
  const env = (extra: Record<string, string>) => validateEnv({ ...BASE_ENV, ...LOCAL_DB, ...extra });

  it('should target the local Docker Redis by default (no TLS, keyPrefix on shared client only)', () => {
    const redis = resolveRedisConfig(env({}));

    expect(redis).toEqual(expect.objectContaining({ host: '127.0.0.1', port: 6379, db: 0, tls: false, source: 'discrete' }));
    expect(buildRedisOptions(redis, 'shared', 'api:shared')).toEqual(
      expect.objectContaining({ keyPrefix: 'rma:', enableOfflineQueue: false, maxRetriesPerRequest: 2 }),
    );
    // BullMQ cấm keyPrefix của ioredis và yêu cầu maxRetriesPerRequest = null
    const bull = buildRedisOptions(redis, 'bullmq', 'api:bullmq');
    expect(bull.keyPrefix).toBeUndefined();
    expect(bull.maxRetriesPerRequest).toBeNull();
  });

  it('should enable TLS with SNI for a managed rediss:// URL (Upstash / Redis Cloud)', () => {
    const redis = resolveRedisConfig(env({ REDIS_URL: 'rediss://default:p%40ss@eu1-free-cat-12345.upstash.io:6379' }));

    expect(redis).toEqual(
      expect.objectContaining({
        host: 'eu1-free-cat-12345.upstash.io',
        username: 'default',
        password: 'p@ss',
        tls: { rejectUnauthorized: true, ca: undefined, servername: 'eu1-free-cat-12345.upstash.io' },
        source: 'url',
      }),
    );
    expect(describeRedisTarget(redis)).toBe('rediss://eu1-free-cat-12345.upstash.io:6379/0');
  });

  it('should support IPv6-only providers via REDIS_FAMILY=6 and the database index in the URL', () => {
    const redis = resolveRedisConfig(env({ REDIS_URL: 'redis://[::1]:6380/3', REDIS_FAMILY: 'ipv6' }));
    const options = buildRedisOptions(redis, 'pubsub', 'socketio');

    expect(redis.host).toBe('::1');
    expect(redis.db).toBe(3);
    expect(options.family).toBe(6);
    expect(redis.tls).toBe(false);
  });

  it('should configure Sentinel HA and validate the sentinel list', () => {
    const redis = resolveRedisConfig(
      env({ REDIS_MODE: 'sentinel', REDIS_SENTINELS: '10.0.0.1:26379,10.0.0.2:26379', REDIS_SENTINEL_NAME: 'tba-master' }),
    );
    const options = buildRedisOptions(redis, 'shared', 'api');

    expect(options.sentinels).toEqual([
      { host: '10.0.0.1', port: 26379 },
      { host: '10.0.0.2', port: 26379 },
    ]);
    expect(options.name).toBe('tba-master');
    expect(() => env({ REDIS_MODE: 'sentinel' })).toThrow(/REDIS_SENTINELS is required/);
  });

  it('should reject malformed Redis URLs', () => {
    expect(() => env({ REDIS_URL: 'http://cache:6379' })).toThrow(/redis:\/\/ or rediss:\/\//);
  });
});
