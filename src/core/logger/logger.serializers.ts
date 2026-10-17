import { IncomingMessage, ServerResponse } from 'http';

type SerializableRequest = IncomingMessage & {
  id?: string | number;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  originalUrl?: string;
  ip?: string;
};

/** Chuẩn hóa Error (bóc tách cả response/validation message của NestJS HttpException và cause) */
export function serializeError(err: any): any {
  if (!err || typeof err !== 'object') return err;
  return {
    type: err.name || err.constructor?.name || 'Error',
    message: err.message,
    stack: err.stack,
    code: err.code ?? err.status,
    details: typeof err.getResponse === 'function' ? err.getResponse() : err.details,
    cause: err.cause ? serializeError(err.cause) : undefined,
  };
}

export const loggerSerializers = {
  // Chuẩn hóa thông tin Request (KHÔNG ghi body để tránh lộ PII)
  req: (req: SerializableRequest) => ({
    id: req.id,
    method: req.method,
    url: req.originalUrl || req.url,
    query: req.query,
    remoteAddress: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers?.['user-agent'],
  }),

  // Chuẩn hóa thông tin Response
  res: (res: ServerResponse) => ({
    statusCode: res.statusCode,
  }),

  err: serializeError,
};
