/**
 * @fileoverview Decorator to set a request timeout for a specific route handler in a NestJS application.
 * This decorator allows you to specify a timeout duration in milliseconds for a route handler.
 * If the request takes longer than the specified timeout, it will be aborted, and an appropriate response will be sent to the client.
 * */ 

import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const REQUEST_TIMEOUT_KEY = 'security:request_timeout_ms';
export const SetRequestTimeout = (timeoutMs: number): CustomDecorator<string> =>
  SetMetadata(REQUEST_TIMEOUT_KEY, timeoutMs);