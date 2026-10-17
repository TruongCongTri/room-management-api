# Document 06: Core Modules Build Plan & Definition of Done (`06-Build-Plan.md`)

This document fixes the **order** in which the core feature modules of documents 02–05 are built, what each step contains, and the checklist every module must pass before the next one starts. Documents 02 (services), 03 (schema), 04 (API contract) and 05 (features & permissions) stay the source of truth; this plan only sequences them.

---

## 1. Decisions

| # | Decision | Where it is specified |
| :-- | :-- | :-- |
| D1 | **Enterprise-grade identity with phone-number sign-in** (no email login): argon2id passwords, OTP second factor for `LANDLORD` / `ACCOUNTANT`, OTP account activation and password reset, rotating refresh tokens with reuse detection, visible / revocable sessions, login lock, no account enumeration. Staff accounts are created by the landlord; tenant accounts are created automatically for adult occupants with a phone number when they move in. | 02 §2.0, 03 §3.0, 04 §1.4 + tag *Identity & Authentication*, 05 §1.0 |
| D2 | **A tenant can view only the room they currently live in** — `GET /properties/rooms/mine`, or `GET /properties/rooms/{id}` for that same room (`RoomAccessGuard` + `OCCUPANCY_SELF_SCOPE`). Other rooms → `403`; access ends at move-out. No room list or vacancy data for tenants. | 02 §2.0.2, 04 room paths, 05 A6 + RBAC |
| D3 | **Room detail is completed in two steps.** Module 1 ships room detail with `activeContract = null` and zero occupants (the contract tables do not exist yet); module 3 extends the same single query with the active contract, holder and occupant counts. `OCCUPANCY_SELF_SCOPE` defaults to "no room" until module 3, so tenants are denied (fail-closed) in between. | this document |
| D4 | Shared-room rules already agreed: holder must be 18+, with an ID document and consent; deposit default `CARRY_OVER` on holder transfer; invoices issued before a transfer stay with the outgoing holder; a guardian gives consent for children. | 02 §5.4, 03 §3.2 |

---

## 2. Build Order

Each module brings its **own migration** (tables, partial indexes, CHECKs, triggers and `setup_building_rls()` from document 03), so every step can be tested on its own.

| # | Module | Scope | Tables (doc 03) | Endpoints (doc 04) | Depends on |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **0** | **Identity** | Phone sign-in, OTP, sessions, staff accounts, `PERMISSION_RULES_LOADER`, `OCCUPANCY_SELF_SCOPE` contract (default deny) | `users`, `user_roles`, `user_building_access`, `auth_sessions` (+ Redis state §3.0 I-5) | `/auth/*` (12 operations), `/users`, `/users/{id}` | supporting layer (JWT, access control, Redis, notification, audit, throttler) |
| **1** | **Properties & Assets** | Buildings, room types, 80 rooms, appliance catalogue and room assignment, vacancy summary (XFetch + tags), tenant room guard | `buildings`, `room_types`, `rooms`, `assets`, `room_assets` (+ FK `user_building_access → buildings`) | `/properties/rooms`, `/properties/rooms/vacancies/summary`, `/properties/rooms/mine`, `/properties/rooms/{id}` (without contract part, D3), `/assets/room-assignments` | 0 |
| **2** | **Tenants** | One profile per person, encrypted ID + blind index, consent (guardian for children), lookup by CCCD, `tenants.user_id` link | `tenants` | `/tenants`, `/tenants/lookup` | 0, 1 |
| **3** | **Contracts** | Draft / activate / renew, 1-month deposit ledger, occupants move in / out, residence status, holder transfer + history, vehicles, extra services, rented appliances; real `OCCUPANCY_SELF_SCOPE`; tenant-account provisioning on `occupant.moved_in`; room detail completed (D3) | `contracts`, `contract_occupants`, `contract_holder_transfers`, `contract_assets`, `service_catalogs`, `contract_services`, `tenant_vehicles`, `deposit_ledgers` (+ consistency triggers) | `/contracts`, `/contracts/{id}/deposit-ledger`, `/contracts/{id}/occupants…`, `/contracts/{id}/primary-holder/…` | 1, 2 |
| **4** | **Metering** | Presigned photo upload, readings with rollover / reset (approval), spike alerts, missing-room checklist | `meter_readings` | `/metering/presigned-url`, `/metering/records`, `/metering/cycles/{month}/missing-rooms` | 1, 3 |
| **5** | **Billing** | EVN tariff (registered-headcount quota vs. flat tier 3), month-end invoices (distributed cron → queue worker → PDF), mid-month checkout settlement, VietQR webhook | `invoices`, `invoice_line_items`, `payment_transactions`, `checkout_settlements` | `/billing/checkout/execute`, `/webhooks/payments/vietqr` | 3, 4 |
| **6** | **Compliance VN** | Lease / handover / settlement / holder-transfer PDFs, one CT01 per occupant, residence work queue, Form 01/BĐS stream, PCCC status | `pccc_compliance_logs` | `/compliance-vn/*` | 3, 5 |

### 2.1 Module 0 — supporting-layer changes it includes

Identity touches code that already exists; these changes are part of module 0, not separate work:

* Access-token claims: replace `email` with `phoneMasked`, add `sid`; `JwtTokenService.verifyAccessToken()` checks `auth:revoked-sid:{sid}`. `RequestUserContext.email` becomes `phoneMasked` (the audit log's actor column stores the masked phone).
* Fix `REGEX_PATTERNS.VIETNAM_PHONE`: `5[6|8|9]` and `7[0|6-9]` are character classes that also accept `|`; replace with `5[689]` / `7[06-9]` and add tests for it.
* New error codes (+ vi / en / ja / ko messages): `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_DISABLED`, `AUTH_OTP_INVALID`, `AUTH_OTP_EXPIRED`, `AUTH_OTP_TOO_MANY_ATTEMPTS`, `AUTH_OTP_RATE_LIMITED`, `AUTH_REFRESH_TOKEN_REUSED`, `AUTH_PASSWORD_POLICY_VIOLATION`, `BIZ_NO_ACTIVE_ROOM`.
* Permissions: new resource `users` (`LANDLORD` only, through `*:*:global`); `TENANT` gains `rooms:read:own`; `role_permissions` re-seeded.
* `OCCUPANCY_SELF_SCOPE` token + default resolver (returns `null`) in `src/core/access-control/`.
* Notification templates: `OTP_CODE`, `ACCOUNT_INVITATION`, `SECURITY_ALERT` (refresh-token reuse, password changed).
* Dependency: `argon2`.
* Dev seed: one account per role with known test passwords (`npm run db:seed`, refused when `NODE_ENV=production`).
* Done as part of module 0 as well: `audit_logs.actor_email` renamed to `actor_label` (masked phone); `HttpExceptionFilter` sends `Retry-After` for errors carrying `retryAfterSeconds` (423 lock, 429 OTP limits); new config `AUTH_*` (see `.env.example`); `test/e2e-env.ts` resets per-file overrides so e2e files cannot leak settings into each other.

### 2.2 Module 0 — how to run it locally

| Step | Command / setting |
| :-- | :-- |
| Schema + dev accounts | `npm run migration:run:local && npm run db:seed` |
| Dev accounts | password `RentalDev@2026`; building A `b1000000-0000-4000-8000-000000000001`: landlord `0901000001` (OTP step), manager `0901000002`, accountant `0901000003` (OTP step), guard `0901000004`, tenant `0901000005`; building B: landlord `0902000001` |
| `.env.local` for Postman | `AUTH_OTP_DEBUG_ECHO=true` (OTP returned as `debugCode`), `THROTTLE_SENSITIVE_LIMIT=100` (the collection signs in ~15 times a minute from one IP) |
| Postman / CLI | import `postman/room-management.postman_collection.json` + `postman/local.postman_environment.json`, or `npx newman run postman/room-management.postman_collection.json -e postman/local.postman_environment.json`; re-seed and wait 60 s between runs |

---

## 3. Definition of Done (every module)

A module is done only when **all** of the following hold. Then work stops and waits for confirmation before the next module.

### 3.1 Schema

* Migration matches document 03 exactly: columns, types, defaults, partial unique indexes, CHECKs, triggers, RLS (`setup_building_rls`) for building-scoped tables.
* Applied to the local database and verified **up → down → up**.
* Entities match the migration (`npm run typeorm -- schema:log` shows no pending changes).

### 3.2 Services use the supporting modules where the docs say so

| Concern | Supporting module (doc 01) |
| :-- | :-- |
| Building isolation | `BuildingScopedEntity`, `TenancySubscriber`, `RlsService` transactions |
| Identity numbers, bank accounts | `FieldEncryptionTransformer`, `EncryptionService.computeBlindIndex()` |
| Permissions | `@RequirePermissions`, `PermissionsGuard`, `PermissionCacheService` |
| Read-heavy queries | `CacheService.getOrSet` (single-flight + XFetch), tag invalidation |
| Concurrency | `DistributedLockService.runWithLock` with `LOCK_KEYS`, optimistic `version` |
| Side effects | `OutboxService.createEventInTransaction` → domain events → queues / notifications / realtime |
| Retried mutations | `IdempotencyInterceptor` (`Idempotency-Key`) |
| Files | `StorageService` (presigned URLs, private categories), `PdfGeneratorService` |
| Traceability | `AuditInterceptor` / audit log, structured logs with PII masking, metrics |
| External calls | `@Resilient()` circuit breaker + bulkhead |

### 3.3 Unit tests: behaviour, not coverage

* Every rule in documents 02 / 05 for the module has a test that **fails if the rule is broken**: boundaries (18th birthday, last day of month, capacity exactly full, OTP 5th vs. 6th attempt), concurrency (same room activated twice, refresh token used twice), wrong state transitions, cross-building access, PII never in responses or logs.
* Tests assert the client-visible contract: HTTP exception type, `errorCode`, `details`.
* **Mutation check:** for each module, deliberately break key rules in the code and confirm a test goes red; record the mutations tried in the module report.

### 3.4 End-to-end tests (real app, Docker PostgreSQL 5433 + Redis)

* Every endpoint of the module in document 04: success shape (envelope + DTO), every documented status code and `errorCode`.
* Permission matrix of document 05 per role (allowed and denied), including `TENANT` `OWN` rules.
* Building isolation: data of building A never visible or writable with building B's header or token.
* Idempotency on mutating endpoints that require `Idempotency-Key` (replay, payload mismatch, missing key).

### 3.5 Live HTTP run ("as in Postman")

* Start the app locally against the local database and call each endpoint over HTTP with real tokens from `POST /auth/login`.
* Deliver / extend the **Postman collection and environment** in `postman/` (`room-management.postman_collection.json`, `local.postman_environment.json`): one folder per module, tokens captured automatically by test scripts, assertions on status and `errorCode`.

### 3.6 Close-out

* `npm run lint` clean, all unit and e2e tests green, seed runs.
* Docs updated if implementation revealed a gap (and the gap called out in the report).
* Short report: what was built, test counts, mutations caught, anything deferred.

---

## 4. Progress

| # | Module | Status |
| :-- | :-- | :-- |
| — | Supporting modules (doc 01) | ✅ Done |
| 0 | Identity | ✅ Done (2026-10-17): 508 unit + 102 e2e tests, 21/21 mutations caught, Postman 47 requests / 58 assertions |
| 1 | Properties & Assets | ⏳ Waiting for go-ahead |
| 2 | Tenants | ⬜ Not started |
| 3 | Contracts | ⬜ Not started |
| 4 | Metering | ⬜ Not started |
| 5 | Billing | ⬜ Not started |
| 6 | Compliance VN | ⬜ Not started |
