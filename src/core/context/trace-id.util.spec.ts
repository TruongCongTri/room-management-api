import { IncomingMessage, ServerResponse } from 'http';
import { resolveTraceId, CORRELATION_ID_HEADER } from './trace-id.util';

describe('resolveTraceId', () => {
  const makeReq = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
  const makeRes = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      res: {
        headersSent: false,
        setHeader: (k: string, v: string) => (headers[k] = v),
      } as unknown as ServerResponse,
    };
  };

  it('should reuse a well-formed incoming correlation id and echo it back', () => {
    const { res, headers } = makeRes();
    const id = resolveTraceId(makeReq({ 'x-request-id': 'abc-12345-xyz' }), res);
    expect(id).toBe('abc-12345-xyz');
    expect(headers[CORRELATION_ID_HEADER]).toBe('abc-12345-xyz');
  });

  it('should reject malicious ids (log/header injection) and generate a new UUID', () => {
    const id = resolveTraceId(makeReq({ 'x-correlation-id': 'evil\nInjected: header' }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should memoize per request so pino-http and RequestContext share the same id', () => {
    const req = makeReq({});
    expect(resolveTraceId(req)).toBe(resolveTraceId(req));
  });
});
