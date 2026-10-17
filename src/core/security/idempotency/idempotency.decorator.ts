/**
 * Decorator declarative gắn trực tiếp lên các route nhạy cảm (Tạo đơn hàng, Thanh toán, Xuất vé):
 * 
*/

import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { IDEMPOTENT_METADATA_KEY } from './idempotency.constants';
import { IdempotentOptions } from './idempotency.interface';

/**
 * Decorator kích hoạt cơ chế chống trùng lặp giao dịch (Idempotency)
 * @example
 * @Post('charge')
 * @Idempotent({ required: true, ttlSeconds: 86400 })
 * async processPayment(@Body() dto: PaymentDto) { ... }
 */
export const Idempotent = (options: IdempotentOptions = {}): CustomDecorator<string> => {
  const mergedOptions: IdempotentOptions = {
    required: true,
    ttlSeconds: 86400, // 24 giờ
    lockTimeoutSeconds: 60,
    ...options,
  };
  return SetMetadata(IDEMPOTENT_METADATA_KEY, mergedOptions);
};