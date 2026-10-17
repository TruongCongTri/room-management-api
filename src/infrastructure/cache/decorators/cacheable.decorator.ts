/**
 * Method decorator giúp tự động hóa việc cache kết quả của Service method (Cache-Aside + XFetch + Single-Flight).
 * Dùng `this.cacheService` nếu class có inject, ngược lại dùng instance toàn cục của RedisCacheService.
 */
import { CacheSetOptions } from '../interfaces/cache.interface';
import { RedisCacheService } from '../services/redis-cache.service';

export interface CacheableDecoratorOptions extends CacheSetOptions {
  keyGenerator?: (...args: any[]) => string;
}

/**
 * Decorator tự động cache kết quả trả về của hàm bất đồng bộ
 * @example
 * @Cacheable('rooms:vacancies:summary', { ttlSeconds: 300, tags: ['rooms'] })
 * async search(origin: string, destination: string) { ... }
 */
export function Cacheable(cachePrefix: string, options: CacheableDecoratorOptions = {}) {
  return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cacheService: RedisCacheService | undefined =
        (this as any).cacheService ?? RedisCacheService.getInstance();
      if (!cacheService) {
        // Ngoài Nest DI (unit test thuần): chạy trực tiếp
        return originalMethod.apply(this, args);
      }

      const generatedKey = options.keyGenerator
        ? `${cachePrefix}:${options.keyGenerator(...args)}`
        : `${cachePrefix}:${propertyKey}:${JSON.stringify(args)}`;

      return cacheService.getOrSet(generatedKey, () => originalMethod.apply(this, args), options);
    };

    return descriptor;
  };
}
