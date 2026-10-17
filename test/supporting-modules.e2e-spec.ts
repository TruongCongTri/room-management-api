/**
 * Kiểm thử tích hợp các supporting module trên hạ tầng THẬT (PostgreSQL + Redis của docker compose).
 * Mỗi test khẳng định một tính chất mà mock không chứng minh được: RLS thật sự cô lập tòa nhà với role
 * KHÔNG phải superuser, khóa phân tán thật sự loại trừ lẫn nhau, FOR UPDATE SKIP LOCKED không relay trùng
 * giữa nhiều Pod, idempotency chịu được request đồng thời, ma trận quyền mặc định được áp qua HTTP...
 *
 *   docker compose --profile postgres up -d
 *   npm run test:e2e
 */
// Phải đứng đầu: tắt poller nền của app trước khi AppModule xác thực cấu hình
import './disable-outbox-poller';
import {
  Body,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  InternalServerErrorException,
  Param,
  Post,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { Column, DataSource, Entity } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/core/config/app-config.service';
import { JwtTokenService } from '../src/core/security/jwt/jwt-token.service';
import { RequestContextService } from '../src/core/context/request-context.service';
import { RequestContextData, RequestUserContext } from '../src/core/context/request-context.model';
import { REDIS_CLIENT } from '../src/core/redis/redis.constants';
import { BuildingScopedEntity } from '../src/core/multitenancy/tenant-base.entity';
import { TenancySubscriber } from '../src/core/multitenancy/tenancy.subscriber';
import { RlsService } from '../src/core/multitenancy/rls.service';
import { SnakeNamingStrategy } from '../src/core/database/snake-naming.strategy';
import { Action, Scope } from '../src/core/access-control/access-control.types';
import { RequirePermissions } from '../src/core/access-control/permission.decorator';
import { DEFAULT_ROLE_PERMISSIONS, RentalRole } from '../src/core/access-control/rental-permissions';
import { Idempotent } from '../src/core/security/idempotency/idempotency.decorator';
import { SkipAllThrottles, ThrottleSensitive } from '../src/core/security/throttler/throttler.decorators';
import { EncryptionService } from '../src/core/security/encryption/encryption.service';
import { FeatureFlagService } from '../src/core/feature-flag/feature-flag.service';
import { FEATURE_FLAGS } from '../src/core/feature-flag/feature-flags.constant';
import { DistributedLockService } from '../src/infrastructure/lock/services/distributed-lock.service';
import { LOCK_KEYS } from '../src/infrastructure/lock/constants/lock-keys.constant';
import { RedisCacheService } from '../src/infrastructure/cache/services/redis-cache.service';
import { OutboxService } from '../src/infrastructure/outbox/services/outbox.service';
import { OutboxPollerService } from '../src/infrastructure/outbox/services/outbox-poller.service';
import { OutboxRelayEvent, OutboxRelayHandler } from '../src/infrastructure/outbox/interfaces/outbox.interface';
import { DOMAIN_EVENTS } from '../src/infrastructure/events/constants/event.constants';
import { runSeeds } from '../src/core/database/seed-runner';
import { MetricsService } from '../src/infrastructure/metrics/services/metrics.service';

const BUILDING_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUILDING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Bảng nghiệp vụ tạm thời mô phỏng `rooms` (BuildingScopedEntity + RLS theo building_id) */
@Entity('it_rooms')
class ItRoom extends BuildingScopedEntity {
  @Column({ type: 'varchar', length: 20 })
  roomNumber: string;
}

let slowExecutions = 0;
const flakyAttempts = new Map<string, number>();

@SkipAllThrottles()
@Controller('it')
class SupportingModulesProbeController {
  constructor(private readonly dataSource: DataSource) {}

  @Post('idempotent/slow')
  @Idempotent()
  async slow(@Body() body: { amount: number }) {
    slowExecutions++;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { executionId: randomUUID(), amount: body.amount };
  }

  /** Lần đầu với mỗi ref lỗi 500 (vd: deadlock), lần sau thành công */
  @Post('idempotent/flaky')
  @Idempotent()
  flaky(@Body() body: { ref: string }) {
    const attempt = (flakyAttempts.get(body.ref) ?? 0) + 1;
    flakyAttempts.set(body.ref, attempt);
    if (attempt === 1) throw new InternalServerErrorException('transient failure');
    return { attempt };
  }

  @Get('meters/approve')
  @RequirePermissions({ resource: 'meters', action: Action.APPROVE, scope: Scope.DEPARTMENT })
  approveMeterReset() {
    return { approved: true };
  }

  @Get('invoices/:ownerId')
  @RequirePermissions({
    resource: 'invoices',
    action: Action.READ,
    scope: Scope.OWN,
    // Mô phỏng tải hóa đơn từ DB: chủ sở hữu thật lấy từ bản ghi, không từ client
    subjectResolver: (ctx: ExecutionContext) => ({ userId: ctx.switchToHttp().getRequest().params.ownerId }),
  })
  readInvoice(@Param('ownerId') ownerId: string) {
    return { ownerId };
  }

  @Post('duplicate-form')
  async duplicateForm() {
    await this.dataSource.query(
      `INSERT INTO statutory_forms (code, name, kind, legal_basis) VALUES ('CT01', 'dup', 'RESIDENCE', 'x')`,
    );
    return { inserted: true };
  }
}

@Controller('it-throttle')
class ThrottleProbeController {
  @Post('sensitive')
  @ThrottleSensitive()
  checkout() {
    return { ok: true };
  }
}

const userContext = (user: RequestUserContext): RequestContextData => ({
  traceId: `IT-${randomUUID()}`,
  clientIp: '127.0.0.1',
  startTime: Date.now(),
  isBackgroundJob: false,
  user,
  metadata: new Map(),
});

const managerOf = (buildingId: string): RequestUserContext => ({
  id: `usr_pm_${buildingId.slice(0, 4)}`,
  email: 'pm@rental.test',
  tenantId: buildingId,
  roles: [RentalRole.PROPERTY_MANAGER],
  rules: [],
});

describe('Supporting modules (integration, real PostgreSQL + Redis)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let dataSource: DataSource;
  let redis: Redis;
  let tokens: JwtTokenService;
  let context: RequestContextService;

  const tokenFor = (userId: string, roles: string[], extra: Record<string, unknown> = {}) =>
    // Không truyền `rules`: quyền được phân giải từ role (UserPermissionResolver → DEFAULT_ROLE_PERMISSIONS)
    tokens.signAccessToken({ sub: userId, email: `${userId}@rental.test`, tenantId: BUILDING_A, roles, ...extra });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [SupportingModulesProbeController, ThrottleProbeController],
    }).compile();

    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false });
    await configureApp(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();

    app = nestApp as unknown as INestApplication<App>;
    http = request(app.getHttpServer());
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    tokens = app.get(JwtTokenService);
    context = app.get(RequestContextService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ===========================================================================
  // MultiTenancyModule: PostgreSQL RLS + TenancySubscriber với role tối thiểu quyền
  // ===========================================================================
  describe('MultiTenancy (PostgreSQL RLS as least-privilege app_user)', () => {
    let appUserDs: DataSource;
    let rls: RlsService;

    beforeAll(async () => {
      // DDL bằng owner (postgres); policy dựng bằng chính hàm setup_building_rls của migration
      await dataSource.query(`DROP TABLE IF EXISTS it_rooms`);
      await dataSource.query(`
        CREATE TABLE it_rooms (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          building_id uuid NOT NULL,
          room_number varchar(20) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz,
          version integer NOT NULL DEFAULT 1
        )`);
      await dataSource.query(`SELECT setup_building_rls('it_rooms')`);
      await dataSource.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON it_rooms TO app_user`);
      await dataSource.query(
        `INSERT INTO it_rooms (building_id, room_number) VALUES ($1, 'A-101'), ($1, 'A-102'), ($2, 'B-201')`,
        [BUILDING_A, BUILDING_B],
      );

      const db = app.get(AppConfigService).database.master;
      appUserDs = new DataSource({
        type: 'postgres',
        host: db.host,
        port: db.port,
        database: db.database,
        username: 'app_user',
        password: 'app_user',
        entities: [ItRoom],
        namingStrategy: new SnakeNamingStrategy(),
        // MỘT kết nối duy nhất: chứng minh SET LOCAL không rò rỉ sang lần dùng tiếp theo của connection pool
        extra: { max: 1 },
      });
      await appUserDs.initialize();
      new TenancySubscriber(context, appUserDs);
      rls = new RlsService(appUserDs, context);
    });

    afterAll(async () => {
      await appUserDs?.destroy();
      await dataSource.query(`DROP TABLE IF EXISTS it_rooms`);
    });

    const roomsVisibleTo = (buildingId: string) =>
      context.run(userContext(managerOf(buildingId)), () =>
        rls.runInTenantContext((manager) => manager.getRepository(ItRoom).find({ order: { roomNumber: 'ASC' } })),
      );

    it('should only return rows of the active building', async () => {
      expect((await roomsVisibleTo(BUILDING_A)).map((r) => r.roomNumber)).toEqual(['A-101', 'A-102']);
      expect((await roomsVisibleTo(BUILDING_B)).map((r) => r.roomNumber)).toEqual(['B-201']);
    });

    it('should fail closed: no building context means no rows, even right after a scoped transaction on the same connection', async () => {
      await roomsVisibleTo(BUILDING_A);
      const [{ count }] = await appUserDs.query(`SELECT count(*)::int AS count FROM it_rooms`);
      expect(count).toBe(0);
    });

    it('should block raw SQL that writes into another building (RLS WITH CHECK, bypassing the ORM)', async () => {
      await expect(
        context.run(userContext(managerOf(BUILDING_A)), () =>
          rls.runInTenantContext((manager) =>
            manager.query(`INSERT INTO it_rooms (building_id, room_number) VALUES ($1, 'FORGED')`, [BUILDING_B]),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('should block raw SQL UPDATE of another building’s rows (they are invisible, so nothing changes)', async () => {
      await context.run(userContext(managerOf(BUILDING_A)), () =>
        rls.runInTenantContext((manager) => manager.query(`UPDATE it_rooms SET room_number = 'HACKED'`)),
      );
      const rows = await dataSource.query(`SELECT room_number FROM it_rooms WHERE building_id = $1`, [BUILDING_B]);
      expect(rows).toEqual([{ room_number: 'B-201' }]);
    });

    it('should auto-inject building_id through TenancySubscriber when saving an entity', async () => {
      const saved = await context.run(userContext(managerOf(BUILDING_A)), () =>
        rls.runInTenantContext((manager) => manager.getRepository(ItRoom).save(manager.create(ItRoom, { roomNumber: 'A-103' }))),
      );
      const [row] = await dataSource.query(`SELECT building_id FROM it_rooms WHERE id = $1`, [saved.id]);
      expect(row.building_id).toBe(BUILDING_A);
    });

    it('should let a system job read across buildings only via the explicit bypass', async () => {
      const all = await context.runAsSystem('IT_REPORT', () =>
        rls.runWithBypass((manager) => manager.getRepository(ItRoom).count()),
      );
      expect(all).toBe(4);
    });
  });

  // ===========================================================================
  // DistributedLockModule
  // ===========================================================================
  describe('DistributedLock (Redis SET NX PX + Lua fencing)', () => {
    let locks: DistributedLockService;
    beforeAll(() => {
      locks = app.get(DistributedLockService);
    });
    const inBuilding = <T>(buildingId: string, fn: () => Promise<T>) => context.run(userContext(managerOf(buildingId)), fn);

    it('should grant a contended lock to exactly one of many concurrent callers', async () => {
      const key = LOCK_KEYS.roomContract(randomUUID());
      const attempts = await inBuilding(BUILDING_A, () =>
        Promise.allSettled(Array.from({ length: 10 }, () => locks.acquire(key, { retryCount: 0, ttlMs: 5000 }))),
      );
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    });

    it('should never let a stale token release a lock now owned by someone else', async () => {
      const key = LOCK_KEYS.checkoutContract(randomUUID());
      await inBuilding(BUILDING_A, async () => {
        const handle = await locks.acquire(key, { retryCount: 0, ttlMs: 5000 });
        expect(await locks.release({ ...handle, token: 'stale-token' })).toBe(false);
        await expect(locks.acquire(key, { retryCount: 0 })).rejects.toThrow(/Failed to acquire/);
        expect(await locks.release(handle)).toBe(true);
        await expect(locks.acquire(key, { retryCount: 0 })).resolves.toBeDefined();
      });
    });

    it('should expire abandoned locks after their TTL (crashed pod)', async () => {
      const key = `it:ttl:${randomUUID()}`;
      await inBuilding(BUILDING_A, async () => {
        await locks.acquire(key, { retryCount: 0, ttlMs: 300 });
        await new Promise((resolve) => setTimeout(resolve, 450));
        await expect(locks.acquire(key, { retryCount: 0 })).resolves.toBeDefined();
      });
    });

    it('should keep a long-running lock alive with the watchdog beyond its initial TTL', async () => {
      const key = `it:watchdog:${randomUUID()}`;
      await inBuilding(BUILDING_A, async () => {
        const handle = await locks.acquire(key, { retryCount: 0, ttlMs: 400, autoRenew: true });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(locks.acquire(key, { retryCount: 0 })).rejects.toThrow(/Failed to acquire/);
        expect(handle.lost).toBe(false);
        await locks.release(handle);
      });
    });

    it('should namespace locks per building', async () => {
      const key = 'meter:shared-room-number:202610';
      const a = await inBuilding(BUILDING_A, () => locks.acquire(key, { retryCount: 0 }));
      const b = await inBuilding(BUILDING_B, () => locks.acquire(key, { retryCount: 0 }));
      expect(a.key).not.toBe(b.key);
      await locks.release(a);
      await locks.release(b);
    });
  });

  // ===========================================================================
  // CacheModule
  // ===========================================================================
  describe('Cache (Redis, single-flight, tag invalidation, building isolation)', () => {
    let cache: RedisCacheService;
    beforeAll(() => {
      cache = app.get(RedisCacheService);
    });
    const inBuilding = <T>(buildingId: string, fn: () => Promise<T>) => context.run(userContext(managerOf(buildingId)), fn);

    it('should compute a cold key once for many concurrent readers (no stampede)', async () => {
      let computations = 0;
      const key = `rooms:vacancies:summary:${randomUUID()}`;
      const factory = async () => {
        computations++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { available: 12 };
      };
      const results = await inBuilding(BUILDING_A, () =>
        Promise.all(Array.from({ length: 20 }, () => cache.getOrSet(key, factory, { ttlSeconds: 60 }))),
      );
      expect(computations).toBe(1);
      expect(new Set(results.map((r) => JSON.stringify(r)))).toEqual(new Set(['{"available":12}']));
    });

    it('should physically remove tagged keys from Redis on invalidation (cache:{buildingId}:… / tag:{buildingId}:…)', async () => {
      const key = `rooms:list:${randomUUID()}`;
      await inBuilding(BUILDING_A, () => cache.set(key, [1, 2, 3], { ttlSeconds: 60, tags: ['rooms'] }));
      expect(await redis.exists(`cache:${BUILDING_A}:${key}`)).toBe(1);
      expect(await redis.sismember(`tag:${BUILDING_A}:rooms`, `cache:${BUILDING_A}:${key}`)).toBe(1);

      const removed = await inBuilding(BUILDING_A, () => cache.invalidateTag('rooms'));
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await redis.exists(`cache:${BUILDING_A}:${key}`)).toBe(0);
      expect(await inBuilding(BUILDING_A, () => cache.get(key))).toBeNull();
    });

    it('should never serve one building’s cached data to another building', async () => {
      const key = `rooms:vacancies:${randomUUID()}`;
      await inBuilding(BUILDING_A, () => cache.set(key, { available: 5 }, { ttlSeconds: 60 }));
      expect(await inBuilding(BUILDING_B, () => cache.get(key))).toBeNull();
      expect(await inBuilding(BUILDING_A, () => cache.get(key))).toEqual({ available: 5 });
    });
  });

  // ===========================================================================
  // OutboxModule: FOR UPDATE SKIP LOCKED giữa nhiều Pod, retry/backoff, DLQ, thu hồi lease
  // ===========================================================================
  describe('Outbox (multi-pod relay)', () => {
    let outbox: OutboxService;
    let config: AppConfigService;

    it('should run with the application poller disabled, so only the simulated pods relay', () => {
      expect(app.get(AppConfigService).outbox.enabled).toBe(false);
    });

    beforeAll(async () => {
      outbox = app.get(OutboxService);
      config = app.get(AppConfigService);
      await dataSource.query(`DELETE FROM outbox_events`);
    });

    const createEvents = (count: number, options: { maxRetries?: number; eventType?: string } = {}) =>
      context.run(userContext(managerOf(BUILDING_A)), () =>
        dataSource.transaction(async (manager) => {
          const ids: string[] = [];
          for (let i = 0; i < count; i++) {
            const event = await outbox.createEventInTransaction(manager, {
              aggregateType: 'METER_READING',
              aggregateId: randomUUID(),
              eventType: options.eventType ?? DOMAIN_EVENTS.METER_READING.RECORDED,
              payload: { index: i },
              maxRetries: options.maxRetries,
            });
            ids.push(event.id);
          }
          return ids;
        }),
      );

    it('should relay every event exactly once when three pods poll concurrently', async () => {
      const ids = await createEvents(60);
      const relayed: string[] = [];
      const handler: OutboxRelayHandler = {
        relay: async (event: OutboxRelayEvent) => {
          relayed.push(event.id);
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      };
      const pods = Array.from({ length: 3 }, () => new OutboxPollerService(dataSource, handler, config));

      for (let round = 0; round < 10 && relayed.length < ids.length; round++) {
        await Promise.all(pods.map((pod) => pod.pollAndRelayEvents()));
      }

      expect(relayed.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
      expect(new Set(relayed).size).toBe(relayed.length);
      const [{ pending }] = await dataSource.query(
        `SELECT count(*)::int AS pending FROM outbox_events WHERE id = ANY($1::uuid[]) AND status <> 'PUBLISHED'`,
        [ids],
      );
      expect(pending).toBe(0);
    });

    it('should carry building, trace and actor of the originating request into the relayed event', async () => {
      const [id] = await createEvents(1);
      let captured: OutboxRelayEvent | undefined;
      const poller = new OutboxPollerService(dataSource, { relay: async (e) => void (captured = e) }, config);
      await poller.pollAndRelayEvents();
      expect(captured).toEqual(expect.objectContaining({ id, buildingId: BUILDING_A, actorId: managerOf(BUILDING_A).id }));
      expect(captured?.traceId).toMatch(/^IT-/);
    });

    it('should back off failed relays and dead-letter them after max retries', async () => {
      const [id] = await createEvents(1, { maxRetries: 2 });
      const failing = new OutboxPollerService(dataSource, { relay: async () => Promise.reject(new Error('broker down')) }, config);

      await failing.pollAndRelayEvents();
      let [row] = await dataSource.query(`SELECT status, retry_count, next_retry_at > now() AS delayed, last_error FROM outbox_events WHERE id = $1`, [id]);
      expect(row).toEqual({ status: 'FAILED', retry_count: 1, delayed: true, last_error: 'broker down' });

      // Chưa tới hạn retry → poll lần nữa KHÔNG được nhận lại
      await failing.pollAndRelayEvents();
      [row] = await dataSource.query(`SELECT retry_count FROM outbox_events WHERE id = $1`, [id]);
      expect(row.retry_count).toBe(1);

      await dataSource.query(`UPDATE outbox_events SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [id]);
      await failing.pollAndRelayEvents();
      [row] = await dataSource.query(`SELECT status, retry_count FROM outbox_events WHERE id = $1`, [id]);
      expect(row).toEqual({ status: 'DEAD_LETTER', retry_count: 2 });
    });

    it('should reclaim events whose lease expired (pod crashed mid-relay)', async () => {
      const [id] = await createEvents(1);
      await dataSource.query(
        `UPDATE outbox_events SET status = 'PROCESSING', next_retry_at = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      const relayed: string[] = [];
      await new OutboxPollerService(dataSource, { relay: async (e) => void relayed.push(e.id) }, config).pollAndRelayEvents();
      expect(relayed).toContain(id);
    });
  });

  // ===========================================================================
  // IdempotencyModule qua HTTP
  // ===========================================================================
  describe('Idempotency (HTTP, Redis two-phase lock)', () => {
    it('should execute concurrent duplicates once: one 201, the rest 409 while IN_PROGRESS, then replay', async () => {
      const auth = `Bearer ${await tokenFor('usr_idem_concurrent', [RentalRole.ACCOUNTANT])}`;
      const key = `checkout-${randomUUID()}`;
      const before = slowExecutions;

      const send = () =>
        http.post('/api/v1/it/idempotent/slow').set('Authorization', auth).set('Idempotency-Key', key).send({ amount: 6500000 });
      const responses = await Promise.all(Array.from({ length: 5 }, send));

      expect(slowExecutions - before).toBe(1);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);

      const replay = await send().expect(201);
      expect(replay.body.data).toEqual(responses.find((r) => r.status === 201)!.body.data);
      expect(slowExecutions - before).toBe(1);
    });

    it('should release the key after a 5xx so the client can safely retry', async () => {
      const auth = `Bearer ${await tokenFor('usr_idem_flaky', [RentalRole.ACCOUNTANT])}`;
      const key = `meter-${randomUUID()}`;
      const ref = randomUUID();
      const send = () =>
        http.post('/api/v1/it/idempotent/flaky').set('Authorization', auth).set('Idempotency-Key', key).send({ ref });

      await send().expect(500);
      const retry = await send().expect(201);
      expect(retry.body.data).toEqual({ attempt: 2 });
    });

    it('should isolate the same key between different users', async () => {
      const key = `shared-${randomUUID()}`;
      const before = slowExecutions;
      for (const user of ['usr_idem_a', 'usr_idem_b']) {
        await http
          .post('/api/v1/it/idempotent/slow')
          .set('Authorization', `Bearer ${await tokenFor(user, [RentalRole.ACCOUNTANT])}`)
          .set('Idempotency-Key', key)
          .send({ amount: 1 })
          .expect(201);
      }
      expect(slowExecutions - before).toBe(2);
    });

    it('should reject a reused key with a different payload (422) and a missing key (400)', async () => {
      const auth = `Bearer ${await tokenFor('usr_idem_mismatch', [RentalRole.ACCOUNTANT])}`;
      const key = `pay-${randomUUID()}`;
      await http.post('/api/v1/it/idempotent/slow').set('Authorization', auth).set('Idempotency-Key', key).send({ amount: 1 }).expect(201);
      const mismatch = await http
        .post('/api/v1/it/idempotent/slow')
        .set('Authorization', auth)
        .set('Idempotency-Key', key)
        .send({ amount: 2 })
        .expect(422);
      expect(mismatch.body.errorCode).toBe('REQ_IDEMPOTENCY_PAYLOAD_MISMATCH');

      const missing = await http.post('/api/v1/it/idempotent/slow').set('Authorization', auth).send({ amount: 1 }).expect(400);
      expect(missing.body.errorCode).toBe('REQ_MISSING_IDEMPOTENCY_KEY');
    });
  });

  // ===========================================================================
  // AccessControlModule: ma trận quyền mặc định qua HTTP (token không nhúng rules)
  // ===========================================================================
  describe('Access control (default role matrix over HTTP)', () => {
    it.each([
      [RentalRole.GUARD, 403],
      [RentalRole.TENANT, 403],
      // Tài liệu 05: duyệt reset đồng hồ (meters:approve:department) cấp cho quản lý tòa nhà và kế toán
      [RentalRole.PROPERTY_MANAGER, 200],
      [RentalRole.ACCOUNTANT, 200],
      [RentalRole.LANDLORD, 200],
    ])('meters:approve:department as %s → %i', async (role, status) => {
      await http
        .get('/api/v1/it/meters/approve')
        .set('Authorization', `Bearer ${await tokenFor(`usr_${role.toLowerCase()}`, [role])}`)
        .expect(status);
    });

    it('should let a tenant read only their own invoice (OWN scope on the loaded record)', async () => {
      const auth = `Bearer ${await tokenFor('usr_tenant_self', [RentalRole.TENANT])}`;
      await http.get('/api/v1/it/invoices/usr_tenant_self').set('Authorization', auth).expect(200);
      await http.get('/api/v1/it/invoices/usr_someone_else').set('Authorization', auth).expect(403);
    });

    it('should cache the resolved matrix under permissions:user:{id} only when written by identity (no silent cache)', async () => {
      // Không có PERMISSION_RULES_LOADER: quyền suy ra từ role mỗi request, không ghi cache ngầm
      await http
        .get('/api/v1/it/meters/approve')
        .set('Authorization', `Bearer ${await tokenFor('usr_cache_probe', [RentalRole.ACCOUNTANT])}`)
        .expect(200);
      expect(await redis.exists('permissions:user:usr_cache_probe')).toBe(0);
    });
  });

  // ===========================================================================
  // ThrottlerModule
  // ===========================================================================
  describe('Throttler (sensitive tier, per-user tracking)', () => {
    it('should allow 5 sensitive calls per user per window, then 429, without affecting other users behind the same IP', async () => {
      const alice = `Bearer ${await tokenFor('usr_throttle_alice', [RentalRole.ACCOUNTANT])}`;
      const bob = `Bearer ${await tokenFor('usr_throttle_bob', [RentalRole.ACCOUNTANT])}`;

      for (let i = 0; i < 5; i++) {
        await http.post('/api/v1/it-throttle/sensitive').set('Authorization', alice).expect(201);
      }
      const limited = await http.post('/api/v1/it-throttle/sensitive').set('Authorization', alice).expect(429);
      expect(limited.body.errorCode).toBe('SEC_RATE_LIMIT_EXCEEDED');

      await http.post('/api/v1/it-throttle/sensitive').set('Authorization', bob).expect(201);
    });
  });

  // ===========================================================================
  // Database seeding & PostgreSQL error translation
  // ===========================================================================
  describe('Reference data seeding', () => {
    it('should seed the role matrix idempotently and remove grants dropped from code', async () => {
      expect(await runSeeds()).toBe(0);
      await dataSource.query(
        `INSERT INTO role_permissions (role_code, resource, action, scope) VALUES ('GUARD', 'invoices', 'manage', 'global')`,
      );
      expect(await runSeeds()).toBe(0);

      const counts = await dataSource.query(
        `SELECT role_code, count(*)::int AS n FROM role_permissions GROUP BY role_code ORDER BY role_code`,
      );
      expect(Object.fromEntries(counts.map((c: any) => [c.role_code, c.n]))).toEqual(
        Object.fromEntries(Object.values(RentalRole).map((role) => [role, DEFAULT_ROLE_PERMISSIONS[role].length])),
      );
      const [tiers] = await dataSource.query(`SELECT count(*)::int AS n, max(tier) AS top FROM evn_tariff_tiers`);
      expect(tiers).toEqual({ n: 6, top: 6 });
      const rules = await dataSource.query(`SELECT code, exempt_threshold_vnd, pit_base FROM statutory_tax_rules ORDER BY code`);
      expect(rules).toEqual([
        { code: 'RENTAL_2026', exempt_threshold_vnd: '1000000000', pit_base: 'EXCESS_OVER_THRESHOLD' },
        { code: 'RENTAL_PRE_2026', exempt_threshold_vnd: '100000000', pit_base: 'TOTAL_REVENUE' },
      ]);
    });

    it('should translate a real PostgreSQL unique violation into 409 DB_UNIQUE_CONSTRAINT_VIOLATION without leaking SQL', async () => {
      const res = await http
        .post('/api/v1/it/duplicate-form')
        .set('Authorization', `Bearer ${await tokenFor('usr_dup', [RentalRole.LANDLORD])}`)
        .expect(409);
      expect(res.body.errorCode).toBe('DB_UNIQUE_CONSTRAINT_VIOLATION');
      expect(JSON.stringify(res.body)).not.toMatch(/statutory_forms|INSERT|duplicate key/i);
    });
  });

  // ===========================================================================
  // Audit WORM, Encryption, Feature flags
  // ===========================================================================
  describe('Audit log WORM guarantees', () => {
    it('should block TRUNCATE, and allow DELETE only inside an audit-tiering transaction', async () => {
      const [{ id }] = await dataSource.query(
        `INSERT INTO audit_logs (building_id, actor_id, action, resource, resource_id, trace_id, client_ip)
         VALUES ($1, 'it', 'CREATE', 'worm', 'r1', 'TRACE-IT-WORM', '127.0.0.1') RETURNING id`,
        [BUILDING_A],
      );
      await expect(dataSource.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
      await expect(dataSource.query('DELETE FROM audit_logs WHERE id = $1', [id])).rejects.toThrow(/append-only/);

      await dataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.audit_tiering', 'on', true)`);
        await manager.query('DELETE FROM audit_logs WHERE id = $1', [id]);
      });
      // Cờ chỉ sống trong transaction: ngay sau đó WORM có hiệu lực trở lại
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM audit_logs WHERE id = $1`, [id]);
      expect(count).toBe(0);
      await expect(dataSource.query(`UPDATE audit_logs SET resource = 'x' WHERE trace_id = 'TRACE-WORM-E2E'`)).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('Encryption (configured from the real environment)', () => {
    it('should round-trip CCCD with random IVs and compute a stable blind index for lookup', () => {
      const encryption = app.get(EncryptionService);
      const a = encryption.encrypt('079203001234');
      const b = encryption.encrypt('079203001234');
      expect(a).not.toBe(b);
      expect(a).not.toContain('079203001234');
      expect(encryption.decrypt(a)).toBe('079203001234');
      expect(encryption.computeBlindIndex('079 203 001 234')).toBe(encryption.computeBlindIndex('079203001234'));
    });
  });

  describe('Metrics (Prometheus scrape)', () => {
    it('should export business counters with labels and normalized HTTP routes', async () => {
      const metrics = app.get(MetricsService);
      metrics.meterReadingsRecorded.add(2, { building_id: BUILDING_A, source: 'guard_photo' });
      metrics.checkoutsSettled.add(1, { building_id: BUILDING_A });

      // Route có UUID phải được gom về một nhãn (chống bùng nổ cardinality)
      const auth = `Bearer ${await tokenFor('usr_metrics', [RentalRole.TENANT])}`;
      await http.get(`/api/v1/it/invoices/${randomUUID()}`).set('Authorization', auth);

      const { text } = await http.get('/metrics').expect(200);
      expect(text).toMatch(new RegExp(String.raw`rental_meter_readings_total\{[^}]*building_id="${BUILDING_A}"[^}]*\} 2`));
      expect(text).toMatch(/rental_checkouts_settled_total\{[^}]*\} 1/);
      expect(text).toContain('/api/v1/it/invoices/:ownerId');
      expect(text).not.toMatch(/\/api\/v1\/it\/invoices\/[0-9a-f]{8}-/);
    });
  });

  describe('Feature flags shared across pods via Redis', () => {
    it('should propagate a runtime override to another instance', async () => {
      const flags = app.get(FeatureFlagService);
      await flags.setFlag(FEATURE_FLAGS.EVN_TIERED_QUOTA, { enabled: true });

      const otherPod = new FeatureFlagService(context, app.get(AppConfigService), redis);
      await otherPod.onModuleInit();
      try {
        expect(otherPod.isEnabled(FEATURE_FLAGS.EVN_TIERED_QUOTA)).toBe(true);
        await flags.clearOverride(FEATURE_FLAGS.EVN_TIERED_QUOTA);
      } finally {
        otherPod.onModuleDestroy();
      }
    });
  });
});
