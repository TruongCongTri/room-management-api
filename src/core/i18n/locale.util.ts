/**
 * Chọn ngôn ngữ phản hồi theo RFC 9110 (Accept-Language có trọng số q):
 *   "ja-JP,ja;q=0.9,en;q=0.8" → 'ja'
 * Tham số ?lang= (link trong email, deep-link mobile) được ưu tiên nếu hợp lệ.
 */
export function resolveLocale(
  acceptLanguage: string | undefined,
  supported: readonly string[],
  fallback: string,
  queryLang?: string,
): string {
  const normalize = (tag: string): string | undefined => {
    const lower = tag.trim().toLowerCase();
    if (supported.includes(lower)) return lower;
    const base = lower.split('-')[0];
    return supported.includes(base) ? base : undefined;
  };

  if (queryLang) {
    const fromQuery = normalize(queryLang);
    if (fromQuery) return fromQuery;
  }

  if (!acceptLanguage) return fallback;

  const candidates = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag?.trim() ?? '', q, index };
    })
    .filter((c) => c.tag !== '' && Number.isFinite(c.q) && c.q > 0)
    // Cùng trọng số → giữ thứ tự client gửi
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of candidates) {
    if (tag === '*') return fallback;
    const locale = normalize(tag);
    if (locale) return locale;
  }
  return fallback;
}
