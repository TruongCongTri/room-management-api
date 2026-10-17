import { BulkheadOptions } from './resilience.interface';

/** Lỗi riêng của Bulkhead để phân biệt với lỗi do downstream ném ra */
export class BulkheadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadRejectedError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Semaphore giới hạn số lời gọi đồng thời tới một đối tác (Bulkhead Pattern).
 * Khi một slot được giải phóng, slot được chuyển thẳng cho request đang chờ
 * (không giảm rồi tăng lại) nên không thể vượt quá maxConcurrent.
 */
export class Bulkhead {
  private activeCount = 0;
  private readonly queue: Waiter[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs?: number;

  constructor(
    public readonly name: string,
    options: BulkheadOptions,
  ) {
    if (options.maxConcurrent < 1) {
      throw new Error(`[Bulkhead:${name}] maxConcurrent must be >= 1`);
    }
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueue = options.maxQueue ?? 0;
    this.queueTimeoutMs = options.queueTimeoutMs;
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new BulkheadRejectedError(
          `[Bulkhead:${this.name}] Concurrency limit reached (${this.maxConcurrent} active, ${this.queue.length} queued). Request rejected fail-fast.`,
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (this.queueTimeoutMs) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(
            new BulkheadRejectedError(
              `[Bulkhead:${this.name}] Waited ${this.queueTimeoutMs}ms for a free slot. Request rejected.`,
            ),
          );
        }, this.queueTimeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Chuyển giao slot trực tiếp: activeCount giữ nguyên
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.activeCount--;
  }
}
