/**
 * Bộ nhớ đệm LRU trong tiến trình có TTL:
 *  - Fallback khi Redis mất kết nối (Fail-Open, không làm gián đoạn nghiệp vụ).
 *  - Near-cache L1 (CACHE_L1_TTL_SECONDS) giảm round-trip Redis cho key nóng.
 * Map của JS giữ thứ tự chèn → xóa rồi chèn lại để đánh dấu "mới dùng".
 */
interface MemoryEntry<V> {
  value: V;
  expiresAt: number;
  storedAt: number;
}

export class MemoryLruStore<V> {
  private readonly entries = new Map<string, MemoryEntry<V>>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, maxAgeMs?: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (entry.expiresAt <= now || (maxAgeMs !== undefined && now - entry.storedAt > maxAgeMs)) {
      if (entry.expiresAt <= now) this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs, storedAt: now });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
