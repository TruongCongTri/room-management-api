# Document 01: Supporting Modules Architecture (`01-Supporting-Modules.md`)

This document specifies the cross-cutting supporting modules (`src/core/`, `src/common/`, `src/infrastructure/`) of the 80-room flat rental management platform. Everything is built on **NestJS 12, TypeORM, PostgreSQL 17 and Redis 7**, and engineered for Vietnamese property, residency, taxation and personal-data regulations.

It describes the code **as implemented**. Every behaviour marked as a guarantee is covered by unit tests (`src/**/*.spec.ts`) and by integration tests against real PostgreSQL + Redis (`test/*.e2e-spec.ts`).

> **Terminology.** The data-isolation boundary is the **building** (`building_id`). In this domain *"tenant"* means a **renter** (khách thuê), never a SaaS tenant. For historical reasons the request-context API keeps the names `tenantId` / `getTenantId()`; they always hold the active **building** id (`getBuildingId()` is an alias).

> **Layering rule.** `core/` never imports from `infrastructure/`; domain modules (`src/modules/`) may use both. `I18nModule` and `FeatureFlagModule` live in `core/` because the global exception filters, `RequestContextMiddleware` and the global `FeatureFlagGuard` depend on them. `SwaggerModule` and `VersioningModule` have no core dependants and live in `infrastructure/`.

---

## 1. Directory Structure

```
src/
├── core/                                   # Global singletons, initialised first
│   ├── access-control/                     # CASL RBAC + ABAC
│   │   ├── access-control.types.ts         # Action, Scope (OWN | DEPARTMENT = building | GLOBAL), rule types
│   │   ├── rental-permissions.ts           # 5 roles + default <resource>:<action>:<scope> matrix
│   │   ├── casl-ability.factory.ts         # MongoAbility builder (GRANT then explicit DENY)
│   │   ├── access-control.service.ts       # can() / enforce() inside services
│   │   ├── permission.decorator.ts         # @RequirePermissions(), @CheckPolicies()
│   │   ├── permissions.guard.ts            # Static permission + scope + record-level ABAC
│   │   ├── permission-cache.service.ts     # permissions:user:{userId} (Redis, memory fallback)
│   │   ├── user-permission.resolver.ts     # Token rules → cache → loader → role defaults
│   │   └── access-control.module.ts
│   ├── config/                             # AppConfigModule (fail-fast zod validation)
│   │   ├── env.schema.ts                   # Merged schema, DATABASE_* aliases, DevOps error table
│   │   ├── schemas/                        # app, database, redis, security, observability, infrastructure, rental
│   │   ├── resolvers/                      # DATABASE_URL / REDIS_URL / PEM resolution
│   │   ├── app-config.service.ts           # Typed getters + getSanitizedConfig()
│   │   └── load-config.ts                  # Same validation for CLI tools (migrations, seeds)
│   ├── context/                            # RequestContextModule (native AsyncLocalStorage)
│   ├── database/                           # DatabaseModule + migrations + seeds
│   │   ├── base.entity.ts                  # EnterpriseBaseEntity (UUID, timestamps, soft delete, @VersionColumn)
│   │   ├── snake-naming.strategy.ts
│   │   ├── typeorm-logger.service.ts       # traceId-aware SQL logger, slow-query WARN
│   │   ├── data-source.ts                  # TypeORM CLI data source
│   │   ├── migration-runner.ts             # K8s Job / InitContainer entry point
│   │   ├── seed-runner.ts                  # Idempotent reference-data seeding
│   │   ├── migrations/                     # Versioned DDL (see 4.5)
│   │   └── seeds/                          # reference-data.seed.ts
│   ├── feature-flag/                       # FeatureFlagModule (Redis-backed runtime toggles)
│   ├── i18n/                               # I18nModule (vi / en / ja / ko dictionaries)
│   ├── logger/                             # LoggerModule (nestjs-pino, PII redaction)
│   ├── multitenancy/                       # Building isolation
│   │   ├── tenancy.constants.ts            # X-Building-ID, app.current_building_id, app.bypass_rls
│   │   ├── tenant-base.entity.ts           # BuildingScopedEntity (building_id, immutable)
│   │   ├── tenancy-context.interceptor.ts  # Validates X-Building-ID against the token (post-guard)
│   │   ├── tenancy.subscriber.ts           # Injects / guards building_id on write
│   │   └── rls.service.ts                  # SET LOCAL inside transactions, controlled bypass
│   ├── redis/                              # Shared ioredis connection factory
│   ├── resilience/                         # Circuit breaker, bulkhead, retry, @Resilient(), partner policies
│   ├── security/
│   │   ├── encryption/                     # AES-256-GCM FLE + HMAC blind index
│   │   ├── headers/                        # Helmet + CORS whitelist
│   │   ├── idempotency/                    # Two-phase Idempotency-Key
│   │   ├── jwt/                            # Access-token verification + claims schema
│   │   └── throttler/                      # 3-tier Redis rate limiting
│   └── shutdown/                           # 5-phase graceful shutdown
│
├── common/                                 # Cross-cutting utilities
│   ├── constants/                          # Error codes, headers, regex, 2026 VN tax & EVN constants
│   ├── decorators/                         # @CurrentUser, @CurrentTenant, @TraceId, @IdempotencyKey, @Roles, @Public, @SkipAudit
│   ├── filters/                            # AllExceptionsFilter, HttpExceptionFilter (RFC 7807)
│   ├── guards/                             # JwtAuthGuard, RolesGuard
│   ├── interceptors/                       # Transform, Timeout, Audit
│   └── pipes/                              # CustomValidationPipe, ParseDatePipe, ParseUUIDStrictPipe
│
├── infrastructure/                         # Technical drivers & external adapters
│   ├── audit/                              # WORM audit trail + scoped viewer + 90-day tiering
│   ├── cache/                              # Redis + in-memory LRU, XFetch, tag invalidation
│   ├── document/                           # Statutory PDFs (pdfkit) + streaming Excel (ExcelJS)
│   ├── events/                             # Domain events (BaseDomainEvent, AppEventPublisher)
│   ├── health/                             # Liveness / readiness (database, redis, object storage)
│   ├── http/                               # Outbound HTTP client (mTLS, trace propagation, retry)
│   ├── lock/                               # Distributed locks (SET NX PX + Lua fencing, watchdog)
│   ├── metrics/                            # OpenTelemetry → Prometheus /metrics
│   ├── notification/                       # Zalo ZNS, Email, SMS, Telegram
│   ├── outbox/                             # Transactional outbox, FOR UPDATE SKIP LOCKED
│   ├── queue/                              # BullMQ envelopes + DLQ
│   ├── schedule/                           # @DistributedCron + rental schedules
│   ├── storage/                            # S3 / MinIO presigned URLs, path sanitizer
│   ├── swagger/                            # Segmented OpenAPI portals
│   ├── tracing/                            # OpenTelemetry tracing, @TraceSpan
│   ├── versioning/                         # Deprecation / Sunset headers
│   ├── webhook/                            # HMAC webhooks (ingress guard + egress dispatcher)
│   └── websocket/                          # Socket.IO + Redis adapter
│
└── modules/                                # Business domains (document 02)
    └── contracts/domain/                   # Pure occupancy & holder-succession policy (see 3.7)
```

---

## 2. Detailed Specification by Taxonomy Group

### Group 1: Application Lifecycle & Runtime Context

#### 1.1 `AppConfigModule` (`src/core/config/`)

* **Stack:** `@nestjs/config`, `zod`.
* **Fail-fast validation.** Every variable is validated at bootstrap; the process refuses to start and prints a `VARIABLE | CURRENT VALUE | PROBLEM` table (secrets shown as `<redacted, N chars>`, connection strings with masked passwords). All problems are reported in one boot, including cross-field rules (e.g. `HTTP_HEADERS_TIMEOUT_MS > HTTP_KEEP_ALIVE_TIMEOUT_MS`, `DB_MIGRATIONS_RUN=false` in production).
* **Schema groups:** `app`, `database`, `redis`, `security`, `observability`, `infrastructure`, `rental`.
* **Load order** (first wins, real environment variables always win): `.env.<NODE_ENV>.local` → `.env.local` → `.env.<NODE_ENV>` → `.env`. CLI tools (TypeORM, migration runner, seed runner) use exactly the same loader and schema.
* **Database variables:** `DATABASE_URL` (highest priority) or `DB_MASTER_*`. The common aliases `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME` / `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` and `DATABASE_SSL=true|false` are mapped onto the canonical names when those are unset. `DATABASE_TYPE` other than `postgres` is rejected (RLS and WORM triggers are PostgreSQL-only).
* **Required secrets:** `ENCRYPTION_KEY` (64 hex chars), `BLIND_INDEX_PEPPER` (≥ 32 chars, must differ from `ENCRYPTION_KEY`), `JWT_SECRET` (HS*, ≥ 32 chars) or `JWT_PUBLIC_KEY` (RS*/ES*), `JWT_REFRESH_SECRET` (≥ 32 chars, must differ from `JWT_SECRET` in production).
* **Rental & compliance variables** (`schemas/rental.schema.ts`, defaults from `common/constants/vn-rental.constant.ts`):

  | Variable | Default | Meaning |
  | :-- | :-- | :-- |
  | `TAX_EXEMPT_THRESHOLD_VND` | `1000000000` | 2026 rental-tax exemption threshold (Law 109/2025/QH15, Decree 141/2026/NĐ-CP); `100000000` only for pre-2026 re-runs |
  | `TAX_VAT_RATE_PERCENT` / `TAX_PIT_RATE_PERCENT` | `5` / `5` | VAT on taxable revenue; PIT on the part above the threshold |
  | `EVN_TIER_PRICES_VND` | `1984,2050,2380,2998,3350,3460` | 6 residential tiers, VND/kWh before VAT (Decision 1279/QĐ-BCT); must be non-decreasing |
  | `EVN_VAT_RATE_PERCENT` | `8` | VAT on electricity |
  | `EVN_HOUSEHOLD_QUOTA_HEADCOUNT` | `4` | Registered residents per full household quota |
  | `BILLING_CYCLE_DAY` / `BILLING_PAYMENT_DUE_DAYS` / `DEPOSIT_MONTHS` | `28` / `5` / `1` | Billing cycle conventions |

* **`AppConfigService`** exposes typed groups (`database`, `redis`, `security`, `tax`, `evn`, `billing`, `storage`, `outbox`, …). `getSanitizedConfig()` returns a log-safe snapshot (booleans such as `encryptionKeyConfigured` instead of secret values), printed once at startup.

#### 1.2 `RequestContextModule` (`src/core/context/`)

* **Stack:** native `AsyncLocalStorage` (no `nestjs-cls`).
* **Two-stage initialisation:**
  1. `RequestContextMiddleware` (ingress): resolves/creates the trace id (`X-Request-ID` / `X-Correlation-ID`, echoed on the response), client IP from `req.ip` (honours `TRUST_PROXY`; raw `X-Forwarded-For` is never trusted), locale from `Accept-Language` / `?lang=`, start time.
  2. `RequestContextSyncInterceptor` + `TenancyContextInterceptor` (after `JwtAuthGuard`): copy `req.user` into the store and resolve the **verified** building (see 3.6).
* **Getters:** `getTraceId()`, `getUserId()`, `getTenantId()` / `getBuildingId()`, `getUserRoles()`, `getUserRules()`, `getClientIp()`, `getLocale()`, `getDurationMs()`, `isPrivileged()`, `isBackgroundJob()`. `RequestContextService.current()` gives static access for decorators and value transformers.
* **Background work:** `runWithContext(seed, fn)` restores trace / building / actor from job payloads; `runAsSystem(name, fn)` creates a `SYSTEM` actor with trace id `SYS-<NAME>-<uuid>` for crons, outbox pollers and seeds.

#### 1.3 `GracefulShutdownModule` (`src/core/shutdown/`)

* **5 phases** (`ShutdownPhase`), each with registered hooks run by priority and a per-hook timeout (`SHUTDOWN_HOOK_TIMEOUT_MS`):
  1. `DRAIN_TRAFFIC` — `/health/readiness` returns `503`; waits `SHUTDOWN_DRAIN_DELAY_MS` for the load balancer.
  2. `PAUSE_CONSUMERS` — BullMQ workers, outbox poller, WebSocket (`reconnect_please`).
  3. `DRAIN_HTTP` — waits for in-flight requests (counted by `InFlightRequestMiddleware`).
  4. `FLUSH_BUFFERS` — logs, spans, metrics.
  5. `RELEASE_POOLS` — PostgreSQL pools, Redis clients.
* A failing hook never blocks the next ones. A watchdog (`SHUTDOWN_TIMEOUT_MS`, keep below `terminationGracePeriodSeconds`) forces `process.exit(1)` if teardown hangs.

---

### Group 2: Observability & Reliability

#### 2.1 `HealthModule` (`src/infrastructure/health/`)

* `GET /health/liveness` (public, outside `/api`): heap limit only — never touches external dependencies (no restart storms during a database hiccup).
* `GET /health/readiness` (public): returns `503` immediately while shutting down; otherwise checks **database** (`SELECT 1` on master and replica, with `latencyMs`), **redis** (`PING`), **object_storage** (`HeadBucket`, reports `mode: disabled` when `STORAGE_ENABLED=false`), disk usage and RSS.

#### 2.2 `LoggerModule` (`src/core/logger/`)

* **Stack:** `nestjs-pino`. Pretty output in development, single-line NDJSON elsewhere; `/health` and `/metrics` are not access-logged.
* **Ambient context:** every line carries `traceId`, `userId`, `tenantId` (building), `clientIp`, `isBackgroundJob`.
* **PII redaction** (Law 91/2025/QH15, Decree 13/2023/NĐ-CP, PCI-DSS) at root, depth 1 and depth 2: passwords, tokens, OTP, `authorization`, card data, `bankAccount`, `bankAccountNumber`, `refundBankAccount`, **`idCardNumber`, `idCardEncrypted`, `idCardHash`**, `citizenId`, `passportNumber`, `passportEncrypted`, `taxCode`, `dateOfBirth`, plus auth headers, cookies and token query parameters. The censor value is `[REDACTED]`.
* Exception serializers keep validation details and PostgreSQL error codes.

#### 2.3 `MetricsModule` (`src/infrastructure/metrics/`)

* **Stack:** OpenTelemetry Metrics SDK + Prometheus exporter, served at `GET /metrics` (optionally protected by `METRICS_BEARER_TOKEN`).
* **Runtime:** event-loop lag, heap / external / RSS memory, CPU, GC pause histogram, PostgreSQL pool connections, circuit-breaker state, bulkhead active/queued.
* **HTTP:** `http_request_duration_seconds` (buckets 5 ms → 10 s), `http_requests_total`, `http_active_requests`, recorded by `HttpMetricsMiddleware` with the **route pattern** as label (`/api/v1/properties/rooms/:id`; unmatched paths collapse to `UNMATCHED`).
* **Business counters** on `MetricsService`: `rental_contracts_activated_total`, `rental_meter_readings_total`, `rental_invoices_generated_total`, `rental_checkouts_settled_total`, `document_render_duration_seconds`. Recommended label: `building_id`.

#### 2.4 `TracingModule` (`src/infrastructure/tracing/`)

* **Stack:** `@opentelemetry/sdk-trace-node`, OTLP/HTTP exporter (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, ratio sampler), auto-instrumentation for HTTP, `pg` and `ioredis`. Bootstrapped in `instrumentation.ts` before NestJS loads.
* Server spans are renamed to the route template; spans carry `app.building_id` and the user id.
* `@TraceSpan('billing.checkout.settle')` wraps a method in a child span (records exceptions, always ends in `finally`).
* W3C `traceparent` propagates through outbound HTTP, outbox rows and BullMQ job envelopes.

#### 2.5 `AuditLogModule` (`src/infrastructure/audit/`)

* **`audit_logs`** (WORM): `building_id` (NULL for system events), `actor_id`, `actor_email`, `department_id`, `action` (`CREATE | UPDATE | DELETE | RESTORE | EXECUTE`), `resource`, `resource_id`, `diff_snapshot` (JSONB), `metadata`, `trace_id`, `client_ip`, `user_agent`, `created_at`. Indexes: `idx_audit_bld_created`, `idx_audit_bld_resource`, `idx_audit_actor_created_desc`, `idx_audit_department_created`, `idx_audit_created_tiering`.
* **Immutability:** triggers `trg_audit_logs_immutable` (row: UPDATE / DELETE) and `trg_audit_logs_immutable_truncate` raise `audit_logs is append-only (WORM)`. The only exception is `DELETE` inside a transaction that set `app.audit_tiering = 'on'` locally (used by tiering).
* **Writers:** `AuditInterceptor` records mutating HTTP calls (`POST/PUT/PATCH/DELETE`; opt out with `@SkipAudit()`); `AuditEntitySubscriber` records field-level diffs for `@Auditable()` entities **in the same transaction** as the change, masking encrypted columns.
* **Scoped retrieval (`AuditViewerService`):** `GLOBAL` → every building listed in the token (`buildingIds`), optionally narrowed by `buildingId`; `DEPARTMENT` → the active building; `OWN` → the caller's own actions in the active building.
* **Tiering (`AuditTieringService`):** rows older than `AUDIT_HOT_RETENTION_DAYS` (90) are exported as gzipped NDJSON to `STORAGE_COLD_BUCKET`, then purged in the same transaction. Never purges when storage is disabled.

---

### Group 3: Security, Traffic & Access Control

#### 3.1 `AccessControlModule` (`src/core/access-control/`)

* **Permission format:** `<resource>:<action>:<scope>`. Actions: `manage, create, read, update, delete, execute, upload, approve, settle, export`. Scopes rank `GLOBAL > DEPARTMENT > OWN`:
  * `GLOBAL` — every record the account can reach (still bounded by building isolation, 3.6).
  * `DEPARTMENT` — records of the **active building** (`record.buildingId === user's building`). A user without a building never gets department rights (fail closed).
  * `OWN` — records whose `userId` is the caller.
* **Default matrix** (`rental-permissions.ts`, seeded into `role_permissions`):

  | Role | Grants |
  | :-- | :-- |
  | `LANDLORD` | `*:*:global` |
  | `PROPERTY_MANAGER` | `rooms`, `assets`, `tenants`, `contracts`, `meters`, `compliance` → `manage:department`; `deposits`, `invoices`, `settlements` → `read:department`; `settlements:execute:department`; `audit:read:department` |
  | `ACCOUNTANT` | `invoices`, `payments` → `manage:department`; `meters:approve:department`; `deposits:settle:department`; `settlements:execute:department`; `tax:export:department`; read on rooms, assets, tenants, contracts, meters, deposits, settlements, compliance, audit |
  | `GUARD` | `rooms:read`, `meters:upload`, `meters:create`, `meters:read` (department); `audit:read:own` |
  | `TENANT` | `read:own` on tenants, assets (handed-over appliances), contracts, invoices, payments, meters, settlements, compliance, audit |

* **Resolution order** (`UserPermissionResolver`): rules embedded in the token → `permissions:user:{userId}` cache (Redis, memory fallback) → `PERMISSION_RULES_LOADER` provided by the identity module (result cached) → default matrix for the token's roles. Unknown roles grant nothing.
* **Enforcement:** `PermissionsGuard` checks (1) the action on the resource, (2) the minimum scope, (3) record-level ABAC on the subject returned by `subjectResolver` (loaded from the database). Ownership attributes from the request body are trusted only for `CREATE`. Explicit `DENY` always wins over `GRANT`.

#### 3.2 Security headers (`src/core/security/headers/`)

* Helmet with strict CSP, HSTS (1 year, subdomains), `X-Frame-Options: DENY`, `nosniff`; relaxed CSP only on Swagger paths.
* CORS whitelist from `ALLOWED_ORIGINS`: exact origins, `*.domain` (https subdomains) and `/regex/`. `*` is rejected in production.

#### 3.3 Encryption (`src/core/security/encryption/`)

* **Envelope:** `enc:<keyVersion>:<ivHex>:<authTagHex>:<cipherHex>` (AES-256-GCM, 96-bit IV, 128-bit tag). Old versions stay decryptable through `ENCRYPTION_LEGACY_KEYS` (`v1:<hex>,…`); `rotateKey()` loads a new key at runtime.
* **`FieldEncryptionTransformer`** (alias of `EncryptionTransformer`) on `@Column({ transformer })` encrypts on write, decrypts on read, never double-encrypts. Tampered ciphertext raises `500` without leaking details.
* **Blind index:** `computeBlindIndex(value)` = `HMAC-SHA256(normalize(value), BLIND_INDEX_PEPPER)` as 64 hex chars. Normalisation: NFKC, remove whitespace, dots and dashes, upper-case — so `"079 203 001 234"` and `"079203001234"` match. Used for `tenants.id_card_hash` (unique per building) to detect duplicates and look people up **without decrypting**. The pepper is not rotated like AES keys: changing it requires recomputing every `*_hash` column.

#### 3.4 Throttler (`src/core/security/throttler/`)

* Redis-backed counters in a shared window (`THROTTLE_TTL`). Tiers: `@ThrottlePublic()` (default, `THROTTLE_LIMIT` = 60), `@ThrottleSearch()` (100), `@ThrottleSensitive()` (5: login, OTP, checkout, deposit deduction, tax export), `@SkipAllThrottles()` (probes, Prometheus).
* `JwtAuthGuard` runs **before** the throttler, so authenticated callers are tracked as `user:{id}` (people sharing the building's NAT never block each other); anonymous callers as `ip:{clientIp}`. `429` responses carry `Retry-After` and `SEC_RATE_LIMIT_EXCEEDED`.

#### 3.5 Idempotency (`src/core/security/idempotency/`)

* `@Idempotent({ required = true, ttlSeconds = 86400, lockTimeoutSeconds = 60 })` on financial / meter mutations.
* **Redis key:** `idempotency:{buildingId}:{userId|ip}:{Idempotency-Key}` — the same key from two users never collides.
* **Two phases:** `SET … IN_PROGRESS NX EX lockTimeoutSeconds`; on success the status code and body are stored as `COMPLETED` for `ttlSeconds` and replayed with `X-Cache-Lookup: HIT-IDEMPOTENT`. Any error from the handler (including `5xx` / deadlocks) releases the lock so the client can retry.
* **Fingerprint:** SHA-256 of `method + path + canonicalJson(body)` (sorted keys).
* **Status map** (IETF `Idempotency-Key` draft): missing or malformed key → `400 REQ_MISSING_IDEMPOTENCY_KEY`; duplicate still in progress → `409`; same key with a different payload → `422 REQ_IDEMPOTENCY_PAYLOAD_MISMATCH`.

#### 3.6 Building isolation (`src/core/multitenancy/`)

* **Discriminator:** `BuildingScopedEntity.buildingId` → column `building_id` (indexed, not updatable).
* **Active building** = token `buildingId` (alias `tenantId`), or the `X-Building-ID` header when it is one of the token's `buildingIds` (landlords with several buildings) or the caller is `SUPER_ADMIN` / `SYSTEM`. Any other mismatch → `403`; malformed header → `400`. Anonymous requests: the header is stored as *requested* only and never used for writes.
* **Layer 1 — `TenancySubscriber`:** for entities extending `BuildingScopedEntity` (detected from TypeORM metadata, so plain-object `repository.insert()` is covered too) it injects `building_id` on insert and rejects cross-building insert / update / delete and any change of `building_id`. Infrastructure tables with a nullable `building_id` (`audit_logs`, `outbox_events`) are not policed.
* **Layer 2 — PostgreSQL RLS:** policy `tenant_isolation_policy` (`USING` + `WITH CHECK`) on `building_id = current_setting('app.current_building_id')`, or `app.bypass_rls = 'on'`. Installed per table with `SELECT setup_building_rls('<table>')`, with `FORCE ROW LEVEL SECURITY`.
* **`RlsService`:** `runInTenantContext()` (alias `runWithTenantTransaction()`) executes `set_config('app.current_building_id', $1, true)` (= `SET LOCAL`, parameterised) inside a transaction, so pooled connections are never poisoned; `runWithBypass()` (alias `runWithSystemBypass()`) is only allowed for background jobs and privileged users and is logged.
* **Verified with a least-privilege role** (`app_user`, `NOSUPERUSER NOBYPASSRLS`): each building sees only its rows; no context → zero rows, even on the connection that just served a scoped transaction; raw SQL cannot insert into or update another building. Superusers bypass RLS — the app logs a warning (`DB_RLS_ROLE_CHECK=warn|error`); production must use a dedicated role.

#### 3.7 Occupancy & contract-holder policy (`src/modules/contracts/domain/`)

A room can be shared by several people. **Every person** has an ID document (CCCD — or the 12-digit personal identification number for children — or a passport for foreigners) and must be declared for temporary residence, but each contract has **exactly one contract holder** (*người đứng tên*). The pure policy used by `ContractOccupancyService` (document 02, 5.4):

* `assertCanAddOccupant()` — ID document and PDPL consent required for everyone (`BIZ_OCCUPANT_ID_DOCUMENT_REQUIRED`, `BIZ_PDPL_CONSENT_REQUIRED`), no duplicate active occupant (`BIZ_OCCUPANT_ALREADY_ACTIVE`), capacity `room.maxOccupants` (`BIZ_OCCUPANT_LIMIT_EXCEEDED`).
* `selectNextPrimaryHolder()` — when the holder moves out: a designated successor must be eligible (`422 BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE` with reasons); otherwise the eligible occupant with the lowest agreed `successionOrder`, then the earliest `movedInAt`. Eligible = still living there, **18 or older on the effective date** (Civil Code 2015, Art. 20), ID document, PDPL consent. Last occupant → `409 BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT`; only minors left → `409 BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED`.
* `countEvnQuotaHeadcount()` — only active occupants whose temporary residence is `REGISTERED`.

---

### Group 4: Data Access, Persistence & Concurrency

#### 4.1 `DatabaseModule` (`src/core/database/`)

* **Stack:** PostgreSQL 17, TypeORM, `pg`. Optional read replica (`DATABASE_REPLICA_URL` / `DB_REPLICA_*`) with TypeORM replication; otherwise a single pool.
* **Pool & timeouts** (env, defaults): `DB_POOL_MAX=20`, `DB_POOL_MIN=2`, `DB_IDLE_TIMEOUT_MS=30000`, `DB_CONNECTION_TIMEOUT_MS=5000`, `DB_STATEMENT_TIMEOUT_MS=15000`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default 2× statement timeout), `keepAlive`. Supavisor / PgBouncer transaction pooling (port 6543) is detected and skips session startup parameters.
* **TLS / networking:** `DB_SSL_MODE` (`disable … verify-full`, CA via `DB_SSL_CA`), `DB_IP_FAMILY` (Supabase direct = IPv6, pooler = IPv4).
* **Conventions:** `SnakeNamingStrategy`; `synchronize: false` always; `EnterpriseBaseEntity` (UUID PK, `created_at`, `updated_at`, soft-delete `deleted_at`, `@VersionColumn() version` for optimistic locking) and `BuildingScopedEntity` (+ `building_id`).
* **`TypeOrmLoggerService`:** SQL logs with trace id; queries slower than `DB_SLOW_QUERY_MS` (500) logged as `WARN`.

#### 4.2 `CacheModule` (`src/infrastructure/cache/`)

* **Stack:** `ioredis` (L2) + in-process LRU (`CACHE_MEMORY_MAX_ENTRIES`; optional L1 near-cache `CACHE_L1_TTL_SECONDS`, otherwise used only when Redis is down → fail-open).
* **Keys:** `cache:{buildingId|global}:{key}`; tag sets `tag:{buildingId}:{tag}` (e.g. `tag:{buildingId}:rooms`). One building can never read another's entries.
* **`getOrSet()`:** single-flight on cold keys (concurrent readers share one computation) + **XFetch** probabilistic early recomputation in the background (`CACHE_XFETCH_BETA`).
* **`invalidateTag()`:** `SSCAN` in batches + `UNLINK` (never `KEYS *`), also clears local entries. `@Cacheable()` / `@HttpCache()` decorators available.

#### 4.3 `DistributedLockModule` (`src/infrastructure/lock/`)

* **Algorithm:** single-Redis `SET key token PX ttl NX` with a random UUID token; release and extend are atomic Lua scripts that only act when the token matches (fencing) — a delayed pod can never delete a lock now owned by another pod. (One Redis primary, not multi-master Redlock.)
* **Key:** `lock:{buildingId|global}:{businessKey}`, built from `LOCK_KEYS`:

  | Helper | Business key | Protects |
  | :-- | :-- | :-- |
  | `roomContract(roomId)` | `room:contract:{roomId}` | Two managers activating leases on one room |
  | `checkoutContract(contractId)` | `checkout:contract:{contractId}` | Checkout vs. meter updates |
  | `contractOccupancy(contractId)` | **same key** as checkout | Occupant move-in/out and holder transfer never run concurrently with a checkout |
  | `meterReading(roomId, month)` | `meter:{roomId}:{YYYY-MM}` | Duplicate readings |
  | `monthlyBilling(buildingId, yyyymm)` | `cron:billing:{buildingId}:{YYYYMM}` | One pod per billing run |
  | `paymentTransaction(bankTxnId)` | `payment:{bankTxnId}` | Double-crediting a webhook |

* Retries with exponential backoff + full jitter (`LOCK_RETRY_*`); `autoRenew` watchdog extends at 50 % of TTL and aborts `handle.signal` if the lock is lost; `minHoldMs` keeps very fast cron locks for a minimum window (clock drift). `@DistributedLock('room:contract:{0}')` template decorator.

#### 4.4 `OutboxModule` (`src/infrastructure/outbox/`)

* **`OutboxService.createEventInTransaction(manager, dto)`** inserts into `outbox_events` with the business transaction's `EntityManager`, capturing `building_id`, `trace_id`, W3C `traceparent` and `actor_id` from the context.
* **`outbox_events`:** `status` `PENDING | PROCESSING | PUBLISHED | FAILED | DEAD_LETTER`, `retry_count`, `max_retries` (`OUTBOX_MAX_RETRIES`), `next_retry_at` (retry time, or lease expiry while `PROCESSING`), `last_error`, `processed_at`. Index `idx_outbox_poll_pending (status, next_retry_at, created_at)`.
* **`OutboxPollerService`:** one atomic statement claims a batch — `UPDATE … SET status='PROCESSING', next_retry_at = now() + lease WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING …` — so pods never claim the same event; events whose lease expired (crashed pod) are reclaimed. Failures back off exponentially with jitter (`OUTBOX_BASE_RETRY_DELAY_MS`) up to `DEAD_LETTER`. Relays: BullMQ `domain-events-queue` with `jobId = event id` (deduplicated) or in-process `AppEventPublisher`. `OutboxCleanerService` purges `PUBLISHED` rows after `OUTBOX_RETENTION_DAYS` (7).
* **Verified:** 60 events polled concurrently by 3 simulated pods → each relayed exactly once.

#### 4.5 Migrations & seeding (`src/core/database/migrations/`, `seeds/`)

* **Execution:** `npm run migration:run:prod` (`dist/core/database/migration-runner.js`) as a Kubernetes Job / InitContainer — all pending migrations in one transaction, exit code 1 on failure. Locally: `npm run migration:run:local`, `npm run migration:show`, `npm run migration:revert`.
* **Migrations:**

  | Migration | Content |
  | :-- | :-- |
  | `1710000000000-SetupRowLevelSecurity` | Legacy `setup_tenant_rls()` helper (superseded) |
  | `1791043417730-CreateInfrastructureTables` | `audit_logs` + WORM triggers, `outbox_events` |
  | `1792160000000-AlignRentalBuildingScope` | `tenant_id → building_id` (nullable), spec index / trigger names, `setup_building_rls()` |
  | `1792250000000-CreateReferenceDataTables` | `system_roles`, `role_permissions`, `evn_tariff_tiers`, `statutory_tax_rules`, `statutory_forms` |

  Every domain migration that creates a building-scoped table must call `SELECT setup_building_rls('<table>')`.
* **Seeds** (`npm run db:seed`, `node dist/core/database/seed-runner.js`): each seed runs in its own transaction under `pg_advisory_xact_lock` (concurrent jobs never double-seed). All values come from code constants:
  * `system-roles` — the 5 roles (descriptions updated in place).
  * `role-permissions` — **synchronised** with `DEFAULT_ROLE_PERMISSIONS`: missing grants inserted, grants removed from code deleted (a stale grant is a privilege leak).
  * `evn-tariff-tiers` — 6 tiers effective 2025-05-10 (immutable history; a price change is a new effective date).
  * `statutory-tax-rules` — `RENTAL_PRE_2026` (100 M threshold, PIT on total revenue) and `RENTAL_2026` (1 B threshold, PIT on the excess, licence fee 0) with `pit_base`.
  * `statutory-forms` — `01/BĐS`, `01/BK-BĐS`, `01/TTS` (legacy), `CT01`.

---

### Group 5: External Integration & Fault Tolerance

#### 5.1 `ResilienceModule` (`src/core/resilience/`)

* **Stack:** `opossum` circuit breaker + custom semaphore bulkhead + retry with exponential backoff and full jitter (4xx are not retried). `@Resilient(name, policy, fallbackMethod)`; circuit state exported to metrics.
* **Partner policies** (`EXTERNAL_PARTNERS`): `e-invoice-gateway` (VNPT / Viettel / MISA, 20 concurrent, 10 s), `zalo-zns` (30, 5 s), `sms-gateway` (10, 5 s), `vietqr-bank` (10, 8 s), `telegram-bot` (5, 5 s); breaker opens at > 50 % errors (min 5 calls), half-opens after 30 s. Bulkhead overflow → `503 EXT_BULKHEAD_LIMIT_REACHED`; open circuit → `EXT_CIRCUIT_OPEN`.

#### 5.2 `HttpClientModule` (`src/infrastructure/http/`)

* `AppHttpClient` (`@nestjs/axios`): timeout `HTTP_CLIENT_TIMEOUT_MS`, retries (`HTTP_CLIENT_MAX_RETRIES`) with jitter on idempotent requests for `502/503/504`/network errors, `MtlsAgentFactory` for client certificates.
* Injects `traceparent`, `x-trace-id`, `x-correlation-id` and `x-building-id` (skippable for third parties such as Telegram); logs never include bodies or credentials.

#### 5.3 `WebhookModule` (`src/infrastructure/webhook/`)

* **Ingress:** `@VerifyWebhookSignature({ secret, signatureHeader, toleranceSeconds })` marks the route `@Public()` and applies `WebhookSignatureGuard`: `HMAC-SHA256(timestamp + "." + rawBody)` compared with `timingSafeEqual`; timestamps outside `WEBHOOK_TOLERANCE_SECONDS` (300) are rejected (replay). Header presets: `WEBHOOK_PROVIDERS.VIETQR` (`x-vietqr-signature`), `ZALO` (`x-zalo-signature`), `GENERIC` (`x-signature`).
* **Egress:** `WebhookDispatcherService` signs payloads (`x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id` for receiver deduplication) and retries through `webhook-dispatch-queue`.

---

### Group 6: Asynchronous Operations, Messaging & Realtime

#### 6.1 `QueueModule` (`src/infrastructure/queue/`)

* **Stack:** BullMQ on a dedicated Redis connection, prefix `QUEUE_PREFIX` (`rma:bull`).
* **Queues** (`QUEUE_NAMES`): `notification-queue`, `document-rendering-queue`, `monthly-billing-queue`, `statutory-export-queue`, `e-invoice-dispatch-queue`, `domain-events-queue`, `webhook-dispatch-queue`.
* **Envelope:** `BaseQueueProducer` wraps payloads as `{ metadata: { traceId, tenantId (building), actorId, enqueuedAt, traceparent }, payload }`; `BaseQueueWorker` restores the context with `runWithContext()`.
* **DLQ:** `DlqMonitorService` moves jobs that exhausted their attempts (`QUEUE_DEFAULT_ATTEMPTS`, exponential backoff) to `<queue>-dlq` with payload, error and context. Workers pause in shutdown phase 2.

#### 6.2 `ScheduleModule` (`src/infrastructure/schedule/`)

* `@DistributedCron(cron, lockKey, options)` — only one pod runs each tick; synthetic trace id; `minHoldMs` against clock drift.
* **Schedules** (`RENTAL_SCHEDULES`, time zone `Asia/Ho_Chi_Minh`): `MONTHLY_BILLING` 00:00 on the 28th; `OVERDUE_INVOICES` daily 08:00; `COMPLIANCE_EXPIRY` daily 02:00 (PCCC insurance / extinguishers, temporary-residence expiry, **occupants pending residence declaration or deregistration**); `AUDIT_TIERING` Sunday 03:00; `OUTBOX_CLEANUP` Sunday 03:30.

#### 6.3 `NotificationModule` (`src/infrastructure/notification/`)

* Channels: `ZALO`, `EMAIL` (Nodemailer / SMTP), `SMS` (Twilio), `TELEGRAM`; a channel without provider credentials is disabled. `NOTIFICATION_DRY_RUN` (default outside production) logs instead of sending.
* Multi-channel dispatch uses `Promise.allSettled` — one channel failing never aborts the others. Recipients are masked in logs (`090***4567`, `t***@gmail.com`, Zalo id `***PROTECTED***`).
* **Templates** (`NOTIFICATION_TEMPLATES`, HTML-escaped `{{path.to.value}}`): `OTP_VERIFICATION`, `INVOICE_ISSUED` (with VietQR link), `INVOICE_OVERDUE`, `PAYMENT_RECEIVED`, `CONTRACT_ACTIVATED`, `CHECKOUT_SETTLED`, `PRIMARY_HOLDER_CHANGED`, and Telegram manager alerts `METER_READINGS_MISSING`, `METER_ANOMALY_ALERT`, `COMPLIANCE_EXPIRY_ALERT`, `RESIDENCE_ACTIONS_PENDING`.

#### 6.4 `DomainEventModule` (`src/infrastructure/events/`)

* `BaseDomainEvent<T>` carries `traceId`, `tenantId` (building), `actorId`, `occurredAt`; `AppEventPublisher.publishAsync()` runs listeners with `Promise.allSettled` inside the original context.
* **Catalogue** (`DOMAIN_EVENTS`): `room.status_changed`, `room.checked_out`; `tenant.registered`, `tenant.pii_anonymized`; `contract.activated`, `contract.renewed`, `contract.terminated`, **`contract.primary_holder_changed`**; **`occupant.moved_in`, `occupant.moved_out`**; **`residence.declaration_required`, `residence.deregistration_required`, `residence.status_changed`**; `deposit.collected|deducted|refunded`; `meter_reading.recorded|anomaly_detected|reset_approved`; `invoice.generated|overdue|paid`; `payment.received|failed`; `checkout.settled`; `compliance.pccc_expiring|residence_renewal_due|tax_exported`.

#### 6.5 `WebSocketModule` (`src/infrastructure/websocket/`)

* Socket.IO with `@socket.io/redis-adapter` (multi-pod broadcast), enabled by `WS_ENABLED`.
* `WsJwtGuard` verifies the token during the handshake; sockets join `building:{buildingId}` and `user:{userId}`.
* `RealtimeEmitterService.emitToBuilding()` / `emitToUser()` / `emitToRoom()`; events `meter_reading.submitted`, `meter_reading.anomaly`, `room.status_changed`, `room.occupancy_changed`, `invoice.paid`, and `reconnect_please` during shutdown.

---

### Group 7: Storage & Document Processing

#### 7.1 `StorageModule` (`src/infrastructure/storage/`)

* **Stack:** AWS SDK v3 (AWS S3, MinIO, Supabase Storage). Disabled unless `STORAGE_ENABLED=true`.
* **Presigned PUT** (`STORAGE_UPLOAD_URL_TTL_SECONDS`, 15 min) with signed `Content-Type` and optional exact `Content-Length` (≤ `STORAGE_MAX_UPLOAD_BYTES`) — guards upload meter photos and ID scans directly to the bucket. **Presigned GET** for private objects (`STORAGE_DOWNLOAD_URL_TTL_SECONDS`, 5 min) after authorisation; public objects through `STORAGE_PUBLIC_BASE_URL`.
* **Object keys:** `buildings/{buildingId}/{public|private}/{category}/{YYYY}/{MM}/{uuid}_{sanitizedName}`. Categories: `meter-photos`, `identity-documents` (one scan per occupant), `contracts`, `contract-addenda`, `handover-minutes`, `residence-ct01`, `settlements`, `tax-exports`, `room-photos`.
* **Sanitisation:** basename only (no `../` or Windows paths), safe characters, the extension must match the declared type; client uploads limited to `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.

#### 7.2 `DocumentReportModule` (`src/infrastructure/document/`)

* **PDF (`PdfGeneratorService`, pdfkit):** renders a `StatutoryDocumentPayload` built by the domain module using Vietnamese administrative layout — national motto, document number, place and date (Vietnam time), "Căn cứ …" legal basis, parties, numbered articles (*Điều*), tables that paginate, signature blocks. Embed a Unicode font with `PDF_FONT_PATH` / `PDF_FONT_BOLD_PATH`; without it diacritics are stripped instead of printing broken glyphs. `renderAndUpload()` stores the PDF privately under the category of its type and returns a presigned URL.
* **Document types:** `LEASE_CONTRACT`, `HANDOVER_MINUTES`, `RESIDENCE_CT01` (**one form per occupant**), `CHECKOUT_SETTLEMENT`, `HOLDER_TRANSFER_ADDENDUM` (contract addendum when the holder changes).
* **Excel (`ExcelStreamService`, ExcelJS streaming writer):** row-by-row streaming to the HTTP response or object storage with flat memory — tax declarations (01/BĐS, 01/BK-BĐS) and residence batch files.

---

### Group 8: API Governance & Developer Experience

#### 8.1 `SwaggerModule` (`src/infrastructure/swagger/`)

* Enabled by `SWAGGER_ENABLED` (default: outside production) under `SWAGGER_PATH` (`api/docs`):
  * `/api/docs` — internal, every operation; `/api/docs/admin` — landlord / manager / accountant; `/api/docs/guard` — guard mobile app; `/api/docs/external` — tenant self-service and webhooks. JSON at `<path>-json`.
* `@ApiAudience('admin', 'guard')` assigns operations to portals; untagged operations appear only in the internal document. Global Bearer auth and `X-Building-ID` parameter.

#### 8.2 `VersioningModule` (`src/infrastructure/versioning/`)

* URI versioning `/api/v{n}` (`API_DEFAULT_VERSION=1`); `/health/*` and `/metrics` are outside the prefix.
* `@DeprecatedApi({ sunsetDate, deprecatedAt?, alternativePath? })` + `DeprecationInterceptor` add RFC 8594 `Deprecation` / `Sunset` / `Link` headers.

#### 8.3 `I18nModule` (`src/core/i18n/`)

* In-house dictionaries `vi` (default, `I18N_DEFAULT_LOCALE`), `en`, `ja`, `ko`, keyed by error code; locale from `Accept-Language` (quality-ordered, `ja-JP` → `ja`) or `?lang=`. Every `SystemErrorCode` has a message in all four locales.

#### 8.4 `FeatureFlagModule` (`src/core/feature-flag/`)

* Baseline rules in `FEATURE_FLAGS` (JSON: `enabled`, `percentage`, `allowedTenantIds` = building ids, `allowedUserIds`), runtime overrides in the Redis hash `feature_flags`, refreshed every `FEATURE_FLAG_CACHE_TTL_MS` by every pod. Stable percentage rollout by user, then building. `@RequireFeature()` + global `FeatureFlagGuard` (`RES_FEATURE_DISABLED`).
* **Flags** (`FEATURE_FLAGS`): `evn_tiered_quota` (tiered quota vs. flat tier-3 pricing), `e_invoice_auto_dispatch`, `zalo_zns_invoice`, `late_payment_penalty`, `pii_auto_anonymization`.

---

## 3. Common Utilities (`src/common/`)

### 3.1 Decorators

| Decorator | Usage | Responsibility |
| :-- | :-- | :-- |
| `@CurrentUser()` | `@CurrentUser('id') userId: string` | Authenticated user (or one property) from `req.user`, falling back to the request context |
| `@CurrentTenant()` | `@CurrentTenant() buildingId: string` | **Verified** active building — never the raw header |
| `@TraceId()` | `@TraceId() traceId: string` | Active trace id |
| `@IdempotencyKey()` | `@IdempotencyKey() key: string` | Validated `Idempotency-Key` header |
| `@Roles()` | `@Roles('LANDLORD', 'ACCOUNTANT')` | Coarse role check (`RolesGuard`) |
| `@Public()` | `@Public()` | Skips `JwtAuthGuard` (login, webhooks, probes, metrics) |
| `@SkipAudit()` | `@SkipAudit()` | Excludes a mutating route from HTTP audit |

### 3.2 Exception filters & error contract

* `HttpExceptionFilter` and `AllExceptionsFilter` emit **RFC 7807** `application/problem+json`, localised by `Accept-Language`:

```json
{
  "type": "https://errors.room-management.local/DB_UNIQUE_CONSTRAINT_VIOLATION",
  "title": "Conflict",
  "status": 409,
  "detail": "A record with the same unique identifier already exists.",
  "instance": "/api/v1/contracts",
  "success": false,
  "statusCode": 409,
  "errorCode": "DB_UNIQUE_CONSTRAINT_VIOLATION",
  "message": "Dữ liệu bị trùng với một bản ghi đã tồn tại.",
  "details": [{ "field": "roomId", "issue": "Active contract collision" }],
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "timestamp": "2026-10-16T08:35:00.000Z",
  "path": "/api/v1/contracts"
}
```

* **PostgreSQL translation** (no SQL or table names leak): `23505 → 409 DB_UNIQUE_CONSTRAINT_VIOLATION`, `23503 → 400 DB_FOREIGN_KEY_VIOLATION`, `23514 → 400 DB_CHECK_CONSTRAINT_VIOLATION`, `23502 / 22P02 → 400 REQ_VALIDATION_ERROR`, `40P01 / 40001 → 409 RES_CONCURRENCY_CONFLICT`, `55P03 → 409 RES_LOCKED`, `42501 → 403` (includes RLS and WORM violations), `57014 → 503`, `53300 → 503`. `OptimisticLockVersionMismatchError → 409 RES_CONCURRENCY_CONFLICT`.
* Stack traces are removed in production and logged internally with trace id and user id.
* **Error-code families** (`SystemErrorCode`): `AUTH_*`, `REQ_*`, `RES_*`, `DB_*`, `BIZ_*` (rooms, contracts, occupants & contract holder, PDPL, meters, invoices, checkout, deposits, payments, tax, compliance), `SEC_*`, `EXT_*`, `SYS_*`. Services throw `new XxxException({ errorCode, message, details })`.

### 3.3 Guards (registration order in `AppModule`)

1. `JwtAuthGuard` — Bearer token (`JWT_ALGORITHM`, issuer / audience / clock tolerance), zod-validated claims (`sub`, `email`, `buildingId`/`tenantId`, `buildingIds`, `departmentId`, `roles`, optional `rules`), refresh tokens rejected; honours `@Public()`.
2. `CustomThrottlerGuard` — per user (authenticated) or per IP.
3. `RolesGuard` — `@Roles()`.
4. `PermissionsGuard` — CASL (3.1).
5. `FeatureFlagGuard` — `@RequireFeature()`.

### 3.4 Interceptors (outer → inner)

`RequestContextSyncInterceptor` → `TenancyContextInterceptor` → `DeprecationInterceptor` → `AuditInterceptor` (outside the timeout, so timed-out requests are audited) → `TimeoutInterceptor` (`HTTP_REQUEST_TIMEOUT_MS` = 15 s, per route `@SetRequestTimeout(ms)`, `408 REQ_TIMEOUT`) → `TransformInterceptor` (`{ success, statusCode, data, meta: { traceId, timestamp, durationMs, pagination? } }`, bypassed for `StreamableFile` and `@SkipEnvelope()`) → `HttpCacheInterceptor` → `IdempotencyInterceptor` (innermost: stores the raw handler result).

### 3.5 Pipes

* `CustomValidationPipe` — `whitelist`, `forbidNonWhitelisted`, `transform`; nested errors flattened to `{ field, message }[]` (`400 REQ_VALIDATION_ERROR`).
* `ParseDatePipe` — ISO-8601 / `YYYY-MM-DD`, rejects impossible dates such as `2026-02-30`.
* `ParseUUIDStrictPipe` — UUID parameters, `REQ_INVALID_UUID` with the parameter name.

### 3.6 Constants

* `REGEX_PATTERNS`: UUID, Vietnamese phone, `VIETNAM_CITIZEN_ID` (12 digits — also the personal identification number of children), `PASSPORT`, `VIETNAM_TAX_CODE`, `VIETNAM_LICENSE_PLATE`, `ROOM_NUMBER`, `BILLING_MONTH` (`YYYY-MM`), `DATE_ISO_YMD`, `STRONG_PASSWORD`.
* `SYSTEM_HEADERS`: `x-trace-id`, `x-correlation-id`, `x-request-id`, `x-building-id`, `idempotency-key`, …
* `vn-rental.constant.ts`: `VN_TAX_2026`, `VN_STATUTORY_FORMS`, `ElectricityBillingMode`, `EVN_RESIDENTIAL_TIERS`, `EVN_RULES`, `RENTAL_OPERATIONS`, `VN_BUSINESS_TIMEZONE`.

---

## 4. End-to-End Request & Background Pipeline

```
+--------------------------------------------------------------------------------------------+
| 1. INGRESS                                                                                 |
|  Helmet -> CORS whitelist -> body limit -> InFlightRequestMiddleware -> HttpMetricsMiddleware |
|  -> RequestContextMiddleware (ALS store, trace id, client IP, locale)                       |
+--------------------------------------------------------------------------------------------+
                                            |
+--------------------------------------------------------------------------------------------+
| 2. GUARDS                                                                                  |
|  JwtAuthGuard -> CustomThrottlerGuard -> RolesGuard -> PermissionsGuard -> FeatureFlagGuard |
+--------------------------------------------------------------------------------------------+
                                            |
+--------------------------------------------------------------------------------------------+
| 3. INTERCEPTORS & PIPES                                                                    |
|  ContextSync -> Tenancy (X-Building-ID) -> Deprecation -> Audit -> Timeout -> Transform      |
|  -> HttpCache -> Idempotency -> CustomValidationPipe / ParseUUIDStrictPipe / ParseDatePipe  |
+--------------------------------------------------------------------------------------------+
                                            |
+--------------------------------------------------------------------------------------------+
| 4. DOMAIN & PERSISTENCE                                                                    |
|  Service (@DistributedLock / RedisCacheService / @Resilient)                               |
|  -> RlsService transaction (SET LOCAL app.current_building_id)                             |
|  -> TypeORM (FieldEncryptionTransformer, TenancySubscriber, AuditEntitySubscriber)         |
|  -> OutboxService (same transaction)                                                       |
+--------------------------------------------------------------------------------------------+
                 | synchronous response                          | asynchronous
+-------------------------------------------+   +--------------------------------------------+
| 5A. EGRESS                                |   | 5B. BACKGROUND                             |
|  Envelope or binary stream (PDF / Excel)  |   |  OutboxPoller (FOR UPDATE SKIP LOCKED)     |
|  Errors -> RFC 7807 (PG codes translated) |   |  BullMQ workers (context restored), DLQ    |
|                                           |   |  @DistributedCron, documents, notifications |
+-------------------------------------------+   +--------------------------------------------+
```

---

## 5. Core Implementation Blueprints

### 5.1 Verified building context (`TenancyContextInterceptor`)

```ts
// src/core/multitenancy/tenancy-context.interceptor.ts (simplified)
intercept(context: ExecutionContext, next: CallHandler) {
  const req = context.switchToHttp().getRequest();
  const headerBuildingId = req.headers[BUILDING_HEADER]; // 'x-building-id'
  if (headerBuildingId && !UUID_REGEX.test(headerBuildingId)) throw new BadRequestException(/* … */);

  const user = syncUserFromRequest(context, this.contextService); // req.user -> AsyncLocalStorage
  if (!user) {
    this.contextService.setRequestedTenantId(headerBuildingId); // unverified, never used for writes
    return next.handle();
  }
  if (headerBuildingId && headerBuildingId !== user.tenantId) {
    const privileged = user.roles.includes(SUPER_ADMIN_ROLE) || user.roles.includes(SYSTEM_ROLE);
    if (!privileged && !user.buildingIds?.includes(headerBuildingId)) {
      throw new ForbiddenException('Building access mismatch: X-Building-ID is not assigned to the authenticated user.');
    }
    this.contextService.setTenantOverride(headerBuildingId);
  }
  return next.handle();
}
```

### 5.2 Connection-pool-safe RLS (`RlsService`)

```ts
// src/core/multitenancy/rls.service.ts (simplified)
const SET_LOCAL_SQL = 'SELECT set_config($1, $2, true)'; // is_local = true ≡ SET LOCAL, parameterised

async runInTenantContext<T>(operation: (manager: EntityManager) => Promise<T>, explicitBuildingId?: string) {
  const active = this.contextService.getBuildingId();
  if (explicitBuildingId && active && explicitBuildingId !== active && !this.isTrustedCaller()) {
    throw new ForbiddenException('Cannot execute in a building other than the authenticated one.');
  }
  const buildingId = explicitBuildingId || active;
  if (!buildingId || !UUID_REGEX.test(buildingId)) throw new BadRequestException(/* … */);

  return this.dataSource.transaction(async (manager) => {
    await manager.query(SET_LOCAL_SQL, ['app.current_building_id', buildingId]);
    return operation(manager); // the setting disappears at COMMIT / ROLLBACK
  });
}

async runWithBypass<T>(operation: (manager: EntityManager) => Promise<T>) {
  if (!this.isTrustedCaller()) throw new ForbiddenException(/* system workers & super admins only */);
  return this.dataSource.transaction(async (manager) => {
    await manager.query(SET_LOCAL_SQL, ['app.bypass_rls', 'on']);
    return operation(manager);
  });
}
```

### 5.3 Encryption & blind index (`EncryptionService`)

```ts
// src/core/security/encryption/encryption.service.ts (simplified)
encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', this.keyStore.get(this.activeKeyVersion)!, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['enc', this.activeKeyVersion, iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}

computeBlindIndex(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\s.-]/g, '').toUpperCase();
  if (!normalized) throw new Error('Cannot compute a blind index for an empty value.');
  return createHmac('sha256', this.blindIndexPepper).update(normalized, 'utf8').digest('hex');
}
```

### 5.4 Contract-holder succession (`selectNextPrimaryHolder`)

```ts
// src/modules/contracts/domain/occupancy.policy.ts (simplified)
const remaining = occupants.filter((o) => o.tenantId !== outgoingTenantId && o.status === OccupancyStatus.ACTIVE);
if (remaining.length === 0) throw new ConflictException({ errorCode: 'BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT' });

if (preferredTenantId) {
  // designated successor must be eligible; reasons returned in `details`
}
const next = remaining
  .filter((o) => primaryHolderIneligibility(o, effectiveDate).length === 0) // adult, ID document, PDPL consent
  .sort(bySuccession)[0]; // successionOrder ASC, then movedInAt ASC, then tenantId
if (!next) throw new ConflictException({ errorCode: 'BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED' });
return next;
```

---

## 6. Verification

| Suite | Command | Covers |
| :-- | :-- | :-- |
| Unit | `npm test` | Every module in isolation (mocks), including the occupancy policy |
| e2e + integration | `docker compose --profile postgres up -d` then `npm run test:e2e` | Full pipeline over HTTP; RLS as `app_user`; lock contention, TTL, fencing, watchdog; cache single-flight, tag `UNLINK`, building isolation; multi-pod outbox, retries, DLQ, lease recovery; idempotency under concurrency; role matrix over HTTP; throttling per user; seeding; PostgreSQL error translation; WORM; encryption; feature flags across pods; Prometheus output; graceful shutdown |
