/**
 * Bộ dựng schema dùng chung cho biến môi trường.
 * File .env thường có dạng `KEY=` (chuỗi rỗng): mọi helper đều coi chuỗi rỗng là "chưa cấu hình"
 * để giá trị mặc định được áp dụng, thay vì z.coerce.number('') → 0 hay stringbool('') → lỗi.
 */
import { existsSync } from 'fs';
import { z } from 'zod';

export const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Boolean từ chuỗi env ('true'/'false'/'1'/'0'/'yes'/'no'). z.coerce.boolean() coi 'false' là true nên không dùng. */
export const envBool = (defaultValue: boolean) =>
  z.preprocess(emptyToUndefined, z.stringbool().default(defaultValue));

export const envOptionalBool = () =>
  z.preprocess(emptyToUndefined, z.stringbool().optional());

export const envInt = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(min).max(max).default(defaultValue),
  );

export const envOptionalInt = (min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional());

export const envNumber = (defaultValue: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(defaultValue));

export const envString = (defaultValue: string) =>
  z.preprocess(emptyToUndefined, z.string().trim().default(defaultValue));

export const envOptionalString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().optional());

export const envEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
) => z.preprocess(emptyToUndefined, z.enum(values).default(defaultValue as any));

export const envOptionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(emptyToUndefined, z.enum(values).optional());

/** Họ địa chỉ IP: 0 = tự động (Happy Eyeballs), 4 = chỉ IPv4, 6 = chỉ IPv6 */
export const envIpFamily = () =>
  z.preprocess(
    (value) => {
      const v = emptyToUndefined(value);
      if (typeof v !== 'string') return v;
      const normalized = v.trim().toLowerCase();
      if (normalized === 'auto' || normalized === 'any') return '0';
      if (normalized === 'ipv4') return '4';
      if (normalized === 'ipv6') return '6';
      return normalized;
    },
    z.enum(['0', '4', '6']).default('0').transform((v) => Number(v) as 0 | 4 | 6),
  );

export type ZodRefineCtx = z.core.$RefinementCtx<any>;

export function addIssue(ctx: ZodRefineCtx, path: string, message: string): void {
  ctx.addIssue({ code: 'custom', path: [path], message });
}

/** Giá trị là chứng chỉ/khóa PEM nhúng trực tiếp (hỗ trợ "\n" thoát trong biến môi trường một dòng) */
export function isInlinePem(value: string): boolean {
  return value.includes('-----BEGIN');
}

/** Kiểm tra biến dạng "PEM nội tuyến hoặc đường dẫn file" ngay lúc boot (fail-fast) */
export function assertPemOrPath(
  ctx: ZodRefineCtx,
  name: string,
  value: string | undefined,
): void {
  if (!value || isInlinePem(value)) return;
  if (!existsSync(value)) {
    addIssue(ctx, name, `${name} must be an inline PEM ("-----BEGIN ...") or an existing file path`);
  }
}

export function parseUrlSafe(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Bỏ ngoặc vuông của IPv6 literal trong URL: "[::1]" → "::1" */
export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
