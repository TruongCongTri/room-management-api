/**
 * Cung cấp dịch vụ mã hóa đối xứng AES-256-GCM để bảo vệ dữ liệu nhạy cảm
 * (số hộ chiếu, số thẻ, API credentials) với key versioning:
 *   enc:<keyVersion>:<iv_hex>:<tag_hex>:<ciphertext_hex>
 *
 * Xoay khóa không downtime:
 *   1. Đặt khóa mới vào ENCRYPTION_KEY + ENCRYPTION_KEY_VERSION (vd: v2),
 *      chuyển khóa cũ sang ENCRYPTION_LEGACY_KEYS ("v1:<hex>"), rolling restart.
 *   2. (Tùy chọn) chạy job re-encrypt dữ liệu cũ, sau đó gỡ khóa cũ.
 *   rotateKey() hỗ trợ nạp khóa runtime (vd: từ Vault/KMS) mà không cần restart.
 *
 * Blind index (computeBlindIndex): HMAC-SHA256(normalized, BLIND_INDEX_PEPPER) - tất định nên dùng được cho
 * cột UNIQUE / WHERE (vd: tenants.id_card_hash) mà không cần giải mã bảng.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';

const ENVELOPE_PREFIX = 'enc';
const HEX_256_BIT = /^[0-9a-fA-F]{64}$/;
const KEY_VERSION = /^[A-Za-z0-9_-]{1,16}$/;

@Injectable()
export class EncryptionService {
  /**
   * Instance toàn cục phục vụ TypeORM ValueTransformer (được khai báo tĩnh trên Entity,
   * trước khi DI container tồn tại).
   */
  private static instance?: EncryptionService;

  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12; // 96 bits chuẩn cho GCM
  private readonly tagLength = 16; // 128 bits auth tag

  // Bộ lưu trữ khóa theo phiên bản: Map<keyVersion, Buffer>
  private readonly keyStore = new Map<string, Buffer>();
  private activeKeyVersion: string;
  private readonly blindIndexPepper?: string;

  constructor(configService: AppConfigService) {
    const { encryptionKey, encryptionKeyVersion = 'v1', encryptionLegacyKeys = [], blindIndexPepper } =
      configService.security;
    this.blindIndexPepper = blindIndexPepper;

    for (const legacy of encryptionLegacyKeys) {
      this.keyStore.set(legacy.version, this.parseKey(legacy.version, legacy.key));
    }
    this.keyStore.set(encryptionKeyVersion, this.parseKey(encryptionKeyVersion, encryptionKey));
    this.activeKeyVersion = encryptionKeyVersion;

    EncryptionService.instance = this;
  }

  static getInstance(): EncryptionService {
    if (!EncryptionService.instance) {
      throw new Error(
        'EncryptionService is not initialized yet. Encrypted columns can only be used after the Nest application has bootstrapped.',
      );
    }
    return EncryptionService.instance;
  }

  get currentKeyVersion(): string {
    return this.activeKeyVersion;
  }

  /**
   * Xoay vòng khóa mã hóa runtime mà không cần restart server.
   * Lưu ý: khóa nạp runtime sẽ mất khi restart - phải cập nhật đồng thời ENV/Secret.
   */
  rotateKey(newVersion: string, newHexKey: string): void {
    const key = this.parseKey(newVersion, newHexKey);
    const existing = this.keyStore.get(newVersion);
    if (existing && !existing.equals(key)) {
      throw new Error(`Key version '${newVersion}' already exists with a different key.`);
    }
    this.keyStore.set(newVersion, key);
    this.activeKeyVersion = newVersion;
    this.logger.log(
      `[Security] Encryption key rotated to version '${newVersion}'. Previous keys retained for decryption.`,
    );
  }

  /**
   * Kiểm tra giá trị đã ở định dạng envelope được mã hóa chưa
   */
  isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(`${ENVELOPE_PREFIX}:`);
  }

  /**
   * Mã hóa chuỗi văn bản thuần (Plaintext) bằng phiên bản khóa hiện hành
   */
  encrypt(plaintext: string): string {
    if (plaintext === '' || plaintext === null || plaintext === undefined) return plaintext;

    try {
      const activeKey = this.keyStore.get(this.activeKeyVersion);
      if (!activeKey) {
        throw new Error(`Active encryption key '${this.activeKeyVersion}' is missing.`);
      }

      const iv = randomBytes(this.ivLength);
      const cipher = createCipheriv(this.algorithm, activeKey, iv, {
        authTagLength: this.tagLength,
      });
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENVELOPE_PREFIX,
        this.activeKeyVersion,
        iv.toString('hex'),
        authTag.toString('hex'),
        encrypted.toString('hex'),
      ].join(':');
    } catch (err: any) {
      this.logger.error(`Field-Level Encryption failed: ${err.message}`);
      throw new InternalServerErrorException('Data encryption failure.');
    }
  }

  /**
   * Giải mã chuỗi đã mã hóa. Giá trị chưa mã hóa (dữ liệu cũ trước khi bật FLE) được trả nguyên bản.
   */
  decrypt(cipherText: string): string {
    if (!this.isEncrypted(cipherText)) {
      return cipherText;
    }

    try {
      const parts = cipherText.split(':');
      if (parts.length !== 5) {
        throw new Error('Malformed ciphertext envelope.');
      }

      const [, version, ivHex, tagHex, dataHex] = parts;
      const decryptionKey = this.keyStore.get(version);
      if (!decryptionKey) {
        throw new Error(`Decryption key version '${version}' is not registered in keyStore.`);
      }

      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(tagHex, 'hex');
      if (iv.length !== this.ivLength || authTag.length !== this.tagLength) {
        throw new Error('Invalid IV or authentication tag length.');
      }

      const decipher = createDecipheriv(this.algorithm, decryptionKey, iv, {
        authTagLength: this.tagLength,
      });
      decipher.setAuthTag(authTag);

      return Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch (err: any) {
      this.logger.error(`Field-Level Decryption failed: ${err.message}`);
      throw new InternalServerErrorException(
        'Data decryption failure (authentication failed or corrupted ciphertext).',
      );
    }
  }

  /**
   * Blind index tất định cho tra cứu chính xác trên dữ liệu đã mã hóa.
   * Chuẩn hóa trước khi băm để "079 203 001 234", "079203001234 " và "b1234567" / "B1234567" khớp nhau:
   * NFKC → bỏ khoảng trắng, dấu chấm, gạch nối → chữ in hoa.
   */
  computeBlindIndex(value: string): string {
    if (!this.blindIndexPepper) {
      throw new Error('BLIND_INDEX_PEPPER is not configured; blind indexes cannot be computed.');
    }
    const normalized = normalizeForBlindIndex(value);
    if (!normalized) {
      throw new Error('Cannot compute a blind index for an empty value.');
    }
    return createHmac('sha256', this.blindIndexPepper).update(normalized, 'utf8').digest('hex');
  }

  private parseKey(version: string, hexKey: string): Buffer {
    if (!KEY_VERSION.test(version)) {
      throw new Error(`Invalid encryption key version '${version}' (allowed: [A-Za-z0-9_-]{1,16}).`);
    }
    if (!HEX_256_BIT.test(hexKey ?? '')) {
      throw new Error(`Encryption key '${version}' must be a 64-character hex string (32 bytes).`);
    }
    return Buffer.from(hexKey, 'hex');
  }
}

/** Chuẩn hóa giá trị định danh trước khi tính blind index */
export function normalizeForBlindIndex(value: string): string {
  return (value ?? '').normalize('NFKC').replace(/[\s.-]/g, '').toUpperCase();
}
