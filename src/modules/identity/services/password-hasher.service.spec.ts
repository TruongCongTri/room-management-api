import * as argon2 from 'argon2';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService (argon2id)', () => {
  const hasher = new PasswordHasherService();
  beforeAll(() => hasher.onModuleInit());

  it('should hash with argon2id and the OWASP parameters, and verify only the right password', async () => {
    const hash = await hasher.hash('Correct-Horse-9');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(hash.split('$')[3].split(',').sort()).toEqual(['m=19456', 'p=1', 't=2']);
    await expect(hasher.verify(hash, 'Correct-Horse-9')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'correct-horse-9')).resolves.toBe(false);
  });

  it('should salt every hash (same password → different hashes)', async () => {
    expect(await hasher.hash('Same-password-1')).not.toBe(await hasher.hash('Same-password-1'));
  });

  it('should accept the password typed on another keyboard (composed vs decomposed Vietnamese)', async () => {
    const hash = await hasher.hash('Mật khẩu ổn định');
    await expect(hasher.verify(hash, 'Mật khẩu ổn định'.normalize('NFD'))).resolves.toBe(true);
  });

  it('should treat a corrupted hash as a wrong password instead of throwing', async () => {
    await expect(hasher.verify('$argon2id$garbage', 'whatever')).resolves.toBe(false);
  });

  it('should ask for a rehash of hashes made with weaker parameters', async () => {
    const weak = await argon2.hash('Correct-Horse-9', { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(hasher.needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('Correct-Horse-9'))).toBe(false);
  });

  it('should spend a real argon2 verification when there is no hash (unknown number), so timing reveals nothing', async () => {
    const real = await hasher.hash('Correct-Horse-9');
    const time = async (fn: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = process.hrtime.bigint();
        await fn();
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      return samples.sort((a, b) => a - b)[2]; // trung vị
    };
    const withHash = await time(() => hasher.verify(real, 'Wrong-password-1'));
    const withoutHash = await time(() => hasher.verify(null, 'Wrong-password-1'));
    // Không có hash phải tốn cùng bậc chi phí (không "return false" ngay lập tức, vốn mất < 0.1 ms)
    expect(withoutHash).toBeGreaterThan(withHash * 0.5);
    await expect(hasher.verify(null, 'anything')).resolves.toBe(false);
    await expect(hasher.verify(undefined, 'anything')).resolves.toBe(false);
  });
});
