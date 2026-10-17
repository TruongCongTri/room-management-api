/**
 * Parameter decorator lấy trực tiếp header idempotency-key:   
 * 
 * */ 

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { SYSTEM_HEADERS } from '../constants/headers.constant';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const rawKey = request.headers[SYSTEM_HEADERS.IDEMPOTENCY_KEY];
    return Array.isArray(rawKey) ? rawKey[0] : rawKey;
  },
);