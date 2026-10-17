/**
 * Giữ .env.example đồng bộ với schema: mọi biến trong schema đều được tài liệu hóa (kể cả dạng comment),
 * không có biến "mồ côi" đã bị xóa khỏi schema, và file mẫu hợp lệ khi điền các secret bắt buộc.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';
import { envSchema, validateEnv } from './env.schema';

const EXAMPLE_PATH = join(__dirname, '..', '..', '..', '.env.example');

describe('.env.example', () => {
  const content = readFileSync(EXAMPLE_PATH, 'utf8');
  const activeValues = parse(content);
  const documentedKeys = new Set(
    content
      .split(/\r?\n/)
      .map((line) => /^\s*#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((key): key is string => !!key),
  );
  const schemaKeys = Object.keys(envSchema.shape);

  it('should document every variable of the schema', () => {
    const undocumented = schemaKeys.filter((key) => !documentedKeys.has(key));
    expect(undocumented).toEqual([]);
  });

  it('should not contain variables that the schema does not know', () => {
    const unknown = [...documentedKeys].filter((key) => !schemaKeys.includes(key));
    expect(unknown).toEqual([]);
  });

  it('should be valid once the required secrets are filled in', () => {
    expect(() =>
      validateEnv({
        ...activeValues,
        DB_MASTER_PASSWORD: 'local-password',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
        JWT_SECRET: 'local-jwt-secret-with-at-least-32-characters',
        JWT_REFRESH_SECRET: 'local-refresh-secret-with-at-least-32-characters',
      }),
    ).not.toThrow();
  });
});
