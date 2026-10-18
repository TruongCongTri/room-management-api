# Document 06: Core Modules Build Plan & Definition of Done (`06-Build-Plan.md`)

This document fixes the **order** in which the core feature modules of documents 02–05 are built, what each step contains, and the checklist every module must pass before the next one starts. Documents 02 (services), 03 (schema), 04 (API contract) and 05 (features & permissions) stay the source of truth; this plan only sequences them.

---

## 1. Decisions

| # | Decision | Where it is specified |
| :-- | :-- | :-- |
| D1 | **Enterprise-grade identity with phone-number sign-in** (no email login): argon2id passwords, OTP second factor for `LANDLORD` / `ACCOUNTANT`, OTP account activation and password reset, rotating refresh tokens with reuse detection, visible / revocable sessions, login lock, no account enumeration. Staff accounts are created by the landlord; tenant accounts are created automatically for adult occupants with a phone number when they move in. | 02 §2.0, 03 §3.0, 04 §1.4 + tag *Identity & Authentication*, 05 §1.0 |
| D2 | **A tenant can view only the room they currently live in** — `GET /properties/rooms/mine`, or `GET /properties/rooms/{id}` for that same room (`RoomAccessGuard` + `OCCUPANCY_SELF_SCOPE`). Other rooms → `403`; access ends at move-out. No room list or vacancy data for tenants. | 02 §2.0.2, 04 room paths, 05 A6 + RBAC |
| D3 | **Room detail is completed in two steps.** Module 1 ships room detail with `activeContract = null` and zero occupants (the contract tables do not exist yet); module 3 extends the same single query with the active contract, holder and occupant counts. `OCCUPANCY_SELF_SCOPE` defaults to "no room" until module 3, so tenants are denied (fail-closed) in between. | this document |
| D5 | **Module 1 includes management endpoints** that docs 03/05 implied but doc 04 lacked: buildings (landlord), room types, room create / update (price, status, type), appliance catalogue, and update / remove of installed units. Added to docs 04/05 before implementation. | 04 *Properties* & *Assets* tags, 05 rows 04a/04b |
| D6 | **Public listing for the portfolio website (module 1b):** anonymous, read-only `/public/*` endpoints for published buildings, room types, floors / room numbers, room search, room detail with equipment, vacancies and the equipment catalogue; buildings opt in (`isPubliclyListed` + `publicSlug`), rooms can be hidden. The portfolio site's management area uses the existing authenticated endpoints. | 01 §3.2 / 3.4 / 4.2 / 8.1, 02 §3.1b, 03 §4 6b, 04 §1.5 + tag *Public Listing*, 05 row 04c + RBAC |
| D7 | **Module 2 adds profile management** that doc 04 lacked: `GET /tenants` (search), `GET /tenants/{id}`, `PATCH /tenants/{id}`, `GET /tenants/me`, next to `POST /tenants` and `/tenants/lookup`. ID-scan upload, full-number reveal and PDPL data-subject requests stay out of scope. | 02 §2.1b, 03 Tenant + §4 6c, 04 *Tenants*, 05 row 05 |
| D8 | **Module 3: lease lifecycle and full management of the extras.** `POST /contracts` creates a **draft** (room `RESERVED`, editable, cancellable); `POST /contracts/{id}/activate` moves everybody in, collects the 1-month deposit and marks the room `OCCUPIED`; `POST /contracts/{id}/renew` extends the end date (optionally new rent and a deposit top-up) with an addendum. Reads: `GET /contracts`, `GET /contracts/{id}`, `GET /contracts/mine`. Service catalogue per building (`/service-catalog`), a contract's services, and vehicles are managed through endpoints; per-person and per-vehicle quantities follow the occupants and the active vehicles automatically. | 02 §5.5, 03 §3.2b + §4 6d, 04 *Contracts* + *Service Catalogue*, 05 rows 07, 07b, 12 + RBAC |
| D9 | **Round-up of modules 0–3 before metering:** cross-module fixes (audit rows always attributable, tenant invitation and holder-change notifications after commit, profile corrections aligned with the active occupancy, residence channel by nationality, permission cache evicted after commit) and five missing reads / corrections for the frontend: `GET /users/{id}`, `GET /assets/room-assignments`, `PATCH /contracts/{id}/vehicles/{vehicleId}`, contract search `q`, `currentOccupancy` on the tenant profile. Doc 05 gains the frontend map (§6) | 01 §Audit, 02 §5.5.6, 04, 05 §6 |
| D4 | Shared-room rules already agreed: holder must be 18+, with an ID document and consent; deposit default `CARRY_OVER` on holder transfer; invoices issued before a transfer stay with the outgoing holder; a guardian gives consent for children. | 02 §5.4, 03 §3.2 |

---

## 2. Build Order

Each module brings its **own migration** (tables, partial indexes, CHECKs, triggers and `setup_building_rls()` from document 03), so every step can be tested on its own.

| # | Module | Scope | Tables (doc 03) | Endpoints (doc 04) | Depends on |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **0** | **Identity** | Phone sign-in, OTP, sessions, staff accounts, `PERMISSION_RULES_LOADER`, `OCCUPANCY_SELF_SCOPE` contract (default deny) | `users`, `user_roles`, `user_building_access`, `auth_sessions` (+ Redis state §3.0 I-5) | `/auth/*` (12 operations), `/users`, `/users/{id}` | supporting layer (JWT, access control, Redis, notification, audit, throttler) |
| **1** | **Properties & Assets** | Buildings, room types, 80 rooms, appliance catalogue and room assignment, vacancy summary (XFetch + tags), tenant room guard | `buildings`, `room_types`, `rooms`, `assets`, `room_assets` (+ FK `user_building_access → buildings`) | `/properties/buildings` (+`/{id}`), `/properties/room-types` (+`/{id}`), `/properties/rooms` (list, create), `/properties/rooms/vacancies/summary`, `/properties/rooms/mine`, `/properties/rooms/{id}` (detail without contract part — D3 — and update), `/assets` (+`/{id}`), `/assets/room-assignments` (+`/{id}`) — D5 | 0 |
| **1b** | **Public listing** | Anonymous read-only listing for the portfolio website; publishing fields; `@PublicCacheControl`; new Swagger portal `public`; feature flag `public_listing` | `buildings` (+ `is_publicly_listed`, `public_slug`, `public_description`), `rooms` (+ `is_publicly_listed`) | `/public/buildings`, `/public/buildings/{slug}` (+ `/room-types`, `/floors`, `/rooms`, `/rooms/{roomNumber}`, `/vacancies`, `/assets`); publishing fields on `PATCH /properties/buildings/{id}` and `PATCH /properties/rooms/{id}` | 1 |
| **2** | **Tenants** | One profile per person, encrypted ID + blind index, consent (guardian for children), lookup by CCCD, `tenants.user_id` link | `tenants` | `POST`/`GET /tenants`, `/tenants/lookup`, `/tenants/me`, `GET`/`PATCH /tenants/{id}` (D7) | 0, 1 |
| **3** | **Contracts** | Draft / activate / cancel / renew (D8), 1-month deposit ledger, occupants move in / out, residence status, holder transfer + history, vehicles, extra services + service catalogue, rented appliances; real `OCCUPANCY_SELF_SCOPE`; tenant-account provisioning when an adult with a phone moves in; room detail completed (D3) | `contracts`, `contract_occupants`, `contract_holder_transfers`, `contract_renewals`, `contract_assets`, `service_catalogs`, `contract_services`, `tenant_vehicles`, `deposit_ledgers` (+ holder-consistency triggers, immutable ledger) | `/contracts` (create, list), `/contracts/mine`, `/contracts/{id}` (+ `activate`, `cancel`, `renew`, `renewals`, `deposit-ledger`, `occupants…`, `primary-holder/…`, `vehicles…`, `services…`), `/service-catalog` (+`/{id}`) | 1, 2 |
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

### 2.6 Module 3 — notes for running it locally

* `npm run db:seed` adds the service catalogue to buildings A and B (`WIFI` per room, `SANITATION` per person, parking per vehicle type) and an active contract `HD-2026/001-P101` in building A: the dev tenant holds it (residence `REGISTERED`), their daughter lives there too (`SUBMITTED`), with one rented air conditioner, a motorbike and a 1-month deposit in the ledger. The tenant login `0901000005` therefore sees `GET /properties/rooms/mine`, `GET /contracts/mine` and a `residence` in `GET /auth/me`.
* Tenant accounts created at move-in are `PENDING_ACTIVATION`: the person activates with `POST /auth/otp/request` (`ACTIVATE_ACCOUNT`) + `POST /auth/activate`.
* The Postman folder *04 Contracts* leases one free 1BR Deluxe on floors 2–7 per run (an active contract only ends at checkout, module 5) and cancels a draft on a studio. After about 20 runs re-create the local database (`migration:revert` down to 1792610000000, then `migration:run:local` and `db:seed`).
* E2E: `test/contracts.e2e-spec.ts` (app as `app_user`, RLS enforced) and a contracts block in `test/properties-app-layer.e2e-spec.ts` (superuser, application filters only). `test/properties.e2e-spec.ts` replaces the real resolver with `overrideProvider(OCCUPANCY_SELF_SCOPE)` to test `RoomAccessGuard` alone.

### 2.5 Module 2 — notes for running it locally

* `npm run db:seed` adds three people to building A: the dev tenant (CCCD `079099001234`, linked to the `0901000005` login → `GET /tenants/me`), their 11-year-old daughter (personal ID `079315004321`, guardian = the dev tenant) and a Korean resident (passport `M12345678`).
* A valid test CCCD: 3-digit province + gender/century digit (0/1 male/female 1900s, 2/3 2000s) + 2-digit birth year + 6 digits, e.g. `079095123456` for a man born in 1995.

### 2.4 Module 1b — notes for running it locally

* `npm run db:seed` publishes building A as `sunrise-quan-7`; building B stays unpublished (`404` on the public site).
* Public routes need no token and no `X-Building-ID`: `GET /api/v1/public/buildings/sunrise-quan-7/rooms?availability=AVAILABLE`.
* Switch the public site off without a deploy: Redis hash `feature_flags` → `public_listing = {"enabled":false}` (or `FEATURE_FLAGS` in the env).
* Add the portfolio website origin to `ALLOWED_ORIGINS`.

### 2.3 Module 1 — notes for running it locally

* `npm run db:seed` creates building A (`b1000000-…-0001`, 80 rooms P.101 → P.810, 3 room types, catalogue, 10 air conditioners on floor 1) and building B (`b2000000-…-0002`, 5 rooms) before the dev accounts.
* Building-scoped endpoints need `X-Building-ID`; a landlord who registers a building calls `POST /auth/refresh` to use it.
* The Postman folder *01 Properties & Assets* registers a fresh building on every run (building A is full at 80 rooms, which the folder also checks).
* E2E: `test/properties.e2e-spec.ts` runs the app as `app_user` (RLS enforced); `test/properties-app-layer.e2e-spec.ts` runs it as superuser (RLS bypassed) to prove the application-level building filter on its own.

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
* `schema:log` does **not** compare CHECK expressions: every CHECK with a regex or literal is exercised by an e2e test that inserts a valid row and an invalid one (lesson from module 2, where a double-escaped `\+` made every phone number fail).

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
| 1 | Properties & Assets | ✅ Done (2026-10-18): 538 unit + 135 e2e tests (RLS as `app_user` + app-layer as superuser), all mutations caught, Postman 87 requests / 100 assertions — see `modules-docs/01-properties-assets.md` |
| 1b | Public listing (portfolio website) | ✅ Done (2026-10-18): 558 unit + 146 e2e tests, 13/13 mutations caught, Postman 109 requests / 129 assertions — see `modules-docs/01b-public-listing.md` |
| 2 | Tenants | ✅ Done (2026-10-18): 594 unit + 163 e2e tests, 16/16 mutations caught, Postman 131 requests / 158 assertions — see `modules-docs/02-tenants.md` |
| 3 | Contracts | ✅ Done (2026-10-18): 625 unit + 202 e2e tests, 32/32 mutations caught, Postman 169 requests / 201 assertions — see `modules-docs/03-contracts.md` |
| 0–3 | Round-up (D9) | ✅ Done (2026-10-18): 6 cross-module fixes, 5 endpoints for the frontend, doc 05 §6 frontend map; 628 unit + 214 e2e tests, Postman 175 requests / 207 assertions — see `modules-docs/03b-roundup-modules-0-3.md` |
| 4 | Metering | ⏳ Waiting for go-ahead |
| 5 | Billing | ⬜ Not started |
| 6 | Compliance VN | ⬜ Not started |
