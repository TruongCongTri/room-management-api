# Document 04: OpenAPI / Swagger Specification (`04-Swagger-API.md`)

This document defines the enterprise **OpenAPI 3.0.3** contract for the 80-room flat rental management platform. It aligns every endpoint, header, payload projection, and error contract with the supporting infrastructure in `01-Supporting-Modules.md`, the domain services in `02-Core-Modules.md`, and the normalized TypeORM PostgreSQL schema in `03-Database.md`.

---

## 1\. Enterprise API Governance & Architectural Conventions

### 1.1 Segmented Swagger Portals (`SwaggerModule` \+ `VersioningModule`)

To prevent exposing internal management endpoints to mobile clients, `SwaggerModule` generates three isolated OpenAPI specifications under URI versioning (`/api/v1/...`) with RFC 8594 `Deprecation` and `Sunset` header support:

1. **Admin & Backoffice Portal (`/api/docs/admin`):** For `LANDLORD`, `PROPERTY_MANAGER`, and `ACCOUNTANT` roles (Room management, contract activation, mid-month checkout settlements, 2026 tax exports, and scoped WORM audit logs).  
     
2. **Guard Mobile Metering Portal (`/api/docs/guard`):** For `GUARD` role (Missing meter checklist, 15-minute S3 Presigned `PUT` URL generation, and manual water/electricity reading submission).  
     
3. **Tenant Self-Service & Webhook Portal (`/api/docs/external`):** For `TENANT` role and external VietQR banking webhooks.

### 1.2 Mandatory Enterprise Headers & Security Matrix

| Header Name | Requirement | Consumed By | Architectural Purpose |
| :---- | :---- | :---- | :---- |
| **`Authorization`** | `Bearer <JWT>` (Required unless `@Public()`) | `JwtAuthGuard` & `RequestContextInterceptor` | Authenticates the actor and hydrates `userId`, `roles`, and CASL `rules` into `AsyncLocalStorage`. |

| | **`X-Building-ID`** | `UUID v4` (Required on tenant-scoped routes) | `TenancyContextMiddleware` & `RlsService` | Sets `SET LOCAL app.current_building_id` inside TypeORM ACID transactions to enforce PostgreSQL Row-Level Security (RLS).

| | **`Idempotency-Key`** | `UUID v4` (Required on mutating financial/meter POSTs) | `IdempotencyInterceptor` | Executes a two-phase Redis lock (`IN_PROGRESS` \$\\rightarrow\$ `COMPLETED`, 24h TTL) with SHA-256 request body fingerprinting to prevent double billing or duplicate settlements.

| | \*\*`traceparent` / `X-Trace-ID**` | W3C TraceContext / `UUID` (Optional) | `RequestContextMiddleware` & `TracingModule` | Propagates distributed tracing spans across HTTP, TypeORM SQL logs, S3, and BullMQ workers.

| | **`Accept-Language`** | `vi-VN` (default), `en-US`, `ko-KR`, `ja-JP` | `I18nModule` | Localizes validation messages, RFC 7807 error descriptions, and notification templates.

| | \*\*`X-Webhook-Signature` & `X-Webhook-Timestamp**` | HMAC-SHA256 Hex & Unix Epoch Seconds | `WebhookSignatureGuard` | Verifies webhook authenticity via `crypto.timingSafeEqual` and blocks replay attacks older than 300 seconds.

|

### 1.3 Standardized Response & Error Envelopes

* **Success JSON Envelope (`TransformInterceptor`):** All `200`/`201` JSON responses are wrapped deterministically. Binary file streams (`application/pdf` and `.xlsx` via `DocumentReportModule`) bypass JSON wrapping automatically.  
    
* **Error Envelope (`AllExceptionsFilter` & `HttpExceptionFilter` — RFC 7807):** Maps NestJS validation failures, CASL permission denials, and PostgreSQL kernel errors (`23505` unique violation \$\\rightarrow\$ `409 Conflict`, `23503` FK violation \$\\rightarrow\$ `400 Bad Request`, `40P01` deadlock \$\\rightarrow\$ `409 Conflict`) into a unified RFC 7807 payload with production stack-trace suppression.

---

## 2\. Complete OpenAPI 3.0.3 Specification (`openapi.yaml`)

openapi: 3.0.3

info:

  title: Enterprise Flat Rental Management API (Vietnam 2026 Statutory Edition)

  version: 1.2.0

  description: |

    Production-safe NestJS \+ TypeORM \+ PostgreSQL \+ Redis backend for managing an 80-room rental building\[cite: 2, 4, 7\].

    

    \#\#\# Architectural & Legal Highlights:

    \- \*\*4 Performance Mandates:\*\* Composite/Partial Index Scans (Zero Seq Scan), Single-Query Joins (Zero N+1), Trimmed REST Payloads, and Redis XFetch Anti-Stampede Caching\[cite: 2, 4, 6\].

    \- \*\*Vietnam Legal Compliance (2026):\*\* Housing Law 2023, Civil Code 2015 (Art. 328 Deposit Escrow), Residence Law 2020 (Form CT01), Personal Data Protection Law No. 91/2025/QH15 (AES-256-GCM \+ HMAC Blind Index), Fire Safety Law 2024 (PCCC), and 2026 Property Rental Taxation (Law 109/2025/QH15, Decree 68/2026 & Decree 141/2026/NĐ-CP, Circular 18/2026/TT-BTC — 1 Billion VND threshold, Form 01/BĐS & Annex 01/BK-BĐS)\[cite: 3, 4, 5\].

servers:

  \- url: https\://api.rentalcore.vn/api/v1

    description: Production Cluster Gateway (URI Version v1)\[cite: 2, 4, 7\]

tags:

  \- name: Observability & Health

    description: Kubernetes Liveness/Readiness probes and OpenTelemetry Prometheus metrics (@Public)\[cite: 2, 4\]

  \- name: Properties & Room Directory

    description: Index-backed 80-room listing, single-query room details, and XFetch cached vacancy summary\[cite: 4, 6, 7\]

  \- name: Assets & Furniture Catalog

    description: Rentable appliances and furniture inventory, serial numbers, and room assignments\[cite: 3, 5, 6\]

  \- name: Tenants & PDPL Privacy

    description: Encrypted tenant profiles (AES-256-GCM), HMAC blind-index lookups, and Law 91/2025 consent\[cite: 2, 4, 5\]

  \- name: Contracts & 1-Month Deposit Escrow

    description: Lease activation, shared occupancy (every occupant's CCCD & residence), contract-holder transfer, extra fees, and deposit ledger\[cite: 3, 5, 6\]

  \- name: Metering (Guard Mobile Workflow)

    description: Missing room checklist, zero-proxy S3 Presigned PUT URLs, and manual meter ingestion\[cite: 2, 3, 5, 7\]

  \- name: Billing, Prorated Checkout & Webhooks

    description: Month-end billing batch, mid-month prorated checkout settlement, and VietQR webhooks\[cite: 2, 3, 5, 7\]

  \- name: Vietnam Legal, Tax & PCCC Compliance

    description: Statutory PDF contracts, Form CT01, 2026 Tax Form 01/BĐS Excel stream, and PCCC tracker\[cite: 1, 3, 4, 5, 7\]

  \- name: Audit Ledger (WORM)

    description: CASL-scoped immutable audit log retrieval (OWN, DEPARTMENT, GLOBAL)\[cite: 2, 4\]

security:

  \- BearerAuth: \[\]

paths:

  \# \===========================================================================

  \# 1\. OBSERVABILITY & HEALTH PROBES (@Public)

  \# \===========================================================================

  /health/liveness:

    get:

      tags: \[Observability & Health\]

      summary: Kubernetes Liveness Probe (Ultra-lightweight Event Loop & Heap check)\[cite: 2, 4\]

      security: \[\]

      responses:

        '200':

          description: Node.js process is alive and Event Loop is responsive\[cite: 2, 4\]

        '503':

          description: Process heap exhausted or Event Loop deadlocked\[cite: 2, 4\]

  /health/readiness:

    get:

      tags: \[Observability & Health\]

      summary: Kubernetes Readiness Probe (PostgreSQL Master/Replica, Redis, S3 & Graceful Shutdown check)\[cite: 2, 4\]

      description: |

        Immediately returns \`503 Service Unavailable\` when \`GracefulShutdownService.isShuttingDown()\` is \`true\`

        so Kubernetes Ingress / AWS ALB stops routing new traffic during pod termination\[cite: 2, 4\].

      security: \[\]

      responses:

        '200':

          description: All infrastructure dependencies are healthy and ready to serve traffic\[cite: 2, 4\]

        '503':

          description: Pod is draining traffic (SIGTERM) or a critical dependency (DB/Redis) is down\[cite: 2, 4\]

  \# \===========================================================================

  \# 2\. PROPERTIES & ROOM DIRECTORY (OPTIMIZATION MANDATES \#1, \#2, \#3, \#4)

  \# \===========================================================================

  /properties/rooms:

    get:

      tags: \[Properties & Room Directory\]

      summary: List rooms with index-backed filtering, sorting, and pagination\[cite: 3, 7\]

      description: |

        \- \*\*Optimization \#1 (Index Scan):\*\* Uses \`idx\_rooms\_bld\_status\_type\` and \`idx\_rooms\_available\_covering\`\[cite: 6\].

        \- \*\*Optimization \#2 (Zero N+1):\*\* Single SQL \`INNER JOIN\` with \`room\_types\`.

        \- \*\*Optimization \#3 (Lightweight Payload):\*\* Projects only 6 scalar presentation fields\[cite: 6, 7\].

        \- \*\*Rate Limit:\*\* \`@ThrottleSearch()\` (100 req/min)\[cite: 2, 4\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/AcceptLanguageHeader'

        \- name: page

          in: query

          schema: { type: integer, default: 1, minimum: 1 }

        \- name: limit

          in: query

          schema: { type: integer, default: 20, minimum: 1, maximum: 100 }

        \- name: status

          in: query

          schema:

            type: string

            enum: \[AVAILABLE, RESERVED, OCCUPIED, MAINTENANCE\]

        \- name: roomTypeId

          in: query

          schema: { type: string, format: uuid }

        \- name: floor

          in: query

          schema: { type: integer, minimum: 1, maximum: 30 }

        \- name: sortBy

          in: query

          schema:

            type: string

            enum: \[roomNumber, floor, effectivePrice\]

            default: roomNumber

        \- name: sortOrder

          in: query

          schema:

            type: string

            enum: \[ASC, DESC\]

            default: ASC

      responses:

        '200':

          description: Lightweight paginated room directory retrieved successfully\[cite: 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        type: array

                        items:

                          \$ref: '\#/components/schemas/RoomListItemDto'

        '400':

          \$ref: '\#/components/responses/BadRequestError'

        '401':

          \$ref: '\#/components/responses/UnauthorizedError'

  /properties/rooms/vacancies/summary:

    get:

      tags: \[Properties & Room Directory\]

      summary: Get room vacancy statistics grouped by RoomType (Redis XFetch Cached)\[cite: 2, 3, 7\]

      description: |

        \- \*\*Optimization \#4 (Caching):\*\* Cached under \`cache:{buildingId}:rooms:vacancies:summary\` using the

          \*\*XFetch Probabilistic Early Expiration\*\* algorithm to prevent cache stampedes\[cite: 2, 4, 6\].

        \- Automatically invalidated via non-blocking Redis \`UNLINK\` (\`tag:{buildingId}:rooms\`) when a contract

          is activated or a tenant clocks out\[cite: 2, 4, 5\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

      responses:

        '200':

          description: Aggregated room availability by tier\[cite: 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        type: array

                        items:

                          \$ref: '\#/components/schemas/VacancySummaryItemDto'

  /properties/rooms/{id}:

    get:

      tags: \[Properties & Room Directory\]

      summary: Get single-query room detail profile\[cite: 3, 7\]

      description: |

        \- \*\*Optimization \#2 (Zero N+1):\*\* Resolves room metadata, room type, active lease contract, primary tenant,

          co-occupant headcount, and all assigned rental appliances (\`room\_assets\`) in a single TypeORM query\[cite: 3, 6, 7\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: id

          in: path

          required: true

          description: Room UUID (validated by ParseUUIDStrictPipe)\[cite: 2, 4, 7\]

          schema: { type: string, format: uuid }

      responses:

        '200':

          description: Detailed room profile retrieved successfully\[cite: 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        \$ref: '\#/components/schemas/RoomDetailDto'

        '404':

          \$ref: '\#/components/responses/NotFoundError'

  \# \===========================================================================

  \# 3\. ASSETS & APPLIANCE RENTAL CATALOG

  \# \===========================================================================

  /assets/room-assignments:

    post:

      tags: \[Assets & Furniture Catalog\]

      summary: Assign a serial-numbered appliance or furniture item to a room\[cite: 3, 5, 6\]

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/IdempotencyKeyHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/AssignRoomAssetDto'

      responses:

        '201':

          description: Appliance assigned to room inventory\[cite: 5, 6\]

        '409':

          \$ref: '\#/components/responses/ConflictError'

  \# \===========================================================================

  \# 4\. TENANTS & PERSONAL DATA PROTECTION (LAW 91/2025/QH15)

  \# \===========================================================================

  /tenants:

    post:

      tags: \[Tenants & PDPL Privacy\]

      summary: Register one person (holder, roommate or child) with AES-256-GCM encryption & HMAC blind indexing\[cite: 2, 3, 4\]

      description: |

        \- \*\*Every occupant needs a profile\*\* — the contract holder, each roommate and each child (12-digit personal
          identification number when no CCCD card exists; passport for foreigners). A duplicate ID returns `409
          BIZ_TENANT_ID_CARD_DUPLICATE` with the existing profile id, which is reused when the person changes rooms.

        Encrypts \`idCardNumber\` (12-digit CCCD/Passport) and \`refundBankAccount\` via \`FieldEncryptionTransformer\`

        (\`AES-256-GCM\` with key version prefix) and computes \`idCardHash\` (\`HMAC-SHA256\`) for O(1) duplicate detection\[cite: 2, 4\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/IdempotencyKeyHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/CreateTenantDto'

      responses:

        '201':

          description: Tenant created with masked PII response

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        \$ref: '\#/components/schemas/TenantSafeResponseDto'

        '409':

          \$ref: '\#/components/responses/ConflictError'

  /tenants/lookup:

    get:

      tags: \[Tenants & PDPL Privacy\]

      summary: Exact-match lookup by Citizen ID (CCCD) using deterministic HMAC blind index

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: idCardNumber

          in: query

          required: true

          example: "079099001234"

          schema: { type: string }

      responses:

        '200':

          description: Tenant profile found via idx\_tenants\_bld\_id\_hash\_unique

        '404':

          \$ref: '\#/components/responses/NotFoundError'

  \# \===========================================================================

  \# 5\. CONTRACTS & 1-MONTH DEPOSIT ESCROW ("TIỀN ĐẶT CỌC")

  \# \===========================================================================

  /contracts:

    post:

      tags: \[Contracts & 1-Month Deposit Escrow\]

      summary: Create & activate a room lease contract with 1-month security deposit intake\[cite: 3, 5\]

      description: |

        \- Acquires Redis Redlock (\`lock:room:contract:{roomId}\`) and enforces PostgreSQL partial unique index

          \`idx\_unique\_active\_contract\_per\_room\` to prevent double-booking\[cite: 2, 4\].

        \- Records the \*\*1-month security deposit (\`depositAmount\`)\*\* in \`deposit\_ledgers\` (\`status \= HELD\`)\[cite: 3, 5, 6\].

        \- Registers the contract holder (`primaryTenantId`, role PRIMARY\_HOLDER) and every `coOccupants` entry in
          `contract\_occupants` (total ≤ `room.maxOccupants`); each person gets residence status PENDING\_DECLARATION and
          their own CT01. The EVN quota headcount starts at 0 and grows as residences become REGISTERED.

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/IdempotencyKeyHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/CreateContractDto'

      responses:

        '201':

          description: Contract activated, 1-month deposit held in escrow, and room marked OCCUPIED\[cite: 5, 6\]

        '409':

          \$ref: '\#/components/responses/ConflictError'

  /contracts/{id}/deposit-ledger:

    get:

      tags: \[Contracts & 1-Month Deposit Escrow\]

      summary: Get immutable 1-month security deposit escrow ledger for a contract\[cite: 3, 5\]

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: id

          in: path

          required: true

          schema: { type: string, format: uuid }

      responses:

        '200':

          description: Deposit collection, deduction, and refund ledger entries


```yaml
  # ===========================================================================
  # 5b. SHARED ROOMS: OCCUPANTS, CONTRACT HOLDER (NGƯỜI ĐỨNG TÊN) & RESIDENCE
  # ===========================================================================
  /contracts/{id}/occupants:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: List everyone living in the room under this contract (holder first)
      description: |
        - Active occupants by default (`status=ALL` adds people who moved out, for residence history).
        - ID numbers are always masked (`idCardMasked`); residence status is per person.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: status, in: query, required: false, schema: { type: string, enum: [ACTIVE, ALL], default: ACTIVE } }
      responses:
        '200':
          description: Occupants with role, move-in date, succession order and residence status
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/OccupantDto' } }
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: A new person moves into the room (co-occupant)
      description: |
        - The person must already have a tenant profile (`POST /tenants`) with an ID document and consent.
        - Rejected when the room is full (`rooms.max_occupants`) or the person still lives in another room.
        - Creates residence status `PENDING_DECLARATION` and queues this person's CT01 (or foreigner declaration).
        - Lock `lock:{buildingId}:checkout:contract:{id}` — never concurrent with a checkout or holder transfer.
        - Rent and deposit do not change (rent is per room).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AddOccupantDto' }
      responses:
        '201': { description: Occupant added }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_OCCUPANT_LIMIT_EXCEEDED, BIZ_OCCUPANT_ALREADY_ACTIVE
        '422': { description: 'BIZ_OCCUPANT_ID_DOCUMENT_REQUIRED or BIZ_PDPL_CONSENT_REQUIRED' }

  /contracts/{id}/occupants/{occupantId}/move-out:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: A co-occupant moves out (the room stays rented)
      description: |
        - Not allowed for the contract holder → `409`, use `POST /contracts/{id}/primary-holder/transfer`
          (or `POST /billing/checkout/execute` when the holder is the last occupant).
        - Sets residence status `DEREGISTRATION_PENDING`, deactivates the person's vehicles, recomputes the EVN headcount.
        - No proration and no deposit movement.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: occupantId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MoveOutOccupantDto' }
      responses:
        '200': { description: Occupant moved out }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_OCCUPANT_NOT_ACTIVE, holder must use transfer

  /contracts/{id}/occupants/{occupantId}/residency:
    patch:
      tags: [Vietnam Legal, Tax & PCCC Compliance]
      summary: Record the residence declaration result for one person (submitted / registered / deregistered)
      description: |
        Allowed transitions: PENDING_DECLARATION → SUBMITTED → REGISTERED; DEREGISTRATION_PENDING → DEREGISTERED.
        Reaching or leaving REGISTERED recomputes `registeredEvnQuotaHeadcount`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: occupantId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateResidencyStatusDto' }
      responses:
        '200': { description: Residence status updated }
        '409': { $ref: '#/components/responses/ConflictError' }

  /contracts/{id}/primary-holder/transfer:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: The contract holder (người đứng tên) moves out — transfer the contract to the next occupant
      description: |
        - Successor: `newPrimaryTenantId` when the parties agreed on one (must be eligible), otherwise the eligible
          occupant with the lowest `successionOrder`, then the earliest move-in. Eligible = still living there,
          18 or older on `effectiveDate`, ID document and personal-data consent on file.
        - The contract keeps its id, rent and terms; `primaryTenantId` — and therefore the contract holder's CCCD —
          becomes the successor's. Invoices issued from now on are addressed to the successor.
        - Writes `contract_holder_transfers`, the deposit movements (`depositHandling`) and queues the
          HOLDER_TRANSFER_ADDENDUM PDF (landlord, outgoing and incoming holder sign).
        - The outgoing holder's residence becomes `DEREGISTRATION_PENDING` (unless `outgoingHolderStays`).
        - `409 BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT` when nobody else lives there → use `POST /billing/checkout/execute`;
          `409 BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED` when only ineligible people remain (e.g. children);
          `422 BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE` when the designated successor is not eligible (reasons in `details`).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/TransferPrimaryHolderDto' }
      responses:
        '201':
          description: Contract holder changed
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/HolderTransferResultDto' }
        '409': { $ref: '#/components/responses/ConflictError' }
        '422': { description: BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE }

  /contracts/{id}/primary-holder/history:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: History of contract holders for this contract (with addendum links)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Transfers ordered by effective date
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/HolderTransferResultDto' } }
```


  \# \===========================================================================

  \# 6\. MANUAL GUARD METERING WORKFLOW (ZERO-PROXY S3 \+ DELTA VALIDATION)

  \# \===========================================================================

  /metering/cycles/{billingPeriodMonth}/missing-rooms:

    get:

      tags: \[Metering (Guard Mobile Workflow)\]

      summary: Get checklist of occupied rooms still missing guard meter readings for the month

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: billingPeriodMonth

          in: path

          required: true

          description: First day of target billing month (YYYY-MM-01), validated by ParseDatePipe\[cite: 2, 4\]

          example: "2026-10-01"

          schema: { type: string, format: date }

      responses:

        '200':

          description: List of occupied rooms pending guard photo capture and index entry

  /metering/presigned-url:

    post:

      tags: \[Metering (Guard Mobile Workflow)\]

      summary: Generate 15-minute S3 Presigned PUT URL for guard meter photo upload\[cite: 2, 4, 5, 7\]

      description: |

        Allows the guard's mobile app to upload water and electricity sub-meter photos directly to AWS S3 / MinIO,

        eliminating binary proxy load and OOM hazards on the NestJS server\[cite: 2, 3, 4, 5, 7\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/CreateMeterPresignedUrlDto'

      responses:

        '201':

          description: Presigned upload credentials wrapped in standard response envelope\[cite: 2, 4, 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        \$ref: '\#/components/schemas/PresignedUrlResponseDto'

  /metering/records:

    post:

      tags: \[Metering (Guard Mobile Workflow)\]

      summary: Submit manual water and electricity meter readings with S3 photo keys\[cite: 3, 5, 7\]

      description: |

        \- Uses \`idx\_meter\_room\_date\_desc\` for an Index Backward Scan to fetch the previous reading in \< 0.2ms\[cite: 6\].

        \- Validates \`currPowerIndex \>= prevPowerIndex\` and \`currWaterIndex \>= prevWaterIndex\` unless \`isMeterReset \= true\`\[cite: 3, 5, 7\].

        \- When \`isFinalCheckoutReading \= true\`, locks the reading as the baseline for mid-month tenant checkout\[cite: 5, 6, 7\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/IdempotencyKeyHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/RecordMeterReadingDto'

      responses:

        '201':

          description: Meter reading validated, delta computed, and persisted\[cite: 5, 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        \$ref: '\#/components/schemas/MeterReadingResultDto'

        '400':

          \$ref: '\#/components/responses/BadRequestError'

        '409':

          \$ref: '\#/components/responses/ConflictError'

  \# \===========================================================================

  \# 7\. BILLING, MID-MONTH PRORATED CHECKOUT & VIETQR WEBHOOKS

  \# \===========================================================================

  /billing/checkout/execute:

    post:

      tags: \[Billing, Prorated Checkout & Webhooks\]

      summary: Execute mid-month clock-out, exact-day proration, and 1-month deposit deduction\[cite: 3, 5, 7\]

      description: |

        \- \*\*Room handover only:\*\* used when the LAST occupant leaves. Settles with the current contract holder
          (`settledWithTenantId`) and moves every remaining occupant out (residence DEREGISTRATION\_PENDING each).
          A co-occupant or the holder leaving while others stay uses the occupant / primary-holder endpoints instead.

        \- \*\*Concurrency & Safety:\*\* Protected by \`@ThrottleSensitive()\` (5 req/min), \`IdempotencyInterceptor\`,

          and Redis Redlock (\`lock:checkout:contract:{contractId}\`)\[cite: 2, 3, 4, 7\].

        \- \*\*Proration Math:\*\* Computes exact inclusive days occupied \$D\$ out of calendar days \$M\$ in the checkout month,

          prorating \*\*Base Room Rent\*\*, \*\*Rented Appliances (\`contract\_assets\`)\*\*, and \*\*Fixed Extra Services (\`contract\_services\`)\*\*\[cite: 3, 5\].

        \- \*\*1-Month Deposit Reconciliation:\*\* Adds final electricity/water fees and damage penalties, then deducts

          the 1-month security deposit (\`depositHeld\`) to determine whether the tenant owes extra or receives a refund\[cite: 3, 5, 7\].

        \- \*\*Cache Invalidation:\*\* Transitions room to \`MAINTENANCE\` and invalidates \`tag:{buildingId}:rooms\` via Redis \`UNLINK\`\[cite: 2, 4, 5\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- \$ref: '\#/components/parameters/IdempotencyKeyHeader'

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/ExecuteCheckoutDto'

      responses:

        '200':

          description: Checkout settled, deposit deducted, and settlement statement queued\[cite: 5, 7\]

          content:

            application/json:

              schema:

                allOf:

                  \- \$ref: '\#/components/schemas/StandardSuccessEnvelope'

                  \- type: object

                    properties:

                      data:

                        \$ref: '\#/components/schemas/CheckoutSettlementResultDto'

        '400':

          \$ref: '\#/components/responses/BadRequestError'

        '409':

          \$ref: '\#/components/responses/ConflictError'

  /webhooks/payments/vietqr:

    post:

      tags: \[Billing, Prorated Checkout & Webhooks\]

      summary: Inbound VietQR / Bank Transfer payment confirmation webhook (@Public \+ HMAC Guard)\[cite: 2, 4\]

      security:

        \- WebhookHmacAuth: \[\]

      parameters:

        \- name: X-Webhook-Signature

          in: header

          required: true

          description: HMAC-SHA256 hex signature of \`\<timestamp\>.\<rawBody\>\`\[cite: 2, 4\]

          schema: { type: string }

        \- name: X-Webhook-Timestamp

          in: header

          required: true

          description: Unix epoch timestamp in seconds (rejected if \> 300s drift)\[cite: 2, 4\]

          schema: { type: integer, example: 1792145760 }

      requestBody:

        required: true

        content:

          application/json:

            schema:

              \$ref: '\#/components/schemas/VietQrWebhookPayloadDto'

      responses:

        '200':

          description: Payment recorded in payment\_transactions and invoice status updated

        '401':

          description: Invalid HMAC signature or replay attack timestamp expired\[cite: 2, 4\]

  \# \===========================================================================

  \# 8\. VIETNAM LEGAL, TAX (2026) & PCCC COMPLIANCE EXPORTS

  \# \===========================================================================

  /compliance-vn/contracts/{id}/lease-pdf:

    get:

      tags: \[Vietnam Legal, Tax & PCCC Compliance\]

      summary: Export statutory Lease Contract PDF (Housing Law 2023, Civil Code 2015 & Fire Law 2024)\[cite: 1, 3, 4, 5, 7\]

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: id

          in: path

          required: true

          schema: { type: string, format: uuid }

      responses:

        '200':

          description: High-resolution Vietnamese PDF lease contract stream\[cite: 1, 2, 4, 7\]

          content:

            application/pdf:

              schema: { type: string, format: binary }

  /compliance-vn/contracts/{id}/handover-pdf:

    get:

      tags: \[Vietnam Legal, Tax & PCCC Compliance\]

      summary: Export Room, Appliance Serials & Baseline Meter Handover Minutes PDF (Biên bản bàn giao)\[cite: 1, 3, 4, 5\]

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: id

          in: path

          required: true

          schema: { type: string, format: uuid }

      responses:

        '200':

          description: PDF handover minutes stream\[cite: 1, 3, 5\]

          content:

            application/pdf:

              schema: { type: string, format: binary }

  /compliance-vn/contracts/{id}/settlement-pdf:

    get:

      tags: \[Vietnam Legal, Tax & PCCC Compliance\]

      summary: Export Mid-Month Checkout & Deposit Liquidation Statement PDF (Biên bản thanh lý & quyết toán cọc)

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: id

          in: path

          required: true

          schema: { type: string, format: uuid }

      responses:

        '200':

          description: PDF checkout settlement voucher stream

          content:

            application/pdf:

              schema: { type: string, format: binary }

```yaml
  /compliance-vn/occupants/{occupantId}/ct01-pdf:
    get:
      tags: [Vietnam Legal, Tax & PCCC Compliance]
      summary: Form CT01 PDF for ONE occupant (Residence Law 2020 & Circular 66/2023/TT-BCA)
      description: |
        One declaration per person: full name, date of birth, gender, personal identification number (decrypted only
        while rendering), permanent address, relationship to the household head, landlord consent.
        `purpose` selects the declaration: temporary-residence registration, deletion after moving out, or change of
        household head after a contract-holder transfer. Not available for passports (foreigner channel).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: occupantId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: purpose, in: query, required: true, schema: { type: string, enum: [REGISTRATION, DEREGISTRATION, HOUSEHOLD_HEAD_CHANGE] } }
      responses:
        '200':
          description: CT01 PDF
          content:
            application/pdf:
              schema: { type: string, format: binary }
        '409': { description: 'Occupant uses the foreigner temporary-residence channel' }

  /compliance-vn/residency/pending:
    get:
      tags: [Vietnam Legal, Tax & PCCC Compliance]
      summary: Residence work queue — occupants to declare (moved in) or deregister (moved out)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: format, in: query, required: false, schema: { type: string, enum: [json, xlsx], default: json } }
      responses:
        '200':
          description: Occupants in PENDING_DECLARATION or DEREGISTRATION_PENDING (JSON, or streamed Excel for Ward Police / VNeID)
```

  /compliance-vn/tax/form-01-bds-2026:

    get:

      tags: \[Vietnam Legal, Tax & PCCC Compliance\]

      summary: Stream 2026 Property Tax Declaration Excel (Form 01/BĐS & Annex 01/BK-BĐS)

      description: |

        \- \*\*2026 Statutory Tax Rules (Law 109/2025/QH15, Decree 68/2026 & Decree 141/2026/NĐ-CP, Circular 18/2026/TT-BTC):\*\*

          \- \*\*Exempt Threshold:\*\* 1,000,000,000 VND/year (1 tỷ đồng/năm).

          \- \*\*Business License Fee (Lệ phí môn bài):\*\* 0 VND (abolished under Resolution 198/2025/QH15).

          \- \*\*VAT (GTGT):\*\* 5% on total taxable leasing revenue\[cite: 3, 5\].

          \- \*\*PIT (TNCN):\*\* 5% strictly on the taxable revenue portion exceeding 1,000,000,000 VND.

          \- Segregates taxable leasing revenue (Room \+ Appliances \+ Service markups) from pass-through utilities (\*Thu hộ điện nước\*).

        \- \*\*OOM-Safe Streaming:\*\* Uses \`ExcelJS.stream.xlsx.WorkbookWriter\` to keep RAM flat (\< 60MB)\[cite: 2, 4\].

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: taxYear

          in: query

          required: true

          schema: { type: integer, example: 2026 }

        \- name: quarter

          in: query

          required: false

          schema: { type: integer, enum: \[1, 2, 3, 4\] }

      responses:

        '200':

          description: Streamed Excel workbook (.xlsx) containing Form 01/BĐS & Annex 01/BK-BĐS\[cite: 2, 4, 7\]

          content:

            application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:

              schema: { type: string, format: binary }

  /compliance-vn/pccc/status:

    get:

      tags: \[Vietnam Legal, Tax & PCCC Compliance\]

      summary: Get Fire Safety (PCCC) compulsory insurance & equipment inspection status (Fire Law 2024\)

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

      responses:

        '200':

          description: PCCC compliance status and upcoming expiry alerts

  \# \===========================================================================

  \# 9\. SCOPED AUDIT LOG VIEWER (WORM LEDGER)

  \# \===========================================================================

  /audit-logs:

    get:

      tags: \[Audit Ledger (WORM)\]

      summary: Query immutable WORM audit logs with CASL scope enforcement (OWN, DEPARTMENT, GLOBAL)\[cite: 2, 4\]

      parameters:

        \- \$ref: '\#/components/parameters/BuildingIdHeader'

        \- name: resourceName

          in: query

          schema: { type: string, enum: \[Contract, MeterReading, Invoice, DepositLedger, Room\] }

        \- name: resourceId

          in: query

          schema: { type: string, format: uuid }

        \- name: page

          in: query

          schema: { type: integer, default: 1 }

        \- name: limit

          in: query

          schema: { type: integer, default: 50, maximum: 100 }

      responses:

        '200':

          description: Paginated immutable audit log records with deep JSONB field diffs\[cite: 2, 4\]

\# \=============================================================================

\# REUSABLE COMPONENTS, HEADERS, SCHEMAS & RFC 7807 RESPONSES

\# \=============================================================================

components:

  securitySchemes:

    BearerAuth:

      type: http

      scheme: bearer

      bearerFormat: JWT

      description: JWT Access Token containing userId, buildingId, roles, and flattened CASL rules\[cite: 2, 4\]

    WebhookHmacAuth:

      type: apiKey

      in: header

      name: X-Webhook-Signature

      description: HMAC-SHA256 signature verified via crypto.timingSafeEqual\[cite: 2, 4\]

  parameters:

    BuildingIdHeader:

      name: X-Building-ID

      in: header

      required: true

      description: Target Building UUID for PostgreSQL Row-Level Security (RLS) isolation\[cite: 2, 4\]

      schema: { type: string, format: uuid, example: "b1000000-0000-4000-8000-000000000001" }

    IdempotencyKeyHeader:

      name: Idempotency-Key

      in: header

      required: true

      description: Unique UUID v4 token for 2-phase Redis idempotency locking (24h TTL)\[cite: 2, 4, 7\]

      schema: { type: string, format: uuid, example: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }

    AcceptLanguageHeader:

      name: Accept-Language

      in: header

      required: false

      description: Locale code for i18n response & error translation\[cite: 2, 4\]

      schema: { type: string, default: "vi-VN", enum: \[vi-VN, en-US, ko-KR, ja-JP\] }

  schemas:

    StandardSuccessEnvelope:

      type: object

      required: \[success, statusCode, meta\]

      properties:

        success:

          type: boolean

          example: true

        statusCode:

          type: integer

          example: 200

        meta:

          type: object

          required: \[traceId, timestamp, durationMs\]

          properties:

            traceId:

              type: string

              example: "0af7651916cd43dd8448eb211c80319c"

            timestamp:

              type: string

              format: date-time

              example: "2026-10-16T09:16:00.000Z"

            durationMs:

              type: number

              example: 8.42

            pagination:

              \$ref: '\#/components/schemas/PaginationMetaDto'

    PaginationMetaDto:

      type: object

      nullable: true

      properties:

        page: { type: integer, example: 1 }

        limit: { type: integer, example: 20 }

        totalItems: { type: integer, example: 80 }

        totalPages: { type: integer, example: 4 }

    RoomListItemDto:

      type: object

      description: Lightweight 6-field projection (Optimization Mandate \#3)\[cite: 6, 7\]

      properties:

        id: { type: string, format: uuid }

        roomNumber: { type: string, example: "P.302" }

        floor: { type: integer, example: 3 }

        status: { type: string, enum: \[AVAILABLE, RESERVED, OCCUPIED, MAINTENANCE\], example: "AVAILABLE" }

        roomTypeName: { type: string, example: "Studio Balcony" }

        effectivePrice: { type: number, example: 6500000 }

    VacancySummaryItemDto:

      type: object

      properties:

        roomTypeId: { type: string, format: uuid }

        roomTypeName: { type: string, example: "1BR Deluxe" }

        basePrice: { type: number, example: 8500000 }

        totalRooms: { type: integer, example: 30 }

        availableRooms: { type: integer, example: 4 }

        occupiedRooms: { type: integer, example: 25 }

        maintenanceRooms: { type: integer, example: 1 }

        occupancyPercentage: { type: number, example: 83.33 }

    RoomDetailDto:

      type: object

      properties:

        id: { type: string, format: uuid }

        roomNumber: { type: string, example: "P.302" }

        floor: { type: integer, example: 3 }

        areaSqm: { type: number, example: 32.5 }

        maxOccupants: { type: integer, example: 3 }

        status: { type: string, enum: \[AVAILABLE, RESERVED, OCCUPIED, MAINTENANCE\], example: "OCCUPIED" }

        roomTypeName: { type: string, example: "Studio Balcony" }

        effectiveRent: { type: number, example: 6500000 }

        activeContract:

          type: object

          nullable: true

          properties:

            id: { type: string, format: uuid }

            contractCode: { type: string, example: "HD-2026/080-P302" }

            primaryTenantName: { type: string, example: "Nguyễn Văn A" }

            primaryTenantPhone: { type: string, example: "0901234567" }

            occupantCount: { type: integer, example: 2 }

            monthlyRoomRent: { type: number, example: 6500000 }

            depositHeld: { type: number, example: 6500000 }

            startDate: { type: string, format: date, example: "2026-01-01" }

            endDate: { type: string, format: date, example: "2026-12-31" }

        rentedAssets:

          type: array

          items:

            type: object

            properties:

              roomAssetId: { type: string, format: uuid }

              name: { type: string, example: "Daikin Inverter 1.5HP" }

              category: { type: string, enum: \[APPLIANCE, FURNITURE\], example: "APPLIANCE" }

              serialNumber: { type: string, example: "DK-2026-992019" }

              conditionGrade: { type: string, enum: \[GRADE\_A\_NEW, GRADE\_B\_GOOD, GRADE\_C\_FAIR\], example: "GRADE\_A\_NEW" }

              monthlyFee: { type: number, example: 300000 }

    AssignRoomAssetDto:

      type: object

      required: \[roomId, assetId, serialNumber, customMonthlyFee, conditionGrade\]

      properties:

        roomId: { type: string, format: uuid }

        assetId: { type: string, format: uuid }

        serialNumber: { type: string, example: "DK-2026-992019" }

        conditionGrade: { type: string, enum: \[GRADE\_A\_NEW, GRADE\_B\_GOOD, GRADE\_C\_FAIR\] }

        customMonthlyFee: { type: number, minimum: 0, example: 300000 }

```yaml
    CreateTenantDto:
      type: object
      description: One profile per PERSON (contract holder, roommate or child). Register every occupant.
      required: [fullName, idDocumentType, idCardNumber, gender, dateOfBirth, hometownAddress, permanentAddress, pdplConsentAccepted]
      properties:
        fullName: { type: string, example: "Nguyễn Văn A" }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT], default: CCCD }
        idCardNumber:
          type: string
          example: "079099001234"
          description: 12-digit CCCD, or a child's 12-digit personal identification number, or passport number. Encrypted at rest; blind-indexed.
        idCardIssueDate: { type: string, format: date, nullable: true, example: "2022-05-10", description: Null for children without a card }
        idCardIssuePlace: { type: string, nullable: true, example: "Bộ Công an" }
        nationality: { type: string, minLength: 2, maxLength: 2, default: VN, example: VN }
        gender: { type: string, enum: [MALE, FEMALE] }
        dateOfBirth: { type: string, format: date, example: "1999-08-15" }
        phone: { type: string, nullable: true, example: "0901234567", description: Optional for children }
        email: { type: string, format: email, nullable: true }
        hometownAddress: { type: string, example: "Quận 1, TP. Hồ Chí Minh" }
        permanentAddress: { type: string, example: "123 Nguyễn Huệ, Phường Bến Nghé, TP.HCM" }
        refundBankAccount: { type: string, nullable: true, example: "0071001234567" }
        refundBankName: { type: string, nullable: true, example: "Vietcombank" }
        pdplConsentAccepted: { type: boolean, example: true, description: Mandatory consent (Law 91/2025/QH15) }
        consentGuardianTenantId:
          type: string
          format: uuid
          nullable: true
          description: Required for a minor — the parent / guardian giving consent (Decree 13/2023/NĐ-CP, Art. 20)

    TenantSafeResponseDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        fullName: { type: string, example: "Nguyễn Văn A" }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT] }
        idCardMasked: { type: string, example: "********1234" }
        isMinor: { type: boolean, example: false }
        phone: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }

    CreateContractDto:
      type: object
      required: [roomId, primaryTenantId, startDate, endDate, monthlyRoomRent, depositAmount, pcccCommitmentSigned]
      properties:
        roomId: { type: string, format: uuid }
        primaryTenantId:
          type: string
          format: uuid
          description: Contract holder (người đứng tên) — an adult with an ID document and consent
        coOccupants:
          type: array
          description: Everyone else who lives in the room from the start (each needs a tenant profile). Total ≤ room.maxOccupants.
          items: { $ref: '#/components/schemas/AddOccupantDto' }
        startDate: { type: string, format: date, example: "2026-10-01" }
        endDate: { type: string, format: date, example: "2027-09-30" }
        monthlyRoomRent: { type: number, example: 6500000, description: Per room, not per person }
        depositAmount: { type: number, description: "Standard 1-month security deposit (Tiền đặt cọc)", example: 6500000 }
        paymentDueDay: { type: integer, minimum: 1, maximum: 28, default: 5 }
        pcccCommitmentSigned: { type: boolean, example: true }
        rentedRoomAssetIds: { type: array, items: { type: string, format: uuid } }
        serviceSubscriptions:
          type: array
          items:
            type: object
            required: [serviceCatalogId, quantity]
            properties:
              serviceCatalogId: { type: string, format: uuid }
              quantity: { type: integer, minimum: 1, example: 2 }

    AddOccupantDto:
      type: object
      required: [tenantId, movedInAt]
      properties:
        tenantId: { type: string, format: uuid }
        movedInAt: { type: string, format: date, example: "2026-11-01" }
        successionOrder: { type: integer, minimum: 1, nullable: true, description: "Agreed order to take over the contract (1 = first)" }
        relationshipToHolder: { type: string, nullable: true, example: "Bạn cùng phòng", description: CT01 relationship to the household head }

    MoveOutOccupantDto:
      type: object
      required: [movedOutAt]
      properties:
        movedOutAt: { type: string, format: date, example: "2026-12-15" }
        notes: { type: string, nullable: true }

    UpdateResidencyStatusDto:
      type: object
      required: [residencyStatus]
      properties:
        residencyStatus: { type: string, enum: [SUBMITTED, REGISTERED, DEREGISTERED] }
        temporaryStayValidUntil: { type: string, format: date, nullable: true, description: Set with REGISTERED (max 2 years) }
        referenceNo: { type: string, nullable: true, example: "VNeID-2026-000123", description: Submission / approval reference }

    TransferPrimaryHolderDto:
      type: object
      required: [effectiveDate]
      properties:
        effectiveDate: { type: string, format: date, example: "2026-12-15" }
        newPrimaryTenantId: { type: string, format: uuid, nullable: true, description: Agreed successor; omitted → automatic succession }
        outgoingHolderStays: { type: boolean, default: false, description: Holder hands over but keeps living there as co-occupant }
        depositHandling: { type: string, enum: [CARRY_OVER, REFUND_AND_RECOLLECT], default: CARRY_OVER }
        outstandingBalanceAssumedBy: { type: string, enum: [OUTGOING_HOLDER, INCOMING_HOLDER], default: OUTGOING_HOLDER }
        notes: { type: string, nullable: true }

    OccupantDto:
      type: object
      properties:
        occupantId: { type: string, format: uuid }
        tenantId: { type: string, format: uuid }
        fullName: { type: string }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT] }
        idCardMasked: { type: string, example: "********1234" }
        role: { type: string, enum: [PRIMARY_HOLDER, CO_OCCUPANT] }
        status: { type: string, enum: [ACTIVE, MOVED_OUT] }
        movedInAt: { type: string, format: date }
        movedOutAt: { type: string, format: date, nullable: true }
        successionOrder: { type: integer, nullable: true }
        isMinor: { type: boolean }
        residenceChannel: { type: string, enum: [CT01, FOREIGNER_TEMPORARY_RESIDENCE] }
        residencyStatus: { type: string, enum: [PENDING_DECLARATION, SUBMITTED, REGISTERED, DEREGISTRATION_PENDING, DEREGISTERED] }
        temporaryStayValidUntil: { type: string, format: date, nullable: true }

    HolderTransferResultDto:
      type: object
      properties:
        transferId: { type: string, format: uuid }
        contractId: { type: string, format: uuid }
        fromTenantId: { type: string, format: uuid }
        toTenantId: { type: string, format: uuid }
        newHolderIdCardMasked: { type: string, example: "********5678" }
        effectiveDate: { type: string, format: date }
        selection: { type: string, enum: [DESIGNATED, AUTO_SUCCESSION] }
        depositHandling: { type: string, enum: [CARRY_OVER, REFUND_AND_RECOLLECT] }
        outstandingBalance: { type: number, example: 0 }
        addendumNo: { type: string, example: "PL-2026/080-P302-01" }
        addendumDownloadUrl: { type: string, nullable: true, description: Short-lived presigned URL once the PDF is rendered }
```

    CreateMeterPresignedUrlDto:

      type: object

      required: \[roomId, meterType, contentType\]

      properties:

        roomId: { type: string, format: uuid }

        meterType: { type: string, enum: \[POWER, WATER\] }

        contentType: { type: string, enum: \[image/jpeg, image/png, image/webp\] }

    PresignedUrlResponseDto:

      type: object

      properties:

        uploadUrl:

          type: string

          example: "https\://s3.rentalcore.vn/buildings/b100.../private/meters/P302/power\_179214.jpg?X-Amz-Signature=..."

        objectKey:

          type: string

          example: "buildings/b100.../private/meters/P302/power\_179214.jpg"

        expiresInSeconds:

          type: integer

          example: 900

    RecordMeterReadingDto:

      type: object

      required: \[roomId, billingPeriodMonth, currPowerIndex, currWaterIndex, powerPhotoS3Key, waterPhotoS3Key\]

      properties:

        roomId: { type: string, format: uuid }

        billingPeriodMonth: { type: string, format: date, example: "2026-10-01" }

        currPowerIndex: { type: number, minimum: 0, example: 1450.5 }

        currWaterIndex: { type: number, minimum: 0, example: 220.0 }

        powerPhotoS3Key: { type: string, example: "buildings/b100.../private/meters/P302/power\_179214.jpg" }

        waterPhotoS3Key: { type: string, example: "buildings/b100.../private/meters/P302/water\_179214.jpg" }

        isMeterReset: { type: boolean, default: false, description: "Set true only if physical meter rolled over or was replaced" }

        oldPowerMeterFinalIndex: { type: number, nullable: true }

        newPowerMeterInitialIndex: { type: number, nullable: true }

        oldWaterMeterFinalIndex: { type: number, nullable: true }

        newWaterMeterInitialIndex: { type: number, nullable: true }

        isFinalCheckoutReading: { type: boolean, default: false, description: "Set true when tenant is clocking out mid-month" }

    MeterReadingResultDto:

      type: object

      properties:

        id: { type: string, format: uuid }

        roomId: { type: string, format: uuid }

        billingPeriodMonth: { type: string, format: date, example: "2026-10-01" }

        powerConsumptionKwh: { type: number, example: 130.5 }

        waterConsumptionM3: { type: number, example: 8.0 }

        isFinalCheckoutReading: { type: boolean, example: true }

        createdAt: { type: string, format: date-time }

    ExecuteCheckoutDto:

      type: object

      required: \[contractId, checkoutDate\]

      properties:

        contractId: { type: string, format: uuid }

        checkoutDate: { type: string, format: date, example: "2026-10-18", description: "Exact clock-out date for proration" }

        damagePenaltyFee: { type: number, minimum: 0, default: 0, example: 250000 }

        damageNotes: { type: string, nullable: true, example: "Scratched wooden desk surface" }

    CheckoutSettlementResultDto:

      type: object

      properties:

        contractId: { type: string, format: uuid }

        checkoutDate: { type: string, format: date, example: "2026-10-18" }

        daysOccupied: { type: integer, example: 18 }

        daysInMonth: { type: integer, example: 31 }

        proratedRoomRent: { type: number, example: 3774194 }

        proratedAssetRent: { type: number, example: 174194 }

        proratedServiceFee: { type: number, example: 145161 }

        finalUtilityFee: { type: number, example: 485000 }

        damagePenaltyFee: { type: number, example: 250000 }

        unpaidPriorBalance: { type: number, example: 0 }

        grossObligation: { type: number, example: 4828549 }

        depositHeld: { type: number, example: 6500000 }

        depositApplied: { type: number, example: 4828549 }

        netSettlementBalance: { type: number, example: \-1671451, description: "\< 0 means Landlord refunds surplus deposit; \> 0 means Tenant owes extra" }

        settlementAction:

          type: string

          enum: \[COLLECT\_ADDITIONAL\_FROM\_TENANT, REFUND\_SURPLUS\_TO\_TENANT, EXACT\_ZERO\_SETTLEMENT\]

          example: "REFUND\_SURPLUS\_TO\_TENANT"

    VietQrWebhookPayloadDto:

      type: object

      required: \[bankReferenceCode, invoiceCode, amountPaid, paidAt\]

      properties:

        bankReferenceCode: { type: string, example: "FT26289918273" }

        invoiceCode: { type: string, example: "INV-202610-P302" }

        amountPaid: { type: number, example: 7450000 }

        paidAt: { type: string, format: date-time }

    Rfc7807ErrorEnvelope:

      type: object

      required: \[success, statusCode, errorCode, message, traceId, timestamp, path\]

      properties:

        success: { type: boolean, example: false }

        statusCode: { type: integer, example: 400 }

        errorCode: { type: string, example: "METER\_READING\_DECREASE\_ILLEGAL" }

        message: { type: string, example: "Current electricity reading (1400) cannot be lower than previous reading (1420.5) unless isMeterReset is flagged." }

        details:

          type: array

          nullable: true

          items:

            type: object

            properties:

              field: { type: string, example: "currPowerIndex" }

              issue: { type: string, example: "Must be \>= 1420.5" }

        traceId: { type: string, example: "0af7651916cd43dd8448eb211c80319c" }

        timestamp: { type: string, format: date-time, example: "2026-10-16T09:16:00.000Z" }

        path: { type: string, example: "/api/v1/metering/records" }

  responses:

    BadRequestError:

      description: Validation failure or business rule violation (RFC 7807)\[cite: 2, 4, 7\]

      content:

        application/json:

          schema:

            \$ref: '\#/components/schemas/Rfc7807ErrorEnvelope'

    UnauthorizedError:

      description: Missing or expired Bearer JWT token (RFC 7807)\[cite: 2, 4\]

      content:

        application/json:

          schema:

            \$ref: '\#/components/schemas/Rfc7807ErrorEnvelope'

    NotFoundError:

      description: Target resource does not exist in active building scope (RFC 7807)\[cite: 4, 7\]

      content:

        application/json:

          schema:

            \$ref: '\#/components/schemas/Rfc7807ErrorEnvelope'

    ConflictError:

      description: Idempotency lock in progress (409) or PostgreSQL unique constraint collision (23505)\[cite: 2, 4, 7\]

      content:

        application/json:

          schema:

            \$ref: '\#/components/schemas/Rfc7807ErrorEnvelope'

---

## 3\. NestJS Swagger Governance & Controller Implementation (`src/infrastructure/swagger/`)

### 3.1 Segmented OpenAPI Bootstrap (`swagger.setup.ts`)

This configuration builds separated Swagger UI portals for Admin/Managers, Guards, and External/Tenant integrations while injecting global header requirements (`X-Building-ID`, `BearerAuth`):

// src/infrastructure/swagger/swagger.setup.ts

import { INestApplication } from '@nestjs/common';

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { PropertiesModule } from '../../modules/properties/properties.module';

import { AssetsModule } from '../../modules/assets/assets.module';

import { TenantsModule } from '../../modules/tenants/tenants.module';

import { ContractsModule } from '../../modules/contracts/contracts.module';

import { BillingModule } from '../../modules/billing/billing.module';

import { ComplianceVnModule } from '../../modules/compliance-vn/compliance-vn.module';

import { MeteringModule } from '../../modules/metering/metering.module';

import { AuditModule } from '../audit/audit.module';

export function setupEnterpriseSwagger(app: INestApplication): void {

  // 1\. Admin, Property Manager & Accountant Portal (/api/docs/admin)

  const adminConfig \= new DocumentBuilder()

    .setTitle('Flat Rental Enterprise API — Admin & Accounting Portal')

    .setDescription('Backoffice API for 80-room management, prorated settlements & 2026 Vietnam statutory tax/residency exports.')

    .setVersion('1.2.0')

    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'BearerAuth')

    .addGlobalParameters({

      name: 'X-Building-ID',

      in: 'header',

      required: true,

      description: 'Building UUID for PostgreSQL RLS isolation',

      schema: { type: 'string', format: 'uuid' },

    })

    .build();

  const adminDocument \= SwaggerModule.createDocument(app, adminConfig, {

    include: \[

      PropertiesModule,

      AssetsModule,

      TenantsModule,

      ContractsModule,

      BillingModule,

      ComplianceVnModule,

      AuditModule,

    \],

  });

  SwaggerModule.setup('api/docs/admin', app, adminDocument, {

    swaggerOptions: { persistAuthorization: true },

  });

  // 2\. Guard Mobile Metering Portal (/api/docs/guard)

  const guardConfig \= new DocumentBuilder()

    .setTitle('Flat Rental Enterprise API — Guard Metering Mobile App')

    .setDescription('Restricted API for S3 Presigned PUT photo uploads and manual water/electricity meter ingestion.')

    .setVersion('1.2.0')

    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'BearerAuth')

    .build();

  const guardDocument \= SwaggerModule.createDocument(app, guardConfig, {

    include: \[MeteringModule\],

  });

  SwaggerModule.setup('api/docs/guard', app, guardDocument);

}
