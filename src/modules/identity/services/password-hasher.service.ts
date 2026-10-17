/**
 * argon2id theo khuyến nghị OWASP (m = 19 MiB, t = 2, p = 1). Mật khẩu được chuẩn hóa NFKC trước khi băm.
 * verifyAgainstDummy(): so với một hash giả có cùng tham số khi số điện thoại không tồn tại / chưa có mật khẩu,
 * để thời gian phản hồi không tiết lộ số nào đã đăng ký.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { normalizePassword } from '../domain/password-policy';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordHasherService implements OnModuleInit {
  private dummyHash?: Promise<string>;

  onModuleInit(): void {
    this.dummyHash ??= argon2.hash('dummy-password-for-constant-time', ARGON2_OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(normalizePassword(password), ARGON2_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      await this.verifyAgainstDummy(password);
      return false;
    }
    try {
      return await argon2.verify(hash, normalizePassword(password));
    } catch {
      return false; // hash hỏng → coi như sai mật khẩu, không lộ lỗi nội bộ
    }
  }

  /** Hash cũ có tham số yếu hơn cấu hình hiện tại → băm lại sau khi đăng nhập thành công */
  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  private async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash('dummy-password-for-constant-time', ARGON2_OPTIONS);
    await argon2.verify(await this.dummyHash, normalizePassword(password)).catch(() => false);
  }
}
