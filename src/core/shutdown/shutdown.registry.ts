/**
 * Cung cấp cổng đăng ký hook linh hoạt cho toàn bộ các module trong hệ thống
 * (Open/Closed: module hạ tầng tự đăng ký, không sửa core shutdown).
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  ShutdownPhase,
  ShutdownHandlerFn,
  RegisteredShutdownHook,
} from './shutdown.interface';

@Injectable()
export class ShutdownRegistry {
  private readonly logger = new Logger(ShutdownRegistry.name);
  private readonly hooks = new Map<string, RegisteredShutdownHook>();

  /**
   * Đăng ký một hàm dọn dẹp tài nguyên vào pha tương ứng.
   * Tên hook là duy nhất: đăng ký lại cùng tên sẽ thay thế hook cũ (an toàn khi module khởi tạo lại).
   */
  register(
    name: string,
    phase: ShutdownPhase,
    handler: ShutdownHandlerFn,
    order = 10,
  ): void {
    if (this.hooks.has(name)) {
      this.logger.warn(`Shutdown hook '${name}' re-registered; replacing previous handler.`);
    }
    this.hooks.set(name, { name, phase, order, handler });
  }

  unregister(name: string): boolean {
    return this.hooks.delete(name);
  }

  /**
   * Lấy danh sách hook của một pha cụ thể (đã sắp xếp theo thứ tự ưu tiên)
   */
  getHooksForPhase(phase: ShutdownPhase): RegisteredShutdownHook[] {
    return [...this.hooks.values()]
      .filter((h) => h.phase === phase)
      .sort((a, b) => a.order - b.order);
  }
}
