# Document 05: Feature & Compliance Matrix (`05-Features-List.md`)

This document is the functional, security and statutory-compliance feature matrix of the 80-room flat rental platform. It summarises the supporting modules (`01-Supporting-Modules.md`), the domain services (`02-Core-Modules.md`), the PostgreSQL schema (`03-Database.md`) and the OpenAPI specification (`04-Swagger-API.md`).

> **Shared rooms.** One room is rented under **one contract** but can be shared by **several people**. Every person — contract holder, roommates, family members, children — has their own profile, their own ID document (CCCD, a child's 12-digit personal identification number, or a passport) and their own temporary-residence declaration. Exactly **one** person is the contract holder (*người đứng tên*). When the holder moves out while others stay, the contract — and its holder CCCD — passes to the next eligible occupant.

---

## 1. Domain Features & Vietnamese Legal Anchors

### 1.1 Properties & Assets

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 01 | **Room directory (80 rooms)** | `LANDLORD`, `PROPERTY_MANAGER`, `GUARD` | Housing Law 2023 (No. 27/2023/QH15) | `GET /properties/rooms`: paginated `SelectQueryBuilder` on `idx_rooms_bld_status_type` / `idx_rooms_available_covering`, 6-field projection, no sequential scans |
| 02 | **Vacancy summary by room type** | `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT` | — (operational KPI) | One `GROUP BY` query cached as `cache:{buildingId}:rooms:vacancies:summary` (single-flight + XFetch), invalidated through tag `tag:{buildingId}:rooms` on check-in, checkout and holder changes |
| 03 | **Room detail in one query** | `LANDLORD`, `PROPERTY_MANAGER` | Civil Code 2015 | Room, room type, active contract, **current contract holder**, **number of people living there** and **number with registered residence**, rented appliances — one joined query (no N+1) |
| 04 | **Appliance & furniture catalogue** | `LANDLORD`, `PROPERTY_MANAGER` (tenant: own room, read) | Civil Code 2015, Art. 472–482 | `assets → room_assets → contract_assets`: serial numbers, condition grades (`GRADE_A_NEW`, `GRADE_B_GOOD`, `GRADE_C_FAIR`), replacement values, monthly rental fees |

### 1.2 People, Shared Occupancy & Contracts

| # | Feature | Roles | Legal anchor | Implementation |
| :-- | :-- | :-- | :-- | :-- |
| 05 | **One profile and one ID document per person** | `PROPERTY_MANAGER` | Law 91/2025/QH15, Decree 13/2023/NĐ-CP, Law on Identification 2023 | Every occupant — including children (personal identification number) and foreigners (passport) — has a `tenants` row. The ID number is encrypted with `FieldEncryptionTransformer` (AES-256-GCM, versioned keys); `id_card_hash` (HMAC-SHA256, `BLIND_INDEX_PEPPER`) gives exact, duplicate-safe lookups without decryption. One profile per building, reused when the person changes rooms |
| 06 | **Verifiable consent per person** | `TENANT`, `PROPERTY_MANAGER` | Law 91/2025/QH15; Decree 13/2023/NĐ-CP, Art. 20 (children) | `pdpl_consent_accepted_at` / `pdpl_consent_version` for everyone; for a child, consent given by a parent or guardian (`consent_guardian_tenant_id`); anonymisation after statutory retention (`pii_auto_anonymization` flag) |
| 07 | **Concurrency-safe lease activation** | `LANDLORD`, `PROPERTY_MANAGER` | Housing Law 2023, Civil Code 2015 | Lock `lock:{buildingId}:room:contract:{roomId}` + partial unique index `idx_unique_active_contract_per_room`. The holder and all initial co-occupants are registered in the same transaction |
| 08 | **1-month deposit escrow (*tiền đặt cọc*)** | `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT` | Civil Code 2015, Art. 328 | `depositStatus = HELD` on check-in; immutable `deposit_ledgers` (collection, deductions, checkout offset, refunds, holder-transfer movements), each row naming the person who paid or received (`counterparty_tenant_id`) |
| 09 | **Shared room: occupants move in and out** | `PROPERTY_MANAGER` | Residence Law 2020; Housing Law 2023 | `POST /contracts/{id}/occupants`, `POST …/occupants/{occupantId}/move-out`. ID document and consent required; capacity `rooms.max_occupants`; a person lives in one room at a time (`idx_occupants_tenant_one_active`). Rent and deposit are per room and do not change. A leaving occupant's vehicles are deactivated and parking subscriptions reduced |
| 10 | **Exactly one contract holder (*người đứng tên*)** | `LANDLORD`, `PROPERTY_MANAGER` | Civil Code 2015 | `idx_occupants_one_active_holder` + deferred trigger `trg_contract_primary_holder_consistency`: `contracts.primary_tenant_id` always equals the single active `PRIMARY_HOLDER` occupant (checked at commit) |
| 11 | **Contract-holder succession when the holder moves out** | `LANDLORD`, `PROPERTY_MANAGER` | Civil Code 2015, Art. 20 (capacity), Art. 370 (transfer of obligations needs the landlord's consent) | `POST /contracts/{id}/primary-holder/transfer`. Successor = the person the parties named (must be eligible), else the lowest agreed `succession_order`, else the earliest move-in. Eligible = still living there, 18+ on the effective date, ID document and consent. The contract keeps its terms; the holder CCCD changes. `contract_holder_transfers` history, addendum PDF signed by landlord, outgoing and incoming holder, deposit `CARRY_OVER` or `REFUND_AND_RECOLLECT`, outstanding balance recorded. Last occupant → checkout instead (`BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT`); only minors left → blocked (`BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED`) |
| 12 | **Vehicles & extra services** | `PROPERTY_MANAGER` | Residence Law 2020; Circular 09/2023/TT-BCT | `tenant_vehicles` (owner = an occupant; motorbike / e-bike / car plates, parking cards), `contract_services` (Wi-Fi, parking, sanitation) |

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
| Building & tax settings | `buildings:manage:global` | ✅ GLOBAL | ❌ | ❌ | ❌ | ❌ |
| Room directory & vacancy | `rooms:read:department` | ✅ GLOBAL | ✅ | 🔍 | 🔍 | ❌ |
| Room price & status | `rooms:update:department` | ✅ GLOBAL | ✅ | ❌ | ❌ | ❌ |
| Appliance catalogue | `assets:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN room |
| Person profiles & encrypted CCCD | `tenants:manage:department` / `tenants:read:own` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN profile |
| Lease creation & activation | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN contract |
| **Occupant move-in / move-out** | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN occupancy |
| **Contract-holder transfer** | `contracts:manage:department` | ✅ GLOBAL | ✅ | 🔍 history | ❌ | 🔍 OWN contract history |
| Meter photo presigned URL | `meters:upload:department` | ✅ GLOBAL | ✅ | ❌ | ✅ | ❌ |
| Meter reading submission | `meters:create:department` | ✅ GLOBAL | ✅ | 🔍 | ✅ | 🔍 OWN room |
| Meter reset approval | `meters:approve:department` | ✅ GLOBAL | ✅ | ✅ | ❌ | ❌ |
| Invoices & payments | `invoices:manage:department` | ✅ GLOBAL | 🔍 | ✅ | ❌ | 🔍 OWN (billed to them) |
| Checkout & deposit settlement | `settlements:execute:department` | ✅ GLOBAL | ✅ | ✅ | ❌ | 🔍 OWN statement |
| Tax export & e-invoice | `tax:export:department` | ✅ GLOBAL | ❌ | ✅ | ❌ | ❌ |
| **Residence (CT01) per occupant** & PCCC | `compliance:manage:department` | ✅ GLOBAL | ✅ | 🔍 | ❌ | 🔍 OWN CT01 |
| WORM audit log | `audit:read:*` | ✅ GLOBAL | ✅ | ✅ | 🔍 OWN actions | 🔍 OWN actions |

A tenant user is linked to their own person profile, so `OWN` covers their profile, their occupancy, the contracts they live under, and the invoices addressed to them.

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
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 2. ONBOARDING A SHARED ROOM (docs 02 & 03)                                                     |
|  TenantsService: one profile per person (holder, roommates, children), CCCD / personal ID /      |
|  passport encrypted + id_card_hash blind index, consent (guardian for children)                 |
|  ContractsService: room lock + partial unique index; holder = PRIMARY_HOLDER, others CO_OCCUPANT |
|  1-month deposit HELD in deposit_ledgers                                                        |
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
