/**
 * TypeORM ValueTransformer
 *  cho phép nhúng trực tiếp vào Decorator @Column của Entity,
 *  tự động mã hóa trước khi ghi vào Database
 *  và tự động giải mã khi query lên.
 *
 * @example
 *   @Column({ type: 'text', transformer: EncryptedColumn })
 *   passportNumber: string;
 *
 * Lưu ý: ciphertext ngẫu nhiên (IV mới mỗi lần) nên KHÔNG thể WHERE/UNIQUE trên cột mã hóa;
 * cần tìm kiếm thì bổ sung cột blind-index (HMAC) riêng.
 */
import { ValueTransformer } from 'typeorm';
import { EncryptionService } from './encryption.service';

export class EncryptionTransformer implements ValueTransformer {
  /**
   * @param encryptionService Truyền tường minh (unit test) hoặc bỏ trống để dùng instance của Nest DI
   */
  constructor(private readonly encryptionService?: EncryptionService) {}

  private get service(): EncryptionService {
    return this.encryptionService ?? EncryptionService.getInstance();
  }

  /**
   * Ghi vào Database: Tự động mã hóa (bỏ qua giá trị đã mã hóa để tránh mã hóa 2 lần)
   */
  to(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    if (this.service.isEncrypted(value)) return value;
    return this.service.encrypt(value);
  }

  /**
   * Đọc từ Database: Tự động giải mã
   */
  from(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    return this.service.decrypt(value);
  }
}

/**
 * Transformer dùng chung cho Entity (lazy resolve EncryptionService sau khi app bootstrap)
 */
export const EncryptedColumn = new EncryptionTransformer();

/**
 * @deprecated Dùng `EncryptedColumn` - Entity được khai báo trước khi có DI nên không thể truyền service.
 */
export const EncryptionColumn = (service?: EncryptionService): EncryptionTransformer =>
  new EncryptionTransformer(service);

/** Tên theo tài liệu 01 (mục 3.3): `@Column({ transformer: new FieldEncryptionTransformer() })` */
export { EncryptionTransformer as FieldEncryptionTransformer };
