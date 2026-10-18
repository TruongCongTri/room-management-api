# Document 05: Feature & Compliance Matrix (`05-Features-List.md`)

This document is the functional, security and statutory-compliance feature matrix of the 80-room flat rental platform. It summarises the supporting modules (`01-Supporting-Modules.md`), the domain services (`02-Core-Modules.md`), the PostgreSQL schema (`03-Database.md`) and the OpenAPI specification (`04-Swagger-API.md`). **Section 6 is the frontend map**: client conventions, every screen of the four client apps with its endpoints and build status, the values to render and the error codes to handle.

> **Shared rooms.** One room is rented under **one contract** but can be shared by **several people**. Every person — contract holder, roommates, family members, children — has their own profile, their own ID document (CCCD, a child's 12-digit personal identification number, or a passport) and their own temporary-residence declaration. Exactly **one** person is the contract holder (*người đứng tên*). When the holder moves out while others stay, the contract — and its holder CCCD — passes to the next eligible occupant.

---

## 1. Domain Features & Vietnamese Legal Anchors

### 1.0 Identity & Sign-in

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| A1 | **Sign in with phone number + password** | All roles | Law 91/2025/QH15, Decree 13/2023/NĐ-CP (security of personal data) | `POST /auth/login`. Phone normalised to E.164; argon2id passwords (10–128 chars, no phone digits, not a common password). Same `401 AUTH_CREDENTIALS_INVALID` for every failure (no account enumeration); 5 wrong passwords per number → lock 15 min doubling to 24 h |
| A2 | **OTP second factor for finance roles** | `LANDLORD`, `ACCOUNTANT` | Decree 13/2023/NĐ-CP (technical safeguards) | `202` challenge → `POST /auth/login/mfa`. 6-digit OTP, HMAC-hashed in Redis, 5 min, 5 attempts, 60 s cooldown, 20 login codes per day; SMS (Zalo first when the account is linked to Zalo) |
| A3 | **Account activation & password reset by OTP** | All roles | — | `POST /auth/otp/request` (always `202`), `POST /auth/activate`, `POST /auth/password/reset` (revokes every session) |
| A4 | **Sessions you can see and end** | All roles | — | 15-min access JWT + opaque refresh token rotated on every use; re-use of an old refresh token revokes the session and alerts the user. `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `POST /auth/logout`, `POST /auth/logout-all`; revoked tokens stop working at once (Redis denylist) |
| A5 | **Accounts follow real roles** | `LANDLORD` (staff); automatic (tenants) | Law 91/2025/QH15 (data minimisation) | Landlord creates staff accounts with roles and buildings (`POST /users`, `GET /users`, `GET /users/{id}`, `PATCH /users/{id}`). Every adult occupant with a phone gets a `TENANT` login when they move in, linked to their own profile, and an invitation SMS to activate it; children and people without a phone get none. A staff member who also rents keeps one account with both roles |
| A6 | **A tenant sees only the room they live in** | `TENANT` | Law 91/2025/QH15 (purpose limitation) | `rooms:read:own`: `GET /properties/rooms/mine`, or `/{id}` of that same room. Any other room → `403`; access ends the moment they move out (self-scope cache evicted). No room list, no vacancy data |

### 1.1 Properties & Assets

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 01 | **Room directory (80 rooms)** | `LANDLORD`, `PROPERTY_MANAGER`, `GUARD` | Housing Law 2023 (No. 27/2023/QH15) | `GET /properties/rooms`: paginated `SelectQueryBuilder` on `idx_rooms_bld_status_type` / `idx_rooms_available_covering`, 6-field projection, no sequential scans |
| 02 | **Vacancy summary by room type** | `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT` | — (operational KPI) | One `GROUP BY` query cached as `cache:{buildingId}:rooms:vacancies:summary` (single-flight + XFetch), invalidated through tag `tag:{buildingId}:rooms` on check-in, checkout and holder changes |
| 03 | **Room detail in one query** | `LANDLORD`, `PROPERTY_MANAGER`; `TENANT` (own room only, A6) | Civil Code 2015 | Room, room type, active contract, **current contract holder**, **number of people living there** and **number with registered residence**, rented appliances — one joined query (no N+1) |
| 04 | **Appliance & furniture catalogue** | `LANDLORD`, `PROPERTY_MANAGER` (tenant: own room, read) | Civil Code 2015, Art. 472–482 | `assets → room_assets → contract_assets`: serial numbers, condition grades (`GRADE_A_NEW`, `GRADE_B_GOOD`, `GRADE_C_FAIR`, `BROKEN`), replacement values, monthly rental fees. `GET/POST /assets`, `PATCH /assets/{id}`; inventory `GET /assets/room-assignments` (by room, item, serial / QR scan, condition; flags units rented under a contract), install `POST /assets/room-assignments`, re-grade / re-price / move `PATCH …/{id}`, remove `DELETE …/{id}` (soft delete); rented units cannot be moved or removed |
| 04a | **Buildings** | `LANDLORD` | Tax Administration Law 38/2019/QH14 (tax code), Decree 52/2024 (cashless payments, VietQR) | `GET/POST /properties/buildings`, `PATCH /properties/buildings/{id}`: address, landlord tax code, VietQR bank account, electricity billing mode, water rate, room capacity (default 80). The creator is granted access to the new building |
| 04b | **Room types & rooms** | `LANDLORD`, `PROPERTY_MANAGER` | Housing Law 2023 | `GET/POST /properties/room-types`, `PATCH …/{id}` (base rent; cached `catalogs:pricing`); `POST /properties/rooms` (never above the building's capacity), `PATCH /properties/rooms/{id}`: price override, type, capacity, status `AVAILABLE` / `RESERVED` / `MAINTENANCE` (`OCCUPIED` only through contracts), realtime `room.status_changed` |
| 04c | **Public listing for the portfolio website** | Anyone (prospective tenants, students) — no sign-in | Law 91/2025/QH15 (no personal data published); Consumer Protection Law 2023 (accurate price information) | `GET /public/buildings`, `…/{slug}`, `…/{slug}/room-types`, `…/{slug}/floors`, `…/{slug}/rooms` (search by type, floor, price, area, capacity, availability), `…/{slug}/rooms/{roomNumber}` (equipment and monthly fees), `…/{slug}/vacancies`, `…/{slug}/assets`. Only listed buildings / rooms; availability only `AVAILABLE` / `UNAVAILABLE`; no occupants, contracts, serials, landlord, tax or bank data. Per-building cache evicted by staff changes, `Cache-Control` + `ETag`, per-IP throttling, kill switch `public_listing` (on by default, `404` when off). Landlord publishes with `isPubliclyListed` + `publicSlug`; managers can hide single rooms |

### 1.2 People, Shared Occupancy & Contracts

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 05 | **One profile and one ID document per person** | `PROPERTY_MANAGER` | Law 91/2025/QH15, Decree 13/2023/NĐ-CP, Law on Identification 2023 | Every occupant — including children (personal identification number) and foreigners (passport) — has a `tenants` row. The ID number is encrypted with `FieldEncryptionTransformer` (AES-256-GCM, versioned keys); `id_card_hash` (HMAC-SHA256, `BLIND_INDEX_PEPPER`) gives exact, duplicate-safe lookups without decryption. One profile per building, reused when the person changes rooms. `POST /tenants`, `GET /tenants` (search by name without diacritics or phone), `GET /tenants/lookup` (blind index, audited), `GET` / `PATCH /tenants/{id}` (with `currentOccupancy`: the room and contract the person lives in now), `GET /tenants/me`. Corrections of someone living under a contract stay consistent: the active holder cannot become a minor, a nationality correction moves the stay to the right residence channel. CCCD digits checked against gender and year of birth; masked everywhere, never decrypted outside the CT01 builder |
| 06 | **Verifiable consent per person** | `TENANT`, `PROPERTY_MANAGER` | Law 91/2025/QH15; Decree 13/2023/NĐ-CP, Art. 20 (children) | `pdpl_consent_accepted_at` / `pdpl_consent_version` for everyone; for a child, consent given by a parent or guardian (`consent_guardian_tenant_id`); anonymisation after statutory retention (`pii_auto_anonymization` flag) |
| 07 | **Concurrency-safe lease activation** | `LANDLORD`, `PROPERTY_MANAGER` | Housing Law 2023, Civil Code 2015 | Lock `lock:{buildingId}:room:contract:{roomId}` + partial unique index `idx_unique_active_contract_per_room`. The holder and all planned co-occupants are moved in in the same transaction; adults with a phone get a tenant account |
| 07b | **Lease lifecycle: draft → active → renewed** | `LANDLORD`, `PROPERTY_MANAGER` (`ACCOUNTANT` 🔍) | Civil Code 2015, Art. 472–482; Housing Law 2023 | `POST /contracts` (draft, room `RESERVED`, one draft per room), `PATCH /contracts/{id}` (draft only), `POST …/activate`, `POST …/cancel`, `POST …/renew` (addendum, rent from the next term, optional deposit top-up), `GET /contracts`, `GET /contracts/{id}`, `GET /contracts/mine` (tenant), `GET …/renewals`. Contract code `HD-{YYYY}/{NNN}-{room}` per building |
| 08 | **1-month deposit escrow (*tiền đặt cọc*)** | `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT` | Civil Code 2015, Art. 328 | `depositStatus = HELD` on check-in; immutable `deposit_ledgers` (collection, deductions, checkout offset, refunds, holder-transfer movements), each row naming the person who paid or received (`counterparty_tenant_id`) |
| 09 | **Shared room: occupants move in and out** | `PROPERTY_MANAGER` | Residence Law 2020; Housing Law 2023 | `POST /contracts/{id}/occupants`, `POST …/occupants/{occupantId}/move-out`. ID document and consent required; capacity `rooms.max_occupants`; a person lives in one room at a time (`idx_occupants_tenant_one_active`). Rent and deposit are per room and do not change. A leaving occupant's vehicles are deactivated and parking subscriptions reduced |
| 10 | **Exactly one contract holder (*người đứng tên*)** | `LANDLORD`, `PROPERTY_MANAGER` | Civil Code 2015 | `idx_occupants_one_active_holder` + deferred trigger `trg_contract_primary_holder_consistency`: `contracts.primary_tenant_id` always equals the single active `PRIMARY_HOLDER` occupant (checked at commit) |
| 11 | **Contract-holder succession when the holder moves out** | `LANDLORD`, `PROPERTY_MANAGER` | Civil Code 2015, Art. 20 (capacity), Art. 370 (transfer of obligations needs the landlord's consent) | `POST /contracts/{id}/primary-holder/transfer`. Successor = the person the parties named (must be eligible), else the lowest agreed `succession_order`, else the earliest move-in. Eligible = still living there, 18+ on the effective date, ID document and consent. The contract keeps its terms; the holder CCCD changes. `contract_holder_transfers` history, addendum PDF signed by landlord, outgoing and incoming holder, deposit `CARRY_OVER` or `REFUND_AND_RECOLLECT`, outstanding balance recorded. Last occupant → checkout instead (`BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT`); only minors left → blocked (`BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED`) |
| 12 | **Vehicles & extra services** | `PROPERTY_MANAGER` | Residence Law 2020; Circular 09/2023/TT-BCT | Service catalogue per building (`/service-catalog`: per room / per person / per vehicle type). `contract_services` with agreed prices; per-person quantity = active occupants, per-vehicle quantity = active vehicles of that type (automatic). `tenant_vehicles` (owner = an active occupant; normalised plates and parking cards unique among active vehicles; bicycles without plate; corrections with `PATCH …/vehicles/{vehicleId}`), deactivated when the owner moves out |

### 1.3 Metering

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 13 | **Zero-proxy meter photo upload** | `GUARD` | Decree 13/2023/NĐ-CP, Law 91/2025/QH15 | `POST /metering/presigned-url`: 15-minute presigned `PUT` to private storage `buildings/{buildingId}/private/meter-photos/…`; no image bytes pass through the API |
| 14 | **Manual meter recording & rollover** | `GUARD`, `PROPERTY_MANAGER` | Circular 09/2023/TT-BCT | Previous reading by index backward scan (`idx_meter_room_date_desc`), `current ≥ previous` unless `isMeterReset` (approval by manager / accountant), anomaly alerts via outbox → Telegram |
| 15 | **Missing-reading checklist** | `GUARD`, `PROPERTY_MANAGER` | — (operational control) | `GET /metering/cycles/{month}/missing-rooms`: occupied rooms without photos / indices before the 28th billing run |

### 1.4 Billing & Checkout

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 16 | **EVN tiered quota vs. flat tier-3 rate** | `LANDLORD`, `ACCOUNTANT` | Circular 16/2014, 25/2018 & 09/2023/TT-BCT; Decision 1279/QĐ-BCT (prices) | Tiered quota from **occupants with REGISTERED temporary residence** (4 registered residents = 1 full household quota; recomputed, never incremented) or flat tier-3 pricing; switchable per building (`evn_tiered_quota` flag); prices in `EVN_TIER_PRICES_VND` / `evn_tariff_tiers` |
| 17 | **Month-end billing run** | `SYSTEM`, `ACCOUNTANT` | — | `@DistributedCron` 00:00 on the 28th (Vietnam time), lock `cron:billing:{buildingId}:{YYYYMM}`, one BullMQ job per room, itemised invoices **addressed to the contract holder at issue time** (`billed_to_tenant_id`), Zalo ZNS / email with VietQR |
| 18 | **VietQR & signed payment webhooks** | `TENANT`, `ACCOUNTANT`, `SYSTEM` | Decree 68/2026/NĐ-CP | HMAC-SHA256 webhook verification (`timingSafeEqual`, 300 s replay window), lock per bank transaction id against double crediting |
| 19 | **Mid-month checkout (room handover)** | `PROPERTY_MANAGER`, `ACCOUNTANT` | Civil Code 2015 (fair settlement) | When the **last** occupant leaves: exact inclusive days $D$ of $M$ with `decimal.js`, prorating rent, appliances and fixed services; settled with the contract holder |
| 20 | **Checkout deposit settlement** | `PROPERTY_MANAGER`, `ACCOUNTANT` | Civil Code 2015, Art. 328 | `@Idempotent()` + contract lock: prorated charges + final utilities + damages + arrears − deposit → refund or balance due; every remaining occupant moved out with residence deregistration pending |

### 1.5 Compliance

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 21 | **Statutory PDFs** | `LANDLORD`, `PROPERTY_MANAGER`, `TENANT` | Housing Law 2023, Civil Code 2015, Fire Safety Law 2024 | `PdfGeneratorService` (pdfkit, Vietnamese administrative layout, Unicode font): lease contract, handover minutes, checkout settlement, **contract-holder transfer addendum**, CT01 — stored privately, served by presigned URL |
| 22 | **2026 rental tax engine** | `LANDLORD`, `ACCOUNTANT` | Law 109/2025/QH15, Law 149/2025/QH15, Decree 68/2026 & 141/2026/NĐ-CP, Resolution 198/2025/QH15 | 1,000,000,000 VND/year exemption; licence fee 0; pass-through utilities excluded; 5 % VAT on taxable revenue; 5 % PIT only on the part above 1 B (`statutory_tax_rules`, pre-2026 rule kept for historical periods) |
| 23 | **Streaming tax export (01/BĐS, 01/BK-BĐS)** | `LANDLORD`, `ACCOUNTANT` | Circular 18/2026/TT-BTC, Circular 89/2026/TT-BTC | ExcelJS streaming writer, flat memory; legacy `01/TTS` supported; lessee per period from `billed_to_tenant_id` |
| 24 | **E-invoice gateway** | `ACCOUNTANT`, `SYSTEM` | Decree 70/2025/NĐ-CP, Decree 68/2026/NĐ-CP | VNPT / Viettel / MISA through `@Resilient('e-invoice-gateway')` (bulkhead 20, circuit breaker); buyer = holder at issue time |
| 25 | **Temporary residence for every occupant** | `LANDLORD`, `PROPERTY_MANAGER`, `TENANT` (own) | Residence Law 2020 (Art. 26, 27); Circular 66/2023/TT-BCA; Law 47/2014/QH13 (foreigners) | Per person: `PENDING_DECLARATION → SUBMITTED → REGISTERED` on move-in, `DEREGISTRATION_PENDING → DEREGISTERED` on move-out, household-head change after a holder transfer, term up to 2 years with renewal reminders. One CT01 PDF per occupant (`GET /compliance-vn/occupants/{occupantId}/ct01-pdf`); foreigners via the foreigner declaration channel; daily work queue (`GET /compliance-vn/residency/pending`, Telegram `RESIDENCE_ACTIONS_PENDING`) and batch export for Ward Police / VNeID |
| 26 | **Fire safety (PCCC) & compulsory insurance** | `LANDLORD`, `PROPERTY_MANAGER` | Fire Safety Law 2024, Decree 105/2025/NĐ-CP, Decree 69/2026/NĐ-CP, QCVN 10:2025/BCA | `pccc_compliance_logs`: compulsory fire & explosion insurance, alarm inspections, extinguisher expiry; daily 02:00 expiry check |

---

## 2. Supporting Capabilities (document 01)

| Group | Modules | Capability |
| :-- | :-- | :-- |
| 1. Lifecycle & context | `AppConfigModule`, `RequestContextModule`, `GracefulShutdownModule` | Fail-fast zod validation with a DevOps error table and `DATABASE_*` aliases; native `AsyncLocalStorage` context (trace, user, verified building); 5-phase shutdown `DRAIN_TRAFFIC → PAUSE_CONSUMERS → DRAIN_HTTP → FLUSH_BUFFERS → RELEASE_POOLS` with a watchdog |
| 2. Observability | `HealthModule`, `LoggerModule`, `MetricsModule`, `TracingModule`, `AuditLogModule` | Liveness vs. readiness (database, Redis, object storage, `503` while shutting down); NDJSON logs with CCCD / passport / bank redaction; OpenTelemetry → Prometheus with route normalisation and business counters; OTLP tracing; WORM audit with field diffs and 90-day archival |
| 3. Security & access | `AccessControlModule`, security headers, encryption, `ThrottlerModule`, `IdempotencyModule`, building isolation | `<resource>:<action>:<scope>` CASL matrix (DEPARTMENT = building) seeded and synchronised; Helmet + CORS whitelist; AES-256-GCM + blind index; per-user rate limits (60 / 100 / 5 per minute); two-phase idempotency (`400 / 409 / 422`); `X-Building-ID` + PostgreSQL RLS (`SET LOCAL app.current_building_id`), verified with a least-privilege role |
| 4. Data & concurrency | `DatabaseModule`, migrations & seeds, `CacheModule`, `DistributedLockModule`, `OutboxModule` | Master / replica pools, snake-case naming, optimistic locking; versioned migrations + idempotent reference seeds; Redis + LRU cache with single-flight, XFetch and tag `UNLINK`; fenced Redis locks with watchdog (occupancy changes share the checkout lock); transactional outbox with `FOR UPDATE SKIP LOCKED`, retries, dead letters and lease recovery |
| 5. Integration | `ResilienceModule`, `HttpClientModule`, `WebhookModule` | Per-partner bulkhead + circuit breaker + jittered retry; outbound HTTP with mTLS and trace headers; HMAC webhooks with replay protection |
| 6. Async & realtime | `QueueModule`, `ScheduleModule`, `NotificationModule`, `DomainEventModule`, `WebSocketModule` | BullMQ envelopes with context restore and DLQ; distributed crons in Vietnam time; Zalo ZNS / email / SMS / Telegram with `Promise.allSettled` and PII masking (incl. holder-change and residence alerts); domain events incl. `occupant.*`, `contract.primary_holder_changed`, `residence.*`; Socket.IO rooms per building |
| 7. Storage & documents | `StorageModule`, `DocumentReportModule` | Presigned PUT / GET, `buildings/{buildingId}/…` keys, type whitelist, one ID scan per occupant; pdfkit statutory PDFs (incl. CT01 per occupant and holder-transfer addendum); streaming Excel |
| 8. API governance | `SwaggerModule`, `VersioningModule`, `I18nModule`, `FeatureFlagModule` | Portals `/api/docs/admin`, `/guard`, `/external`; URI versioning with Deprecation / Sunset; vi / en / ja / ko messages for every error code; Redis-backed runtime flags |

---

## 3. Role-Based & Attribute-Based Access Matrix

Every endpoint passes `JwtAuthGuard → CustomThrottlerGuard → RolesGuard → PermissionsGuard`. Defaults come from `DEFAULT_ROLE_PERMISSIONS` (seeded into `role_permissions`). ✅ = full for the scope shown, 🔍 = read only, ❌ = none. `DEPARTMENT` = the active building; `OWN` = the caller's own records.

| Resource / action | Permission | `LANDLORD` | `PROPERTY_MANAGER` | `ACCOUNTANT` | `GUARD` | `TENANT` |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **Public listing (`/public/*`)** | none — anonymous, read-only, published data only | ✅ | ✅ | ✅ | ✅ | ✅ (and anyone without an account) |
| Publish a building on the portfolio site | `buildings:update:global` | ✅ GLOBAL | ❌ | ❌ | ❌ | ❌ |
| Hide / show a room on the portfolio site | `rooms:update:department` | ✅ GLOBAL | ✅ | ❌ | ❌ | ❌ |
| Building & tax settings | `buildings:manage:global` | ✅ GLOBAL | ❌ | ❌ | ❌ | ❌ |
| Own sign-in, password & sessions | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Staff accounts, roles & building access** | `users:manage:global` | ✅ GLOBAL | ❌ | ❌ | ❌ | ❌ |
| Room directory & vacancy | `rooms:read:department` | ✅ GLOBAL | ✅ | 🔍 | 🔍 | ❌ |
| **Room detail of the room they live in** | `rooms:read:own` | ✅ GLOBAL | ✅ | 🔍 | 🔍 | 🔍 OWN room only, while living there |
| Rooms & room types (create, price, status) | `rooms:create/update:department` | ✅ GLOBAL | ✅ | ❌ | ❌ | ❌ |
| Appliance catalogue & installed units | `assets:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN room (in room detail) |
| Person profiles & encrypted CCCD | `tenants:manage:department` / `tenants:read:own` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN profile |
| Lease draft, activation, cancellation & renewal | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN contract (`/contracts/mine`) |
| Service catalogue, contract services & vehicles | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | ❌ |
| Deposit ledger | `deposits:read:department` | ✅ GLOBAL | 🔍 | 🔍 | ❌ | ❌ |
| **Occupant move-in / move-out** | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN occupancy |
| **Contract-holder transfer** | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 history | ❌ | 🔍 OWN contract (`/contracts/mine` shows the current holder; the transfer history is staff-only for now) |
| Meter photo presigned URL | `meters:upload:department` | ✅ GLOBAL | ✅ | ❌ | ✅ | ❌ |
| Meter reading submission | `meters:create:department` | ✅ GLOBAL | ✅ | 🔍 | ✅ | 🔍 OWN room |
| Meter reset approval | `meters:approve:department` | ✅ GLOBAL | ✅ | ✅ | ❌ | ❌ |
| Invoices & payments | `invoices:manage:department` | ✅ GLOBAL | 🔍 | ✅ | ❌ | 🔍 OWN (billed to them) |
| Checkout & deposit settlement | `settlements:execute:department` | ✅ GLOBAL | ✅ | ✅ | ❌ | 🔍 OWN statement |
| Tax export & e-invoice | `tax:export:department` | ✅ GLOBAL | ❌ | ✅ | ❌ | ❌ |
| **Residence (CT01) per occupant** & PCCC | `compliance:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN CT01 |
| WORM audit log | `audit:read:*` | ✅ GLOBAL | ✅ | ✅ | 🔍 OWN actions | 🔍 OWN actions |

A tenant user is linked to their own person profile (`tenants.user_id`), so `OWN` covers their profile, their occupancy, the room and contract they currently live under, and the invoices addressed to them. Room access is derived from the **active** occupancy, so it ends at move-out; their past invoices and settlement stay readable.

---

## 4. The 4 Performance Mandates

| Mandate | Requirement | Implementation | Target |
| :-- | :-- | :-- | :-- |
| 1. Index optimisation | No sequential scans on growing tables | `idx_rooms_available_covering` (partial covering), `idx_rooms_bld_status_type`, `idx_rooms_bld_floor_status`, `idx_meter_room_date_desc` (backward scan), `idx_tenants_bld_id_hash_unique` (blind index), `idx_occupants_contract_status`, `idx_occupants_one_active_holder`, `idx_occupants_tenant_one_active`, `idx_occupants_residence_pending` (partial), `idx_outbox_poll_pending` | Index / index-only scans, `< 2 ms` |
| 2. Zero N+1 | Joins or batches, never per-row loops | `listRooms()` single join with `COALESCE(r.price_override, rt.base_monthly_rent)`; `getRoomDetail()` single query incl. active occupants and holder; billing batches `WHERE contract_id IN (…)` across 80 rooms | 1 round trip per endpoint |
| 3. Payload optimisation | Project only needed fields | Explicit `.select([...])`; `RoomListItemDto` 6 scalars (~180 bytes / room); ID numbers only masked in responses; photos, contracts and tax files via presigned URLs / streams | `< 15 KB` for 80 rooms; 0 MB image buffering |
| 4. Multi-tier caching | Cache low-churn data | Vacancy summary (single-flight + XFetch), flattened permissions `permissions:user:{userId}`, tag eviction `tag:{buildingId}:rooms` on activation, checkout and holder transfer | `< 1.5 ms` cache hit, no stampede |

---

## 5. End-to-End Flow

```
+------------------------------------------------------------------------------------------------+
| 1. BOOTSTRAP & SECURITY (doc 01)                                                               |
|  zod config -> migrations Job (RLS, WORM, occupancy constraints) -> reference seeds             |
|  Helmet -> CORS -> JwtAuthGuard -> Throttler -> Permissions -> X-Building-ID -> RlsService       |
|  Sign-in: phone + password (+ OTP for LANDLORD / ACCOUNTANT) -> 15-min JWT + rotating refresh  |
|  Portfolio site: anonymous /public/* (published rooms, floors, vacancies, equipment) -> sign-in    |
|    for the management area                                                                     |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 2. ONBOARDING A SHARED ROOM (docs 02 & 03)                                                     |
|  TenantsService: one profile per person (holder, roommates, children), CCCD / personal ID /      |
|  passport encrypted + id_card_hash blind index, consent (guardian for children)                 |
|  ContractsService: room lock + partial unique index; holder = PRIMARY_HOLDER, others CO_OCCUPANT |
|  1-month deposit HELD in deposit_ledgers                                                        |
|  Each adult occupant with a phone: TENANT login (PENDING_ACTIVATION -> OTP activation)         |
|  Each occupant: residence PENDING_DECLARATION -> CT01 PDF (or foreigner declaration)             |
|  Outbox -> BullMQ -> lease, handover, CT01 PDFs (pdfkit)                                        |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 3. LIFE IN THE ROOM                                                                            |
|  Guard: missing-rooms checklist -> presigned PUT photos -> POST /metering/records (idempotent)   |
|  Co-occupant moves in / out: capacity, one room per person, residence declare / deregister      |
|  Residence REGISTERED -> EVN quota headcount recomputed                                         |
|  Holder moves out, others stay -> successor (named, succession order, earliest move-in;          |
|    adult + ID + consent) -> primary_tenant_id & holder CCCD change -> addendum, deposit handling |
+------------------------------------------------------------------------------------------------+
                       │                                                   │
+-----------------------------------------------+ +-------------------------------------------------+
| 4A. MONTH-END BILLING (28th, 00:00 VN time)   | | 4B. ROOM HANDOVER (last occupant leaves)        |
| • Distributed cron lock per building & month  | | • Final reading (isFinalCheckoutReading)        |
| • EVN tiered quota (registered residents)     | | • Exact days D / M (decimal.js)                 |
|   or flat tier-3 + water                      | | • Prorate rent + appliances + services          |
| • Rent + appliances + services                | | • + utilities + damages + arrears − deposit     |
| • Invoice billed to the current holder +      | | • Settled with the holder; all occupants moved  |
|   VietQR, Zalo ZNS / email                    | |   out, residence deregistration for each        |
+-----------------------------------------------+ +-------------------------------------------------+
                       │                                                   │
+------------------------------------------------------------------------------------------------+
| 5. 2026 TAX, RESIDENCE, PCCC & AUDIT                                                           |
|  Tax: 1 B VND threshold, 5 % VAT + 5 % PIT on the excess, 01/BĐS & 01/BK-BĐS streaming, e-invoice |
|  Residence: daily queue of declarations / deregistrations, VNeID / Ward Police batch export      |
|  PCCC insurance & equipment expiry; WORM audit with 90-day archival                             |
+------------------------------------------------------------------------------------------------+
```

---

## 6. Frontend Map (for the client apps)

### 6.1 Conventions every client follows

| Topic | Rule |
| :-- | :-- |
| Base & headers | `/api/v1`. `Authorization: Bearer <access token>`; `X-Building-ID: <uuid>` on every building-scoped route (all except `/auth/*`, `/users*`, `/public/*`); `Idempotency-Key: <uuid>` on routes marked ⚑ below — generate one per user action and **reuse it on retry** (same key + same body → same response; same key + other body → `422 REQ_IDEMPOTENCY_PAYLOAD_MISMATCH`). `Accept-Language: vi` (default) / `en` / `ja` / `ko` (or `?lang=`) selects the language of `message` |
| Success envelope | `{ success: true, statusCode, data, meta: { traceId, timestamp, durationMs, pagination? } }`; lists carry `meta.pagination { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage }` (`page` from 1, `limit` ≤ 100) |
| Error envelope | `{ success: false, statusCode, errorCode, message, details?, traceId, timestamp, path }` (plus RFC 7807 `type`, `title`, `instance`). Switch on **`errorCode`** (stable), show `message` (localised), map `details[].field` to form fields (`details[].message` or `issue` explains). Quote `traceId` in support tickets |
| Sign-in | `POST /auth/login` → `200` tokens, or `202 { mfaRequired, challengeId, otpSentTo }` → `POST /auth/login/mfa` (landlord, accountant). Access token 15 min; `POST /auth/refresh` returns a **new** refresh token every time — always store the latest. `401 AUTH_TOKEN_EXPIRED` → refresh once and retry; `AUTH_SESSION_REVOKED` / `AUTH_REFRESH_TOKEN_REUSED` → sign out. After a landlord creates a building, refresh to receive it in the token. Building switcher = the `buildingIds` of `GET /auth/me` |
| Optimistic locking | Editable records return `version`; send it back on `PATCH` → `409 RES_CONCURRENCY_CONFLICT` means "changed by someone else, reload". `409 RES_LOCKED` = another operation on the same room / contract is running: retry in a moment |
| Rate limits | `429` with `Retry-After` (seconds): show a countdown. OTP resend after 60 s; 5 activation / reset codes per number per day |
| Values | Money = **integer VND**; dates `YYYY-MM-DD` (Vietnam calendar); timestamps ISO-8601 UTC; ids UUID; ID numbers are always masked (`********1234`) — the API never returns full CCCD / passport / bank numbers |
| Public site | No token, no building header; `ETag` + `If-None-Match` → `304`; `404 RES_FEATURE_DISABLED` when the site is switched off |

### 6.2 Screens and endpoints

Status: ✅ built and tested · ⏳ module 4 (metering) · ⏳5 module 5 (billing & checkout) · ⏳6 module 6 (compliance VN). ⚑ = send `Idempotency-Key`.

**Admin web (landlord, property manager, accountant)**

| Screen | Endpoints | Who (doc 05 §3) | Notes | Status |
| :-- | :-- | :-- | :-- | :-- |
| Sign-in, MFA, forgot password | `POST /auth/login`, `/auth/login/mfa`, `/auth/otp/request` (`RESET_PASSWORD`), `/auth/password/reset` | all | Lock `423 AUTH_ACCOUNT_LOCKED` + `Retry-After` | ✅ |
| My account & devices | `GET /auth/me`, `POST /auth/password/change`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `POST /auth/logout`, `/auth/logout-all` | all | `me.permissions` drives menu visibility | ✅ |
| Staff & tenant accounts | `GET /users?role=&status=&buildingId=`, `GET /users/{id}`, ⚑`POST /users`, `PATCH /users/{id}` | landlord | Tenant accounts: status only (enable / disable) | ✅ |
| Buildings & publishing | `GET /properties/buildings`, ⚑`POST`, `PATCH /properties/buildings/{id}` | landlord | `isPubliclyListed` + `publicSlug` publish the portfolio site | ✅ |
| Dashboard | `GET /properties/rooms/vacancies/summary`, `GET /contracts?status=ACTIVE&endingBefore=` (renewals due) | landlord, manager, accountant | Realtime `room.status_changed` over WebSocket when enabled | ✅ |
| Room types | `GET /properties/room-types`, ⚑`POST`, `PATCH …/{id}` | landlord, manager | | ✅ |
| Room directory & detail | `GET /properties/rooms?status=&roomTypeId=&floor=&sortBy=`, ⚑`POST`, `GET` / `PATCH /properties/rooms/{id}` | landlord, manager (accountant, guard read) | Detail = type, equipment, `activeContract` (holder, occupants, deposit held). Status `OCCUPIED` is never set by hand; locked while a draft holds the room | ✅ |
| Equipment catalogue & inventory | `GET /assets`, ⚑`POST /assets`, `PATCH /assets/{id}`, `GET /assets/room-assignments?roomId=&assetId=&serialNumber=&conditionGrade=`, ⚑`POST /assets/room-assignments`, `PATCH` / `DELETE …/{id}` | landlord, manager (accountant read) | Disable move / remove when `rentedUnderContractId` is set | ✅ |
| People | `GET /tenants?q=&minor=`, `GET /tenants/lookup?idCardNumber=`, ⚑`POST /tenants`, `GET` / `PATCH /tenants/{id}` | landlord, manager (accountant read) | Duplicate ID → `409` with the existing `tenantId` (offer "open profile"); `currentOccupancy` shows where they live | ✅ |
| Service catalogue | `GET /service-catalog`, `POST`, `PATCH` / `DELETE /service-catalog/{id}` | landlord, manager (accountant read) | Per-vehicle items need a vehicle type | ✅ |
| Contracts list | `GET /contracts?status=&roomId=&tenantId=&q=&endingBefore=` | landlord, manager, accountant | `q` = part of the code or room number | ✅ |
| New lease (draft) | ⚑`POST /contracts`, `PATCH /contracts/{id}`, `POST …/cancel` | landlord, manager | Pick room (`AVAILABLE` / `RESERVED`), holder + planned people from People, rented units from the room's inventory | ✅ |
| Activate lease | ⚑`POST /contracts/{id}/activate` | landlord, manager | Needs the signed PCCC commitment; on `409 BIZ_OCCUPANT_ALREADY_ACTIVE` show `details[].tenantId` | ✅ |
| Contract detail | `GET /contracts/{id}`, `/occupants?status=`, `/deposit-ledger`, `/renewals`, `/primary-holder/history`, `/vehicles?status=`, `/services` | landlord, manager, accountant (ledger: + deposits) | Tabs: terms, people & residence, deposit, vehicles, services, history | ✅ |
| Renew | ⚑`POST /contracts/{id}/renew` | landlord, manager | New rent applies from the day after the current end | ✅ |
| Move in / move out | ⚑`POST /contracts/{id}/occupants`, ⚑`POST …/occupants/{occupantId}/move-out` | landlord, manager | Holder → use "Transfer contract" | ✅ |
| Transfer contract holder | ⚑`POST /contracts/{id}/primary-holder/transfer` | landlord, manager | Show eligible successors (adults living there); last occupant → checkout (⏳5) | ✅ |
| Residence per person | `PATCH /contracts/{id}/occupants/{occupantId}/residency` | landlord, manager | Offer only the next step (`details.allowed` on error) | ✅ |
| Vehicles & services | ⚑`POST …/vehicles`, `PATCH …/vehicles/{vehicleId}`, `POST …/vehicles/{vehicleId}/deactivate`, ⚑`POST …/services`, `PATCH` / `DELETE …/services/{subscriptionId}` | landlord, manager | Quantity editable only when `quantitySource = MANUAL` | ✅ |
| Audit log | `GET /audit-logs` | landlord, manager, accountant (guard / tenant: own actions) | | ✅ |
| Meter readings & missing rooms | `/metering/presigned-url`, `/metering/records`, `/metering/cycles/{month}/missing-rooms` | manager, accountant (approve resets) | | ⏳ |
| Invoices, payments, checkout | `/billing/checkout/execute`, `/webhooks/payments/vietqr`, invoices | accountant, landlord | | ⏳5 |
| Documents, residence queue, tax, PCCC | `/compliance-vn/*` | landlord, manager, accountant | Lease / handover / settlement / addendum PDFs, CT01 per person, 01/BĐS export | ⏳6 |

**Guard app**

| Screen | Endpoints | Notes | Status |
| :-- | :-- | :-- | :-- |
| Sign-in | `POST /auth/login`, `GET /auth/me` | | ✅ |
| Rooms | `GET /properties/rooms`, `GET /properties/rooms/{id}` | Read only | ✅ |
| Meter photo round | `GET /metering/cycles/{month}/missing-rooms`, `POST /metering/presigned-url`, ⚑`POST /metering/records` | | ⏳ |

**Tenant app**

| Screen | Endpoints | Notes | Status |
| :-- | :-- | :-- | :-- |
| Activate account (from the invitation SMS) | `POST /auth/otp/request` (`ACTIVATE_ACCOUNT`), `POST /auth/activate` | Password policy errors in `details[].issue` | ✅ |
| Sign-in, forgot password, devices | `/auth/login`, `/auth/otp/request` (`RESET_PASSWORD`), `/auth/password/reset`, `/auth/sessions` | | ✅ |
| Home | `GET /auth/me` (`residence`: room, contract, role) | `residence = null` → "you are not living in a room of this building" | ✅ |
| My room | `GET /properties/rooms/mine` | Equipment, holder, people count, deposit held; `404 BIZ_NO_ACTIVE_ROOM` after moving out | ✅ |
| My contract | `GET /contracts/mine` | Terms, rented appliances, services; no ID numbers of others | ✅ |
| My profile | `GET /tenants/me` | Masked ID, consent, current occupancy | ✅ |
| Invoices & payment (VietQR) | invoices billed to me | | ⏳5 |
| My CT01 / residence | | | ⏳6 |

**Public portfolio website (no sign-in)**

| Screen | Endpoints | Status |
| :-- | :-- | :-- |
| Buildings | `GET /public/buildings` | ✅ |
| Building page | `GET /public/buildings/{slug}`, `…/room-types`, `…/floors`, `…/vacancies`, `…/assets` | ✅ |
| Room search & room page | `GET /public/buildings/{slug}/rooms?…`, `…/rooms/{roomNumber}` | ✅ |
| "Manage" button | links to the admin web sign-in | ✅ |

### 6.3 Values to render

| Field | Values | Display hint |
| :-- | :-- | :-- |
| Room `status` | `AVAILABLE`, `RESERVED` (draft lease or held by hand), `OCCUPIED` (active contract), `MAINTENANCE` | Public site shows only `AVAILABLE` / `UNAVAILABLE` |
| Contract `status` | `DRAFT`, `ACTIVE`, `CANCELLED` (draft never started), `TERMINATED`, `EXPIRED` (⏳5) | |
| `depositStatus` | `PENDING_COLLECTION` (draft), `HELD`, `PARTIALLY_REFUNDED`, `FULLY_REFUNDED`, `FORFEITED` | `depositBalance` = current balance |
| Ledger `transactionType` | `INITIAL_COLLECTION`, `TOP_UP`, `HOLDER_TRANSFER_CARRY_OVER` (0 VND, deposit now owed to the successor), `HOLDER_TRANSFER_REFUND`, `HOLDER_TRANSFER_COLLECTION`, `CHECKOUT_DEDUCTION`, `SURPLUS_REFUND`, `FORFEITURE` | `amount` signed (+ in, − out) |
| Occupant `role` / `status` | `PRIMARY_HOLDER` (người đứng tên), `CO_OCCUPANT` / `ACTIVE`, `MOVED_OUT` | Holder listed first |
| `residencyStatus` | `PENDING_DECLARATION` → `SUBMITTED` → `REGISTERED`; after moving out `DEREGISTRATION_PENDING` → `DEREGISTERED` | Only `REGISTERED` counts for the EVN quota |
| `residenceChannel` | `CT01` (Vietnamese), `FOREIGNER_TEMPORARY_RESIDENCE` | |
| Service `chargeUnit` / `quantitySource` | `PER_ROOM_MONTH` / `MANUAL`, `PER_PERSON_MONTH` / `OCCUPANTS`, `PER_VEHICLE_MONTH` / `VEHICLES` | |
| `vehicleType` | `MOTORBIKE`, `ELECTRIC_BIKE`, `BICYCLE` (no plate), `CAR` | |
| `conditionGrade` | `GRADE_A_NEW`, `GRADE_B_GOOD`, `GRADE_C_FAIR`, `BROKEN` (cannot be rented) | |
| User `status` | `PENDING_ACTIVATION`, `ACTIVE`, `DISABLED` | |

### 6.4 Error codes the screens handle

| `errorCode` | HTTP | When | Suggested UI |
| :-- | :-- | :-- | :-- |
| `REQ_VALIDATION_ERROR` | 400 | Field rules (`details[].field`) | Inline field errors |
| `REQ_MISSING_IDEMPOTENCY_KEY` / `REQ_IDEMPOTENCY_PAYLOAD_MISMATCH` | 400 / 422 | ⚑ route without key / key reused with other data | Client bug — new key per action |
| `AUTH_CREDENTIALS_INVALID`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_DISABLED` | 401 / 423 / 403 | Sign-in | Generic message; countdown from `Retry-After` |
| `AUTH_OTP_INVALID` / `AUTH_OTP_EXPIRED` / `AUTH_OTP_TOO_MANY_ATTEMPTS` / `AUTH_OTP_RATE_LIMITED` | 400 / 400 / 429 / 429 | OTP steps | `details[].attemptsRemaining`; resend countdown |
| `AUTH_PASSWORD_POLICY_VIOLATION` | 422 | New password | List `details[].issue` |
| `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_REVOKED` / `AUTH_REFRESH_TOKEN_REUSED` | 401 | Any call | Refresh once / sign out |
| `AUTH_FORBIDDEN_RESOURCE`, `AUTH_TENANT_MISMATCH` | 403 | No permission / building not in token | Hide the action; refresh token after building changes |
| `RES_NOT_FOUND` | 404 | Record of another building or deleted | "Not found" page |
| `RES_ALREADY_EXISTS` | 409 | Codes, room numbers, serials, plates, parking cards, subscriptions | Highlight `details[].field` |
| `RES_CONCURRENCY_CONFLICT`, `RES_LOCKED` | 409 | Stale `version` / operation in progress | Reload / retry |
| `BIZ_ROOM_NOT_AVAILABLE`, `BIZ_ROOM_HAS_ACTIVE_CONTRACT` | 409 | New draft / activation | Show the room status (`details[].status`, `issue: DRAFT_EXISTS`) |
| `BIZ_ROOM_STATUS_TRANSITION_INVALID` | 409 | Status by hand on an occupied / draft-held room | Explain "changes through the contract" |
| `BIZ_BUILDING_CAPACITY_EXCEEDED`, `BIZ_OCCUPANT_LIMIT_EXCEEDED` | 409 | Room count / people per room | Show the limit from `details` |
| `BIZ_TENANT_ID_CARD_DUPLICATE` | 409 | Same ID twice | Link to `details[].tenantId` |
| `BIZ_PDPL_CONSENT_REQUIRED`, `BIZ_TENANT_GUARDIAN_INVALID` | 422 | Consent / child's guardian | Consent checkbox, guardian picker |
| `BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE` | 422 | Holder under 18 / no ID / no consent (`details[].issue`) | Explain per reason |
| `BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED`, `BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT`, `BIZ_PRIMARY_HOLDER_USE_TRANSFER` | 409 | Holder leaving | Register an adult / go to checkout (⏳5) / open the transfer dialog |
| `BIZ_OCCUPANT_ALREADY_ACTIVE`, `BIZ_OCCUPANT_NOT_ACTIVE` | 409 | Person in another room / already moved out | Name the person (`details[].tenantId`) |
| `BIZ_CONTRACT_NOT_DRAFT`, `BIZ_CONTRACT_NOT_ACTIVE` | 409 | Action not allowed in this contract status | Refresh the contract |
| `BIZ_PCCC_COMMITMENT_REQUIRED` | 422 | Activation | Tick "PCCC commitment signed" on the draft |
| `BIZ_RESIDENCY_TRANSITION_INVALID` | 409 | Residence step out of order | Offer `details[].allowed` |
| `BIZ_SERVICE_QUANTITY_DERIVED`, `BIZ_SERVICE_IN_USE` | 409 | Typed quantity of an automatic service / catalogue item used by contracts | Make the field read-only |
| `BIZ_ASSET_UNDER_CONTRACT` | 409 | Move / remove a rented unit | Disable when `rentedUnderContractId` is set |
| `BIZ_NO_ACTIVE_ROOM` | 404 | Tenant not living in this building | Empty state |
| `RES_FEATURE_DISABLED` | 404 | Public site switched off | Maintenance page |
