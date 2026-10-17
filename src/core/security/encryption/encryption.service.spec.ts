import { EncryptionService } from './encryption.service';
import { EncryptionTransformer, EncryptedColumn } from './encryption.transformer';
import { AppConfigService } from '../../config/app-config.service';

describe('EncryptionService & Field-Level Encryption (Enterprise Suite)', () => {
  let service: EncryptionService;
  let transformer: EncryptionTransformer;

  const validKeyHexV1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validKeyHexV2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  const configWith = (security: Record<string, unknown>) =>
    ({ security }) as unknown as AppConfigService;

  beforeEach(() => {
    service = new EncryptionService(
      configWith({ encryptionKey: validKeyHexV1, encryptionKeyVersion: 'v1' }),
    );
    transformer = new EncryptionTransformer(service);
  });

  describe('computeBlindIndex (deterministic lookup on encrypted CCCD / passport)', () => {
    const PEPPER = 'test-blind-index-pepper-with-at-least-32-characters';
    const withPepper = (pepper?: string) =>
      new EncryptionService(configWith({ encryptionKey: validKeyHexV1, encryptionKeyVersion: 'v1', blindIndexPepper: pepper }));

    it('should match a fixed HMAC-SHA256 vector (changing the algorithm silently breaks every stored id_card_hash)', () => {
      expect(withPepper(PEPPER).computeBlindIndex('079203001234')).toBe(
        '99c100673d3b12503ba2f3d146c36e016a8fbc780350ad293bc5d9c1a80b00d0',
      );
    });

    it('should treat formatting variants of the same identifier as equal', () => {
      const svc = withPepper(PEPPER);
      const canonical = svc.computeBlindIndex('079203001234');
      expect(svc.computeBlindIndex(' 079 203 001 234 ')).toBe(canonical);
      expect(svc.computeBlindIndex('079-203-001-234')).toBe(canonical);
      expect(svc.computeBlindIndex('b1234567')).toBe(svc.computeBlindIndex('B1234567'));
    });

    it('should distinguish different identifiers and depend on the pepper', () => {
      const svc = withPepper(PEPPER);
      expect(svc.computeBlindIndex('079203001234')).not.toBe(svc.computeBlindIndex('079203001235'));
      expect(withPepper(`${PEPPER}-other`).computeBlindIndex('079203001234')).not.toBe(svc.computeBlindIndex('079203001234'));
    });

    it('should refuse to hash empty input or run without a pepper (fail closed)', () => {
      expect(() => withPepper(PEPPER).computeBlindIndex('  - . ')).toThrow(/empty value/);
      expect(() => withPepper(undefined).computeBlindIndex('079203001234')).toThrow(/BLIND_INDEX_PEPPER/);
    });
  });

  it('should encrypt plaintext into versioned ciphertext envelope', () => {
    const rawPassport = 'B12345678';
    const encrypted = service.encrypt(rawPassport);

    // Format: enc:<version>:<iv>:<tag>:<ciphertext>
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(encrypted.split(':')).toHaveLength(5);
    expect(service.decrypt(encrypted)).toBe(rawPassport);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('should throw an error if ciphertext authentication tag is tampered with', () => {
    const parts = service.encrypt('SECRET_CREDIT_CARD_DATA').split(':');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('00') ? '11' : '00');

    expect(() => service.decrypt(parts.join(':'))).toThrow(/Data decryption failure/i);
  });

  it('should reject truncated authentication tags', () => {
    const parts = service.encrypt('data').split(':');
    parts[3] = parts[3].slice(0, 8);
    expect(() => service.decrypt(parts.join(':'))).toThrow(/Data decryption failure/i);
  });

  it('should decrypt legacy data encrypted with v1 after key is rotated to v2 without restart', () => {
    const sensitiveData = 'CITIZEN_ID_999888';
    const encryptedV1 = service.encrypt(sensitiveData);

    service.rotateKey('v2', validKeyHexV2);

    const encryptedV2 = service.encrypt('CITIZEN_ID_111222');
    expect(encryptedV2.startsWith('enc:v2:')).toBe(true);

    expect(service.decrypt(encryptedV1)).toBe(sensitiveData);
    expect(service.decrypt(encryptedV2)).toBe('CITIZEN_ID_111222');
  });

  it('should still decrypt old data after a RESTART with the new key, using ENCRYPTION_LEGACY_KEYS', () => {
    const encryptedV1 = service.encrypt('PASSPORT_OLD');

    // Pod mới khởi động với khóa v2 active và v1 trong danh sách legacy
    const restarted = new EncryptionService(
      configWith({
        encryptionKey: validKeyHexV2,
        encryptionKeyVersion: 'v2',
        encryptionLegacyKeys: [{ version: 'v1', key: validKeyHexV1 }],
      }),
    );

    expect(restarted.currentKeyVersion).toBe('v2');
    expect(restarted.decrypt(encryptedV1)).toBe('PASSPORT_OLD');
  });

  it('should refuse to silently overwrite an existing key version with a different key', () => {
    expect(() => service.rotateKey('v1', validKeyHexV2)).toThrow(/already exists/);
  });

  it('should reject non-hex keys and versions containing the envelope separator', () => {
    expect(() => service.rotateKey('v3', 'z'.repeat(64))).toThrow(/64-character hex/);
    expect(() => service.rotateKey('v:3', validKeyHexV2)).toThrow(/Invalid encryption key version/);
  });

  it('EncryptionTransformer should seamlessly handle TypeORM to/from lifecycle', () => {
    const rawCardNumber = '4111-2222-3333-4444';

    const dbValue = transformer.to(rawCardNumber);
    expect(dbValue).not.toBe(rawCardNumber);
    expect(dbValue?.startsWith('enc:v1:')).toBe(true);
    expect(transformer.from(dbValue)).toBe(rawCardNumber);

    // Không mã hóa 2 lần giá trị đã mã hóa
    expect(transformer.to(dbValue)).toBe(dbValue);

    expect(transformer.to(null)).toBeNull();
    expect(transformer.from(undefined)).toBeUndefined();
  });

  it('EncryptedColumn should lazily resolve the DI-managed EncryptionService', () => {
    const dbValue = EncryptedColumn.to('LAZY_RESOLVE');
    expect(EncryptedColumn.from(dbValue)).toBe('LAZY_RESOLVE');
  });
});

// npx jest src/core/security/encryption/encryption.service.spec.ts
