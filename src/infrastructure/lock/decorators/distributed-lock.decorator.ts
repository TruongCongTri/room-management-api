/**
 * Method decorator khai báo việc bọc khóa phân tán trực tiếp lên các hàm xử lý nhạy cảm
 * (kích hoạt hợp đồng, trả phòng giữa tháng, ghi chỉ số, chạy kỳ hóa đơn).
 *
 * Khóa động theo tham số bằng template chỉ số: {0} = tham số đầu tiên, {1.contractId} = thuộc tính của tham số thứ hai.
 */
import { LockOptions } from '../interfaces/lock.interface';
import { DistributedLockService } from '../services/distributed-lock.service';

export interface DistributedLockDecoratorOptions extends LockOptions {
  keyBuilder?: (...args: any[]) => string;
}

const PLACEHOLDER = /\{(\d+)((?:\.[A-Za-z0-9_$]+)*)\}/g;
const HAS_PLACEHOLDER = /\{\d+(?:\.[A-Za-z0-9_$]+)*\}/;

/** Thay {index.path} bằng giá trị tham số tương ứng */
export function resolveLockKeyTemplate(template: string, args: unknown[]): string {
  return template.replace(PLACEHOLDER, (_match, index: string, path: string) => {
    let value: any = args[Number(index)];
    for (const segment of path.split('.').filter(Boolean)) {
      value = value?.[segment];
    }
    if (value === undefined || value === null) {
      throw new Error(`Lock key template '${template}' could not resolve placeholder {${index}${path}}`);
    }
    return String(value);
  });
}

/**
 * Decorator tự động đồng bộ hóa việc thực thi hàm qua Redis Distributed Lock
 * @example
 * @DistributedLock('room:contract:{0}')
 * async activateContract(roomId: string, dto: ActivateContractDto) { ... }
 *
 * @DistributedLock('checkout:contract', { ttlMs: 10000, keyBuilder: (dto: CheckoutDto) => dto.contractId })
 * async executeCheckout(dto: CheckoutDto) { ... }
 */
export function DistributedLock(resourcePrefix: string, options: DistributedLockDecoratorOptions = {}) {
  return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const lockService: DistributedLockService | undefined =
        (this as any).lockService ?? DistributedLockService.getInstance();
      if (!lockService) {
        // Ngoài Nest DI (unit test thuần): chạy trực tiếp
        return originalMethod.apply(this, args);
      }

      let lockKey: string;
      if (options.keyBuilder) {
        lockKey = `${resourcePrefix}:${options.keyBuilder(...args)}`;
      } else if (HAS_PLACEHOLDER.test(resourcePrefix)) {
        lockKey = resolveLockKeyTemplate(resourcePrefix, args);
      } else {
        lockKey = `${resourcePrefix}:${propertyKey}:${JSON.stringify(args)}`;
      }

      return lockService.runWithLock(lockKey, () => originalMethod.apply(this, args), options);
    };

    return descriptor;
  };
}
