import pino from 'pino';
import { Writable } from 'stream';
import { REDACTION_CENSOR, SENSITIVE_REDACTION_PATHS } from './logger.constants';

describe('Logger redaction (PCI-DSS / GDPR)', () => {
  const capture = () => {
    const lines: any[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(chunk.toString()));
        cb();
      },
    });
    const logger = pino(
      { redact: { paths: SENSITIVE_REDACTION_PATHS, censor: REDACTION_CENSOR } },
      stream,
    );
    return { logger, lines };
  };

  it('should redact sensitive keys at root, depth 1 and depth 2', () => {
    const { logger, lines } = capture();
    logger.info({
      password: 'p0',
      dto: { cardNumber: '4111111111111111', cvv: '123' },
      contract: { tenant: { passportNumber: 'B1234567' } },
      req: { headers: { authorization: 'Bearer abc' }, query: { token: 'reset-token' } },
    });

    const line = lines[0];
    expect(line.password).toBe(REDACTION_CENSOR);
    expect(line.dto.cardNumber).toBe(REDACTION_CENSOR);
    expect(line.dto.cvv).toBe(REDACTION_CENSOR);
    expect(line.contract.tenant.passportNumber).toBe(REDACTION_CENSOR);
    expect(line.req.headers.authorization).toBe(REDACTION_CENSOR);
    expect(line.req.query.token).toBe(REDACTION_CENSOR);
  });
});
