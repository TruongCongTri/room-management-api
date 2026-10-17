/**
 * Kiểm thử e2e trên hạ tầng THẬT (PostgreSQL + Redis của docker compose) với đúng pipeline production
 * (configureApp): DI graph đầy đủ, guard/interceptor/filter toàn cục, migration, Redis, BullMQ.
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e
 */
import { Body, Controller, Get, INestApplication, Post, Query } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { IsInt, IsString, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/core/config/app-config.service';
import { GracefulShutdownService } from '../src/core/shutdown/graceful-shutdown.service';
import { JwtTokenService } from '../src/core/security/jwt/jwt-token.service';
import { Public, CurrentUser, CurrentTenant, TraceId } from '../src/common/decorators';
import { SetRequestTimeout } from '../src/common/interceptors/timeout.decorator';
import { ParseDatePipe } from '../src/common/pipes/parse-date.pipe';
import { Idempotent } from '../src/core/security/idempotency/idempotency.decorator';
import { OutboxService } from '../src/infrastructure/outbox/services/outbox.service';
import { QUEUE_NAMES } from '../src/infrastructure/queue/constants/queue.constant';
import { DOMAIN_EVENTS } from '../src/infrastructure/events/constants/event.constants';
import { RequestUserContext } from '../src/core/context/request-context.model';

/** Tòa nhà (building_id) mặc định trong token của các user e2e */
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

class ChargeDto {
  @IsString()
  invoiceId: string;

  @IsInt()
  @Min(1)
  amount: number;
}

let chargeExecutions = 0;

/** Controller chỉ dùng cho e2e: kích hoạt các năng lực hạ tầng qua HTTP */
@Controller('e2e')
class E2eProbeController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  @Public()
  @Get('public')
  publicPing() {
    return { ok: true };
  }

  @Get('me')
  me(
    @CurrentUser() user: RequestUserContext,
    @CurrentTenant() tenantId: string,
    @TraceId() traceId: string,
  ) {
    return { userId: user.id, tenantId, traceId };
  }

  @Post('payments')
  @Idempotent()
  charge(@Body() dto: ChargeDto) {
    chargeExecutions++;
    return { chargeId: randomUUID(), amount: dto.amount };
  }

  @Post('contracts')
  async activateContract(@Body() body: { roomNumber: string }) {
    const contractId = randomUUID();
    const event = await this.dataSource.transaction((manager) =>
      this.outbox.createEventInTransaction(manager, {
        aggregateType: 'CONTRACT',
        aggregateId: contractId,
        eventType: DOMAIN_EVENTS.CONTRACT.ACTIVATED,
        payload: { roomNumber: body.roomNumber },
      }),
    );
    return { contractId, eventId: event.id };
  }

  @Get('slow')
  @SetRequestTimeout(100)
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { tooLate: true };
  }

  @Public()
  @Get('date')
  parseDate(@Query('d', new ParseDatePipe({ required: true })) date: Date) {
    return { iso: date.toISOString() };
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Room Management API (e2e, real PostgreSQL + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let dataSource: DataSource;
  let tokens: JwtTokenService;

  const tokenFor = (userId: string, extra: Partial<RequestUserContext> = {}) =>
    tokens.signAccessToken({ sub: userId, email: `${userId}@rental.test`, tenantId: TENANT_ID, rules: [], ...extra });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [E2eProbeController],
    }).compile();

    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();

    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
    dataSource = app.get(DataSource);
    tokens = app.get(JwtTokenService);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Observability & probes', () => {
    it('should generate and echo correlation ids', async () => {
      const generated = await http.get('/api/v1/e2e/public').expect(200);
      expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);

      const echoed = await http.get('/health/liveness').set('x-request-id', 'client-trace-12345').expect(200);
      expect(echoed.headers['x-correlation-id']).toBe('client-trace-12345');
    });

    it('should report database and redis as UP on the readiness probe (outside the API prefix)', async () => {
      const res = await http.get('/health/readiness').expect(200);
      expect(res.body.info.database.status).toBe('up');
      expect(res.body.info.redis.status).toBe('up');
      await http.get('/api/v1/health/readiness').expect(404);
    });

    it('should expose Prometheus metrics with second-based latency buckets', async () => {
      const res = await http.get('/metrics').expect(200);
      expect(res.text).toContain('http_request_duration_seconds_bucket');
      expect(res.text).toContain('le="0.005"');
      expect(res.text).toContain('nodejs_eventloop_lag_seconds');
    });
  });

  describe('Authentication & context', () => {
    it('should reject protected routes without a token using RFC 7807 problem details', async () => {
      const res = await http.get('/api/v1/e2e/me').expect(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toEqual(expect.objectContaining({ errorCode: 'AUTH_UNAUTHORIZED', status: 401 }));
    });

    it('should authenticate a signed token and expose user, verified tenant and trace id', async () => {
      const res = await http
        .get('/api/v1/e2e/me')
        .set('Authorization', `Bearer ${await tokenFor('usr_me')}`)
        .expect(200);

      expect(res.body.data).toEqual({
        userId: 'usr_me',
        tenantId: TENANT_ID,
        traceId: res.headers['x-correlation-id'],
      });
    });

    it('should refuse an X-Building-ID header that is not assigned to the token (building spoofing)', async () => {
      await http
        .get('/api/v1/e2e/me')
        .set('Authorization', `Bearer ${await tokenFor('usr_spoof')}`)
        .set('X-Building-ID', '22222222-2222-4222-8222-222222222222')
        .expect(403);
    });

    it('should let a landlord switch to another assigned building via X-Building-ID', async () => {
      const otherBuilding = '22222222-2222-4222-8222-222222222222';
      const res = await http
        .get('/api/v1/e2e/me')
        .set('Authorization', `Bearer ${await tokenFor('usr_landlord', { buildingIds: [TENANT_ID, otherBuilding] })}`)
        .set('X-Building-ID', otherBuilding)
        .expect(200);
      expect(res.body.data.tenantId).toBe(otherBuilding);
    });

    it('should localize error messages using Accept-Language', async () => {
      const res = await http.get('/api/v1/e2e/me').set('Accept-Language', 'ja-JP,ja;q=0.9').expect(401);
      expect(res.body.message).toBe('認証資格情報が無効か、有効期限が切れています。');
    });
  });

  describe('Traffic control (Redis-backed)', () => {
    it('should apply exactly THROTTLE_LIMIT requests per window, then 429 with Retry-After', async () => {
      for (let i = 0; i < 3; i++) {
        await http.get('/api/v1/e2e/date?d=2026-10-15').expect(200);
      }
      const limited = await http.get('/api/v1/e2e/date?d=2026-10-15').expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body.errorCode).toBe('SEC_RATE_LIMIT_EXCEEDED');
    });

    it('should replay idempotent responses and reject a reused key with a different payload', async () => {
      const auth = `Bearer ${await tokenFor('usr_payer')}`;
      const key = `pay-${randomUUID()}`;
      const before = chargeExecutions;

      const first = await http
        .post('/api/v1/e2e/payments')
        .set('Authorization', auth)
        .set('Idempotency-Key', key)
        .send({ invoiceId: 'INV-2026-10-P302', amount: 500000 })
        .expect(201);
      const replay = await http
        .post('/api/v1/e2e/payments')
        .set('Authorization', auth)
        .set('Idempotency-Key', key)
        .send({ invoiceId: 'INV-2026-10-P302', amount: 500000 })
        .expect(201);

      expect(replay.body.data).toEqual(first.body.data);
      expect(replay.headers['x-cache-lookup']).toBe('HIT-IDEMPOTENT');
      expect(chargeExecutions - before).toBe(1);

      await http
        .post('/api/v1/e2e/payments')
        .set('Authorization', auth)
        .set('Idempotency-Key', key)
        .send({ invoiceId: 'INV-2026-10-P302', amount: 5000000 })
        .expect(422);
    });
  });

  describe('Validation, timeouts & parsing', () => {
    it('should reject unknown fields (mass assignment) with flattened details', async () => {
      const res = await http
        .post('/api/v1/e2e/payments')
        .set('Authorization', `Bearer ${await tokenFor('usr_validation')}`)
        .set('Idempotency-Key', `val-${randomUUID()}`)
        .send({ invoiceId: 'INV-2026-10-P303', amount: 0, isAdmin: true })
        .expect(400);

      expect(res.body.errorCode).toBe('REQ_VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'amount' }),
          expect.objectContaining({ field: 'isAdmin' }),
        ]),
      );
    });

    it('should cut hanging requests with 408 REQ_TIMEOUT', async () => {
      const res = await http
        .get('/api/v1/e2e/slow')
        .set('Authorization', `Bearer ${await tokenFor('usr_slow')}`)
        .expect(408);
      expect(res.body.errorCode).toBe('REQ_TIMEOUT');
    });
  });

  describe('Transactional outbox & audit trail', () => {
    it('should relay outbox events to BullMQ exactly once (jobId = event id) and record an HTTP audit entry', async () => {
      const res = await http
        .post('/api/v1/e2e/contracts')
        .set('Authorization', `Bearer ${await tokenFor('usr_manager')}`)
        .send({ roomNumber: 'P.302' })
        .expect(201);
      const { eventId } = res.body.data;
      const traceId = res.headers['x-correlation-id'];

      const status = await waitFor(async () => {
        const [row] = await dataSource.query('SELECT status FROM outbox_events WHERE id = $1', [eventId]);
        return row?.status === 'PUBLISHED' ? row.status : undefined;
      });
      expect(status).toBe('PUBLISHED');

      const queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.DOMAIN_EVENTS));
      const job = await queue.getJob(eventId);
      expect(job?.data.payload).toEqual(expect.objectContaining({ eventId, eventType: DOMAIN_EVENTS.CONTRACT.ACTIVATED }));
      expect(job?.data.metadata).toEqual(expect.objectContaining({ traceId, tenantId: TENANT_ID }));

      const audit = await waitFor(async () => {
        const [row] = await dataSource.query('SELECT * FROM audit_logs WHERE trace_id = $1', [traceId]);
        return row;
      });
      expect(audit).toEqual(
        expect.objectContaining({ action: 'CREATE', actor_id: 'usr_manager', building_id: TENANT_ID }),
      );
      expect(audit.metadata).toEqual(expect.objectContaining({ method: 'POST', statusCode: 201, outcome: 'SUCCESS' }));
    });

    it('should block UPDATE / DELETE on audit_logs at the database level (WORM)', async () => {
      // Trigger cấp dòng chỉ chạy khi có dòng bị tác động → chèn một bản ghi trước
      await dataSource.query(
        `INSERT INTO audit_logs (building_id, actor_id, action, resource, resource_id, trace_id, client_ip)
         VALUES ($1, 'e2e', 'CREATE', 'worm-check', 'r1', 'TRACE-WORM-E2E', '127.0.0.1')`,
        [TENANT_ID],
      );
      await expect(dataSource.query(`UPDATE audit_logs SET resource = 'tampered'`)).rejects.toThrow(/append-only/);
      await expect(dataSource.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    });
  });

  describe('Graceful shutdown', () => {
    it('should flip readiness, run all phases and release the database pool', async () => {
      const shutdown = app.get(GracefulShutdownService);
      await app.close();

      expect(shutdown.isShuttingDown()).toBe(true);
      expect(dataSource.isInitialized).toBe(false);
      app = undefined as unknown as INestApplication<App>;
    });
  });
});
