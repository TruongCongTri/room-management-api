import { ResilienceService } from './resilience.service';
import { ResiliencePolicyOptions } from './resilience.interface';

/**
 * Decorator bọc một phương thức bất đồng bộ qua Bulkhead, Retry & Circuit Breaker.
 * Class sử dụng phải inject `private readonly resilienceService: ResilienceService`.
 *
 * @param serviceName Tên đối tác (xem EXTERNAL_PARTNERS: 'e-invoice-gateway', 'zalo-zns')
 * @param options Cấu hình chính sách
 * @param fallbackMethodName Tên hàm fallback trong cùng class (nếu có)
 */
export function Resilient(
  serviceName: string,
  options?: ResiliencePolicyOptions,
  fallbackMethodName?: string,
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    const wrapped = async function (this: any, ...args: any[]) {
      const resilienceService: ResilienceService | undefined = this.resilienceService;
      if (!resilienceService) {
        throw new Error(
          `Class '${this.constructor.name}' must inject 'resilienceService: ResilienceService' to use @Resilient() on '${String(propertyKey)}'.`,
        );
      }

      const operation = () => originalMethod.apply(this, args);
      const fallback = fallbackMethodName
        ? () => this[fallbackMethodName].apply(this, args)
        : undefined;

      return resilienceService.execute(serviceName, operation, fallback, options);
    };

    // Giữ nguyên metadata của các decorator khác đã gắn lên method gốc
    for (const key of Reflect.getMetadataKeys(originalMethod)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, originalMethod), wrapped);
    }
    Object.defineProperty(wrapped, 'name', { value: originalMethod.name });

    descriptor.value = wrapped;
    return descriptor;
  };
}
