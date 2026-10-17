/**
 * Chuyển chuỗi thời lượng kiểu jsonwebtoken / vercel-ms rút gọn ("15m", "7d", "3600", "45s", "12h")
 * thành số giây. Dùng cho TTL access token (khóa thu hồi phiên) và hạn phiên refresh.
 */
const DURATION = /^(\d+)\s*([smhd]?)$/i;
const UNIT_SECONDS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

export function isValidDuration(value: string): boolean {
  const match = DURATION.exec(value.trim());
  return !!match && Number(match[1]) > 0;
}

export function parseDurationSeconds(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match || Number(match[1]) <= 0) {
    throw new Error(`Invalid duration '${value}' (expected e.g. 900, 45s, 15m, 12h, 7d).`);
  }
  return Number(match[1]) * UNIT_SECONDS[match[2].toLowerCase()];
}
