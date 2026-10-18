# Document 04: OpenAPI / Swagger Specification (`04-Swagger-API.md`)

This document defines the enterprise **OpenAPI 3.0.3** contract for the 80-room flat rental management platform. It aligns every endpoint, header, payload projection, and error contract with the supporting infrastructure in `01-Supporting-Modules.md`, the domain services in `02-Core-Modules.md`, and the normalized TypeORM PostgreSQL schema in `03-Database.md`.

---

## 1\. Enterprise API Governance & Architectural Conventions

### 1.1 Segmented Swagger Portals (`SwaggerModule` \+ `VersioningModule`)

To prevent exposing internal management endpoints to mobile clients, `SwaggerModule` generates three isolated OpenAPI specifications under URI versioning (`/api/v1/...`) with RFC 8594 `Deprecation` and `Sunset` header support:

1. **Admin & Backoffice Portal (`/api/docs/admin`):** For `LANDLORD`, `PROPERTY_MANAGER`, and `ACCOUNTANT` roles (Room management, contract activation, mid-month checkout settlements, 2026 tax exports, and scoped WORM audit logs).  
     
2. **Guard Mobile Metering Portal (`/api/docs/guard`):** For `GUARD` role (Missing meter checklist, 15-minute S3 Presigned `PUT` URL generation, and manual water/electricity reading submission).  
     
3. **Tenant Self-Service & Webhook Portal (`/api/docs/external`):** For `TENANT` role (sign-in, own room, own invoices) and external VietQR banking webhooks.

4. **Public Listing Portal (`/api/docs/public`):** For the public portfolio website — prospective tenants and students browsing buildings, room types, rooms by number and floor, vacancies and the equipment offered. No sign-in.

The `Identity & Authentication` endpoints (`/auth/*`) appear in the admin, guard and external portals; `/users` only in the admin portal. The portfolio site uses the public portal for browsing and the normal `/auth/*` + admin endpoints for its management area (sign-in required).

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

### 1.4 Authentication & Session Model (`IdentityModule`)

Sign-in uses the **phone number**, not email. The rules below apply to every role; the endpoints are in the `Identity & Authentication` tag.

| Topic | Rule |
| :-- | :-- |
| Login identifier | Phone number normalised to E.164 before any lookup: `0901 234 567`, `84901234567` and `+84 90 123 4567` all become `+84901234567`. Vietnamese mobile prefixes are validated strictly; other countries are accepted in E.164 form (foreign tenants). |
| Password | argon2id (m = 19 MiB, t = 2, p = 1). 10–128 characters; must not contain the phone number's last 6 digits; rejected if it is on the common-password list → `422 AUTH_PASSWORD_POLICY_VIOLATION` with the failed rules in `details`. |
| Second factor | `LANDLORD` and `ACCOUNTANT` (finance roles, `AUTH_MFA_ROLES`) confirm every login with a 6-digit OTP: `POST /auth/login` answers `202` with a `challengeId`, `POST /auth/login/mfa` returns the tokens. |
| OTP | Random 6 digits, stored only as HMAC-SHA256 in Redis; 5-minute lifetime, 5 attempts (then the challenge is burned), 60-second resend cooldown, 5 activation / reset codes and 20 login codes per phone per day. Sent by SMS, or through Zalo first when the account is linked to a Zalo user. Local / test only: `AUTH_OTP_DEBUG_ECHO=true` returns the code as `debugCode` (refused in production). Purposes: `LOGIN_MFA`, `ACTIVATE_ACCOUNT`, `RESET_PASSWORD`. |
| Access token | JWT, 15 minutes. Claims: `sub`, `sid` (session id), `phoneMasked`, `buildingId`, `buildingIds`, `roles`, `typ = access`, `jti`. No raw phone or ID number inside the token. |
| Refresh token | Opaque `<sessionId>.<256-bit secret>`; only its HMAC-SHA256 (keyed with `JWT_REFRESH_SECRET`) is stored (`auth_sessions.refresh_token_hash`). Rotated on every use. Presenting an already-rotated token revokes the whole session (`401 AUTH_REFRESH_TOKEN_REUSED`) and notifies the account owner. Idle expiry 7 days, absolute expiry 30 days. |
| Revocation | Logout, logout-all, password change / reset, account disable, access reduction and reuse detection set `auth_sessions.revoked_at`. The Redis key `auth:revoked-sid:{sid}` (TTL = access-token lifetime) makes access tokens of that session fail at once with `401 AUTH_SESSION_REVOKED`. |
| Brute force | `@ThrottleSensitive()` per IP on every public `/auth/*` route, plus 5 wrong passwords for one phone number within 15 minutes → locked for 15 minutes, doubling up to 24 hours (`423 AUTH_ACCOUNT_LOCKED`, `Retry-After`). |
| No account enumeration | Wrong password, unknown phone number and not-yet-activated account all return the same `401 AUTH_CREDENTIALS_INVALID`; unknown numbers are checked against a dummy hash (same timing) and count towards the lock. `POST /auth/otp/request` always answers `202`. |
| Tenant accounts | Created automatically (`PENDING_ACTIVATION`, role `TENANT`) for every **adult occupant with a phone number** when they move in, and linked to their person profile (`tenants.user_id`). The tenant activates with an OTP and chooses a password. After moving out the account keeps read access to its own history (invoices, settlement) but loses room access immediately. |
| Staff accounts | Created by the landlord (`POST /users`) with roles and building access. Role or building changes evict `permissions:user:{id}`; reducing access or disabling the account also revokes the user's sessions. |
| Tenant room access | A `TENANT` can open **only the room they currently live in**: `GET /properties/rooms/mine`, or `GET /properties/rooms/{id}` for that same room. Any other room → `403 AUTH_FORBIDDEN_RESOURCE`; the same room after moving out → `403`. Tenants have no access to the room list or vacancy summary. |


### 1.5 Public Listing (`/public/*`, portfolio website)

The portfolio website shows prospective tenants and students what is on offer **without signing in**; its management area uses the authenticated endpoints. Public endpoints are read-only and follow these rules:

| Topic | Rule |
| :-- | :-- |
| Access | `@Public()` — no token, no `X-Building-ID`. A building is addressed by its **public slug** (`/public/buildings/sunrise-quan-7`), rooms by their **room number** (`/rooms/P.302`), room types by **code**. Internal UUIDs are never returned. |
| What is published | Only buildings with `isPubliclyListed = true` and a `publicSlug`, and only their rooms with `isPubliclyListed = true` (default). Anything else answers the same `404 RES_NOT_FOUND` as an unknown slug — unpublished buildings cannot be discovered. |
| What is shown | Building name, address, description, floors; room number, floor, room type, area, capacity, monthly rent (price override or base rent), **availability** (`AVAILABLE` / `UNAVAILABLE`); room types with base rent and counts; vacancy counts per room type and per floor; equipment of a room (name, category, condition grade, monthly fee); the equipment catalogue with standard fees; utility terms (electricity billing mode, water rate per m³) and the 1-month deposit rule. |
| Never shown | Occupants, tenants, contracts, why a room is unavailable (`RESERVED` / `OCCUPIED` / `MAINTENANCE` all become `UNAVAILABLE`), serial numbers, replacement values, landlord name, tax code, bank account, internal ids, audit data. |
| Isolation | The slug is resolved on the global `buildings` table; every room / asset query then runs in **that building's** RLS transaction and filters `building_id` explicitly, exactly like the authenticated endpoints. |
| Caching | Server: `cache:{buildingId}:public:*` (XFetch + single-flight, 300 s), tagged `public` / `rooms` / `catalogs` / `assets`: building settings evict `public`, rooms `rooms`, room types `catalogs`, catalogue items and installed units `assets` — every staff change refreshes the public site at once. Client / CDN: `Cache-Control: public, max-age=60, stale-while-revalidate=300` with a weak `ETag`; `If-None-Match` → `304`. |
| Abuse protection | Per-IP throttling: `@ThrottlePublic()` (`THROTTLE_LIMIT`, 60 / min) on detail endpoints, `@ThrottleSearch()` (100 / min) on the room search. `limit` ≤ 50. |
| Kill switch | Feature flag `public_listing` (`@RequireFeature`), **on by default** (code default, overridable by `FEATURE_FLAGS` or Redis) → `404 RES_FEATURE_DISABLED` for every `/public/*` route when switched off; the management API is unaffected. |
| CORS | The portfolio origin must be in `ALLOWED_ORIGINS`. |
| Publishing | Landlord: `PATCH /properties/buildings/{id}` with `isPubliclyListed`, `publicSlug`, `publicDescription`. Manager: `PATCH /properties/rooms/{id}` with `isPubliclyListed` to hide one room. |

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

  \- name: Public Listing

    description: Read-only portfolio website endpoints (no sign-in) - published buildings, room types, rooms by number and floor, vacancies, equipment

  \- name: Identity & Authentication

    description: Phone-number sign-in, OTP second factor, account activation & password reset, refresh-token rotation, sessions and staff accounts

  \- name: Properties & Room Directory

    description: Index-backed 80-room listing, single-query room details, and XFetch cached vacancy summary\[cite: 4, 6, 7\]

  \- name: Assets & Furniture Catalog

    description: Rentable appliances and furniture inventory, serial numbers, and room assignments\[cite: 3, 5, 6\]

  \- name: Tenants & PDPL Privacy

    description: Encrypted tenant profiles (AES-256-GCM), HMAC blind-index lookups, and Law 91/2025 consent\[cite: 2, 4, 5\]

  \- name: Contracts & 1-Month Deposit Escrow

    description: Lease activation, shared occupancy (every occupant's CCCD & residence), contract-holder transfer, extra fees, and deposit ledger\[cite: 3, 5, 6\]

  - name: Service Catalogue

    description: Per-building extra services (Wi-Fi, parking per vehicle type, sanitation per person) used by contracts

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

```yaml
  # ===========================================================================
  # 1b. IDENTITY & AUTHENTICATION (phone number + password, OTP, sessions)
  #     No X-Building-ID: users, roles and sessions are global (document 03, 3.0)
  # ===========================================================================
  /auth/login:
    post:
      tags: [Identity & Authentication]
      summary: Sign in with phone number and password
      security: []
      description: |
        - `@Public()` + `@ThrottleSensitive()`. The phone number is normalised to E.164 before lookup.
        - Wrong password, unknown number and not-yet-activated account all return `401 AUTH_CREDENTIALS_INVALID`.
        - 5 wrong passwords for one number in 15 minutes lock it (15 minutes, doubling up to 24 hours).
        - `LANDLORD` / `ACCOUNTANT`: answers `202` with an OTP challenge instead of tokens.
        - Success creates an `auth_sessions` row (device, IP, user agent) and returns an access + refresh token pair.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/LoginDto' }
      responses:
        '200': { $ref: '#/components/responses/TokenPairResponse' }
        '202':
          description: Password accepted; a 6-digit OTP was sent (finance roles)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/MfaChallengeDto' }
        '400': { $ref: '#/components/responses/BadRequestError' }        # REQ_VALIDATION_ERROR (not a phone number)
        '401': { $ref: '#/components/responses/UnauthorizedError' }      # AUTH_CREDENTIALS_INVALID
        '403': { $ref: '#/components/responses/ForbiddenError' }         # AUTH_ACCOUNT_DISABLED (correct password only)
        '423': { $ref: '#/components/responses/LockedError' }            # AUTH_ACCOUNT_LOCKED
        '429': { $ref: '#/components/responses/TooManyRequestsError' }   # SEC_RATE_LIMIT_EXCEEDED

  /auth/login/mfa:
    post:
      tags: [Identity & Authentication]
      summary: Complete a finance-role login with the OTP
      security: []
      description: |
        - The challenge is bound to the user, the device and the IP address that passed the password step.
        - 5 wrong codes burn the challenge (`429 AUTH_OTP_TOO_MANY_ATTEMPTS`); the user must log in again.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/VerifyLoginOtpDto' }
      responses:
        '200': { $ref: '#/components/responses/TokenPairResponse' }
        '400': { $ref: '#/components/responses/BadRequestError' }        # AUTH_OTP_INVALID, AUTH_OTP_EXPIRED
        '429': { $ref: '#/components/responses/TooManyRequestsError' }   # AUTH_OTP_TOO_MANY_ATTEMPTS

  /auth/refresh:
    post:
      tags: [Identity & Authentication]
      summary: Exchange a refresh token for a new token pair (rotation)
      security: []
      description: |
        - The presented refresh token is invalidated and a new one is returned on every call.
        - Re-using an already-rotated refresh token revokes the whole session (`401 AUTH_REFRESH_TOKEN_REUSED`)
          and sends a security alert to the account owner — the token is assumed stolen.
        - Expired (7 days idle / 30 days absolute) or revoked sessions → `401 AUTH_SESSION_REVOKED`.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RefreshTokenDto' }
      responses:
        '200': { $ref: '#/components/responses/TokenPairResponse' }
        '401': { $ref: '#/components/responses/UnauthorizedError' }      # AUTH_TOKEN_INVALID, AUTH_SESSION_REVOKED, AUTH_REFRESH_TOKEN_REUSED

  /auth/otp/request:
    post:
      tags: [Identity & Authentication]
      summary: Send an OTP to activate an account or reset a password
      security: []
      description: |
        - Always answers `202`, whether or not the number has an account in the right state (no enumeration).
          A code is sent only when the purpose fits (`ACTIVATE_ACCOUNT` → `PENDING_ACTIVATION`,
          `RESET_PASSWORD` → `ACTIVE`).
        - Cooldown (60 s) and daily cap (5) apply per number, registered or not → `429 AUTH_OTP_RATE_LIMITED`.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RequestOtpDto' }
      responses:
        '202':
          description: Accepted. If the number qualifies, an OTP is on its way
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/OtpRequestAcceptedDto' }
        '400': { $ref: '#/components/responses/BadRequestError' }
        '429': { $ref: '#/components/responses/TooManyRequestsError' }   # AUTH_OTP_RATE_LIMITED, SEC_RATE_LIMIT_EXCEEDED

  /auth/activate:
    post:
      tags: [Identity & Authentication]
      summary: Activate an account with the OTP and choose a password (signs the user in)
      security: []
      description: |
        - For tenant accounts created at move-in and staff accounts created by the landlord.
        - Sets `phone_verified_at`, `status = ACTIVE`, stores the argon2id hash and returns a token pair.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ActivateAccountDto' }
      responses:
        '200': { $ref: '#/components/responses/TokenPairResponse' }
        '400': { $ref: '#/components/responses/BadRequestError' }        # AUTH_OTP_INVALID, AUTH_OTP_EXPIRED
        '422': { description: AUTH_PASSWORD_POLICY_VIOLATION }
        '429': { $ref: '#/components/responses/TooManyRequestsError' }   # AUTH_OTP_TOO_MANY_ATTEMPTS

  /auth/password/reset:
    post:
      tags: [Identity & Authentication]
      summary: Reset a forgotten password with the OTP
      security: []
      description: |
        - Revokes **every** session of the account and clears the login lock for that number.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ResetPasswordDto' }
      responses:
        '204': { description: Password reset; sign in again }
        '400': { $ref: '#/components/responses/BadRequestError' }        # AUTH_OTP_INVALID, AUTH_OTP_EXPIRED
        '422': { description: AUTH_PASSWORD_POLICY_VIOLATION }
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /auth/password/change:
    post:
      tags: [Identity & Authentication]
      summary: Change the password of the signed-in user
      description: |
        - Requires the current password (a wrong one counts towards the login lock).
        - Keeps the current session and revokes all the others.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ChangePasswordDto' }
      responses:
        '204': { description: Password changed }
        '401': { $ref: '#/components/responses/UnauthorizedError' }      # AUTH_CREDENTIALS_INVALID
        '422': { description: AUTH_PASSWORD_POLICY_VIOLATION }

  /auth/logout:
    post:
      tags: [Identity & Authentication]
      summary: Sign out of the current session
      responses:
        '204': { description: Session revoked; its access token stops working immediately }
        '401': { $ref: '#/components/responses/UnauthorizedError' }

  /auth/logout-all:
    post:
      tags: [Identity & Authentication]
      summary: Sign out of every device
      responses:
        '204': { description: All sessions of the user revoked }
        '401': { $ref: '#/components/responses/UnauthorizedError' }

  /auth/me:
    get:
      tags: [Identity & Authentication]
      summary: Who am I — profile, roles, buildings, permissions and (tenants) current room
      description: |
        - `residence` is filled for a `TENANT` who currently lives in a room of the active building, else `null`.
        - The phone number is always masked.
      responses:
        '200':
          description: Current user
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/MeDto' }
        '401': { $ref: '#/components/responses/UnauthorizedError' }

  /auth/sessions:
    get:
      tags: [Identity & Authentication]
      summary: List my active sessions (devices)
      responses:
        '200':
          description: Active sessions, most recently used first; `current` marks the calling session
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/SessionDto' } }
        '401': { $ref: '#/components/responses/UnauthorizedError' }

  /auth/sessions/{sessionId}:
    delete:
      tags: [Identity & Authentication]
      summary: Sign out one of my devices
      parameters:
        - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '204': { description: Session revoked }
        '404': { $ref: '#/components/responses/NotFoundError' }          # not one of the caller's sessions

  /users:
    post:
      tags: [Identity & Authentication]
      summary: Create a staff account (landlord only)
      description: |
        - `users:manage:global`. Roles `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT`, `GUARD`; building access limited
          to the landlord's own buildings. `TENANT` accounts are never created here — they come from occupancy.
        - The account starts `PENDING_ACTIVATION` and an invitation SMS is sent; the person then requests an
          `ACTIVATE_ACCOUNT` code (`POST /auth/otp/request`) and chooses a password (`POST /auth/activate`).
        - A phone number that already has an account → `409 RES_ALREADY_EXISTS` (one account per person).
      parameters:
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateUserDto' }
      responses:
        '201':
          description: Account created and invitation sent
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/UserDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # RES_ALREADY_EXISTS
    get:
      tags: [Identity & Authentication]
      summary: List accounts with access to the landlord's buildings
      parameters:
        - { name: role, in: query, required: false, schema: { type: string, enum: [LANDLORD, PROPERTY_MANAGER, ACCOUNTANT, GUARD, TENANT] } }
        - { name: status, in: query, required: false, schema: { type: string, enum: [PENDING_ACTIVATION, ACTIVE, DISABLED] } }
        - { name: buildingId, in: query, required: false, schema: { type: string, format: uuid } }
        - { name: page, in: query, required: false, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200':
          description: Paginated accounts (phone numbers masked)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/UserDto' } }
        '403': { $ref: '#/components/responses/ForbiddenError' }

  /users/{id}:
    get:
      tags: [Identity & Authentication]
      summary: One account (staff or tenant) of the landlord's buildings
      description: |
        `users:read:global` (landlord). An account sharing no building with the caller → `404` (never reveals that it exists).
        Building ids outside the caller's buildings are not listed.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Account
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/UserDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }
        '404': { $ref: '#/components/responses/NotFoundError' }
    patch:
      tags: [Identity & Authentication]
      summary: Change a staff account's roles, buildings or status (landlord only)
      description: |
        - Evicts `permissions:user:{id}`. Removing a role or building, or `status = DISABLED`, also revokes the user's sessions.
        - Refused (`409 RES_CONFLICT`) when it would disable or demote the caller, or leave a building without a `LANDLORD`.
        - A `TENANT` account's room access is driven by occupancy, not by this endpoint.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateUserDto' }
      responses:
        '200':
          description: Account updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/UserDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # RES_CONFLICT, RES_CONCURRENCY_CONFLICT
```

  \# \===========================================================================

  \# 2\. PROPERTIES & ROOM DIRECTORY (OPTIMIZATION MANDATES \#1, \#2, \#3, \#4)

  \# \===========================================================================

```yaml
  # ===========================================================================
  # 1c. PUBLIC LISTING (portfolio website, no sign-in) - document 04, section 1.5
  # ===========================================================================
  /public/buildings:
    get:
      tags: [Public Listing]
      summary: Published buildings with their price range and free rooms
      security: []
      responses:
        '200':
          description: Published buildings ordered by name
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicBuildingSummaryDto' } }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}:
    get:
      tags: [Public Listing]
      summary: One published building - address, description, floors, room types, utility terms
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
      responses:
        '200':
          description: Building profile
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/PublicBuildingDto' }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/room-types:
    get:
      tags: [Public Listing]
      summary: Room types with base rent, area, capacity and how many are free
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
      responses:
        '200':
          description: Room types ordered by base rent
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicRoomTypeDto' } }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/floors:
    get:
      tags: [Public Listing]
      summary: Floors (levels) with their room numbers and free-room counts
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
      responses:
        '200':
          description: Floors in ascending order
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicFloorDto' } }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/rooms:
    get:
      tags: [Public Listing]
      summary: Search published rooms (room number, floor, type, price, area, capacity, availability)
      description: |
        - `@ThrottleSearch()`. Same indexes as the staff directory (`idx_rooms_bld_status_type`, `idx_rooms_bld_floor_status`,
          `idx_rooms_available_covering` for `availability=AVAILABLE`).
        - `availability` is `AVAILABLE` or `UNAVAILABLE`; the reason a room is unavailable is never disclosed.
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
        - { name: roomType, in: query, required: false, schema: { type: string, example: STUDIO }, description: Room type code }
        - { name: floor, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 30 } }
        - { name: availability, in: query, required: false, schema: { type: string, enum: [AVAILABLE, UNAVAILABLE] } }
        - { name: minPrice, in: query, required: false, schema: { type: integer, minimum: 0 }, description: VND per month }
        - { name: maxPrice, in: query, required: false, schema: { type: integer, minimum: 0 } }
        - { name: minAreaSqm, in: query, required: false, schema: { type: number, minimum: 0 } }
        - { name: occupants, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 20 }, description: Rooms that fit at least this many people }
        - { name: sortBy, in: query, required: false, schema: { type: string, enum: [monthlyRent, floor, roomNumber, areaSqm], default: roomNumber } }
        - { name: sortOrder, in: query, required: false, schema: { type: string, enum: [ASC, DESC], default: ASC } }
        - { name: page, in: query, required: false, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
      responses:
        '200':
          description: Paginated rooms (meta.pagination)
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicRoomListItemDto' } }
        '400': { $ref: '#/components/responses/BadRequestError' }        # e.g. minPrice > maxPrice
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/rooms/{roomNumber}:
    get:
      tags: [Public Listing]
      summary: One room by its number - type, floor, area, capacity, rent, availability and equipment
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
        - { name: roomNumber, in: path, required: true, schema: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$' }, example: P.302, description: Case-insensitive }
      responses:
        '200':
          description: Room profile
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/PublicRoomDetailDto' }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/vacancies:
    get:
      tags: [Public Listing]
      summary: Free rooms per room type
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
      responses:
        '200':
          description: Vacancy counts (published rooms only, no occupancy percentage)
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicVacancyDto' } }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }

  /public/buildings/{slug}/assets:
    get:
      tags: [Public Listing]
      summary: Equipment & furniture offered for rent, with standard monthly fees
      security: []
      parameters:
        - { name: slug, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, example: sunrise-quan-7 }
        - { name: category, in: query, required: false, schema: { type: string, enum: [APPLIANCE, FURNITURE] } }
      responses:
        '200':
          description: Catalogue items with the number of published rooms equipped
          headers: { Cache-Control: { $ref: '#/components/headers/PublicCacheControl' } }
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/PublicAssetDto' } }
        '304': { description: Not modified (If-None-Match matched the ETag) }
        '404': { $ref: '#/components/responses/NotFoundError' }          # unknown or unpublished building / room; RES_FEATURE_DISABLED when public_listing is off
        '429': { $ref: '#/components/responses/TooManyRequestsError' }
```

```yaml
  /properties/buildings:
    get:
      tags: [Properties & Room Directory]
      summary: Buildings the landlord manages (with tax and bank settings)
      description: |
        - `buildings:read:global` (LANDLORD). Only buildings in the caller's `user_building_access`; no `X-Building-ID` needed.
        - Staff see the names of their buildings in `GET /auth/me`.
      responses:
        '200':
          description: The caller's buildings, by code
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/BuildingDto' } }
        '403': { $ref: '#/components/responses/ForbiddenError' }
    post:
      tags: [Properties & Room Directory]
      summary: Register a building (landlord)
      description: |
        - `buildings:create:global`. The creator is granted access to the new building in the same transaction.
        - Access tokens list buildings at sign-in: call `POST /auth/refresh` to use the new building in `X-Building-ID`.
        - `code` is unique across the platform → `409 RES_ALREADY_EXISTS`.
      parameters:
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateBuildingDto' }
      responses:
        '201':
          description: Building registered
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/BuildingDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # RES_ALREADY_EXISTS (code)

  /properties/buildings/{id}:
    patch:
      tags: [Properties & Room Directory]
      summary: Update a building's address, tax, bank and billing settings (landlord)
      description: |
        - `buildings:update:global`, only for a building the caller can access (else `404`). `code` cannot change.
        - `totalRoomsCapacity` cannot go below the number of rooms already created → `409 BIZ_BUILDING_CAPACITY_EXCEEDED`.
        - Publishing on the portfolio site: `isPubliclyListed: true` requires a `publicSlug` (sent now or already set) → `400`;
          `publicSlug` is unique → `409 RES_ALREADY_EXISTS`. Evicts the building's public cache.
        - Optimistic lock with `version`.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateBuildingDto' }
      responses:
        '200':
          description: Building updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/BuildingDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # BIZ_BUILDING_CAPACITY_EXCEEDED, RES_CONCURRENCY_CONFLICT

  /properties/room-types:
    get:
      tags: [Properties & Room Directory]
      summary: Room types of the active building with their base rent
      description: |
        - `rooms:read:department`. Cached as `cache:{buildingId}:catalogs:pricing` (24 h), evicted through
          `tag:{buildingId}:catalogs` when a room type is created or changed.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      responses:
        '200':
          description: Room types ordered by base rent
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/RoomTypeDto' } }
    post:
      tags: [Properties & Room Directory]
      summary: Create a room type
      description: |
        - `rooms:create:department`. `code` unique per building → `409 RES_ALREADY_EXISTS`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateRoomTypeDto' }
      responses:
        '201':
          description: Room type created
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomTypeDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /properties/room-types/{id}:
    patch:
      tags: [Properties & Room Directory]
      summary: Change a room type (base rent, area, default capacity)
      description: |
        - `rooms:update:department`. A new base rent applies to new contracts and to rooms without `priceOverride`;
          active contracts keep their agreed rent. Evicts `tag:{buildingId}:catalogs` and `tag:{buildingId}:rooms`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateRoomTypeDto' }
      responses:
        '200':
          description: Room type updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomTypeDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # RES_CONCURRENCY_CONFLICT
```

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

```yaml
    post:
      tags: [Properties & Room Directory]
      summary: Create a room in the active building
      description: |
        - `rooms:create:department`. `roomNumber` unique per building → `409 RES_ALREADY_EXISTS`.
        - Never more rooms than `buildings.totalRoomsCapacity` (default 80) → `409 BIZ_BUILDING_CAPACITY_EXCEEDED`;
          the building row is locked while counting, so two simultaneous creations cannot both take the last slot.
        - The room type must belong to the same building (composite FK) → `404` otherwise.
        - `maxOccupants` defaults to the room type's `defaultMaxOccupants`; new rooms start `AVAILABLE`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateRoomDto' }
      responses:
        '201':
          description: Room created
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomDetailDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }          # room type not in this building
        '409': { $ref: '#/components/responses/ConflictError' }          # RES_ALREADY_EXISTS, BIZ_BUILDING_CAPACITY_EXCEEDED
```

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

```yaml
  /properties/rooms/mine:
    get:
      tags: [Properties & Room Directory]
      summary: The room the signed-in tenant currently lives in
      description: |
        - `TENANT` (`rooms:read:own`). The room is found from the caller's own active occupancy in the active building
          (`OCCUPANCY_SELF_SCOPE`), so the app needs no room id.
        - Same projection as `GET /properties/rooms/{id}`; other occupants appear only as counts.
        - Declared before `/{id}` so `mine` is never parsed as a UUID.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      responses:
        '200':
          description: The caller's room
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomDetailDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }         # not a tenant (staff use /{id})
        '404': { description: 'BIZ_NO_ACTIVE_ROOM — the caller does not live in a room of this building (never moved in, or moved out)' }
```

  /properties/rooms/{id}:

    get:

      tags: \[Properties & Room Directory\]

      summary: Get single-query room detail profile\[cite: 3, 7\]

      description: |

        \- \*\*Optimization \#2 (Zero N+1):\*\* Resolves room metadata, room type, active lease contract, primary tenant,

          co-occupant headcount, and all assigned rental appliances (\`room\_assets\`) in a single TypeORM query\[cite: 3, 6, 7\].

        \- \*\*Who can open which room:\*\* staff with \`rooms:read:department\` can open any room of the active building.

          A \`TENANT\` (\`rooms:read:own\`) can open only the room they currently live in: the room is

          accessible only when their linked person profile is an \`ACTIVE\` occupant of the room's \`ACTIVE\` contract (\`RoomAccessGuard\`).

          Any other room, or the same room after moving out, returns \`403 AUTH\_FORBIDDEN\_RESOURCE\`.

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

        '403': { $ref: '#/components/responses/ForbiddenError' }   # TENANT opening a room they do not live in

        '404':

          \$ref: '\#/components/responses/NotFoundError'

```yaml
    patch:
      tags: [Properties & Room Directory]
      summary: Change a room's price, status, type or physical data
      description: |
        - `rooms:update:department`. Under the lock `lock:{buildingId}:room:contract:{id}` (shared with contract
          activation) plus optimistic `version`.
        - Manual statuses: `AVAILABLE`, `RESERVED`, `MAINTENANCE`. `OCCUPIED` is set only by contracts; an `OCCUPIED`
          room's status cannot be changed by hand → `409 BIZ_ROOM_STATUS_TRANSITION_INVALID`.
        - `priceOverride: null` returns the room to its room type's base rent. Active contracts keep their agreed rent.
        - `isPubliclyListed: false` hides the room from the portfolio site (default `true`).
        - Status changes publish `room.status_changed` (outbox → realtime `room.status_changed` to the building's dashboards);
          any change evicts `tag:{buildingId}:rooms`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateRoomDto' }
      responses:
        '200':
          description: Room updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomDetailDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }          # BIZ_ROOM_STATUS_TRANSITION_INVALID, RES_LOCKED, RES_CONCURRENCY_CONFLICT
```

  \# \===========================================================================

  \# 3\. ASSETS & APPLIANCE RENTAL CATALOG

  \# \===========================================================================

```yaml
  /assets:
    get:
      tags: [Assets & Furniture Catalog]
      summary: Appliance & furniture catalogue of the active building
      description: |
        - `assets:read:department`. Each item with the number of units installed in rooms.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: category, in: query, required: false, schema: { type: string, enum: [APPLIANCE, FURNITURE] } }
      responses:
        '200':
          description: Catalogue ordered by category and name
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/AssetDto' } }
    post:
      tags: [Assets & Furniture Catalog]
      summary: Add a catalogue item
      description: |
        - `assets:create:department`. `code` unique per building → `409 RES_ALREADY_EXISTS`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateAssetDto' }
      responses:
        '201':
          description: Item added
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/AssetDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /assets/{id}:
    patch:
      tags: [Assets & Furniture Catalog]
      summary: Change a catalogue item (name, standard fee, replacement value)
      description: |
        - `assets:update:department`. The standard fee is only the default for new installations; installed units keep
          their own `customMonthlyFee`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateAssetDto' }
      responses:
        '200':
          description: Item updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/AssetDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /assets/room-assignments:
    get:
      tags: [Assets & Furniture Catalog]
      summary: Installed units of the building (inventory, QR / serial search)
      description: |
        - `assets:read:department`. Filters combine; ordered by room number, then serial; paged.
        - `serialNumber` matches any part of the serial (case-insensitive; `_` and `%` are literal).
        - `rentedUnderContractId` = the draft or active contract renting the unit (it cannot be moved or removed meanwhile).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: roomId, in: query, required: false, schema: { type: string, format: uuid } }
        - { name: assetId, in: query, required: false, schema: { type: string, format: uuid } }
        - { name: serialNumber, in: query, required: false, schema: { type: string, minLength: 2, maxLength: 100 } }
        - { name: conditionGrade, in: query, required: false, schema: { type: string, enum: [GRADE_A_NEW, GRADE_B_GOOD, GRADE_C_FAIR, BROKEN] } }
        - { name: page, in: query, required: false, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200':
          description: Installed units
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/RoomAssetDto' } }
    post:
      tags: [Assets & Furniture Catalog]
      summary: Install a serial-numbered appliance or furniture item in a room
      description: |
        - `assets:create:department`. Room and catalogue item must belong to the active building (composite FKs) → `404`.
        - `serialNumber` is unique per building among installed units → `409 RES_ALREADY_EXISTS`.
        - `customMonthlyFee` defaults to the item's `standardMonthlyRentalFee`; `installedDate` to today (Vietnam time).
        - Room detail is never cached, so the new unit shows up there at once.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AssignRoomAssetDto' }
      responses:
        '201':
          description: Unit installed in the room
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomAssetDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /assets/room-assignments/{id}:
    patch:
      tags: [Assets & Furniture Catalog]
      summary: Re-grade an installed unit, change its fee or move it to another room
      description: |
        - `assets:update:department`. Moving keeps the unit's history (same row, new `roomId`).
        - Units rented under an active contract (`contract_assets`, module 3) cannot be moved → `409`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateRoomAssetDto' }
      responses:
        '200':
          description: Unit updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/RoomAssetDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }
    delete:
      tags: [Assets & Furniture Catalog]
      summary: Remove an installed unit (disposed, sold, returned)
      description: |
        - `assets:delete:department`. Soft delete: the unit stays in history and its serial number can be installed again.
        - Units rented under an active contract (module 3) cannot be removed → `409`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '204': { description: Unit removed }
        '404': { $ref: '#/components/responses/NotFoundError' }
```

  \# \===========================================================================

  \# 4\. TENANTS & PERSONAL DATA PROTECTION (LAW 91/2025/QH15)

  \# \===========================================================================

```yaml
  /tenants:
    post:
      tags: [Tenants & PDPL Privacy]
      summary: Register one person (holder, roommate or child) - encrypted ID number + blind index
      description: |
        - `tenants:create:department`. Every occupant needs a profile: contract holder, each roommate, each child.
        - ID number normalised (spaces, dots, dashes removed, upper-case). CCCD / child's personal ID: 12 digits whose
          digit 4 (gender + century) and digits 5-6 (birth year) must match `gender` and `dateOfBirth`; only for
          nationality `VN`. Passport: 6-12 letters / digits with at least one digit.
        - Encrypted with AES-256-GCM; `id_card_hash` (HMAC-SHA256) detects duplicates without decrypting →
          `409 BIZ_TENANT_ID_CARD_DUPLICATE` with the existing profile id (reuse it when the person changes rooms).
        - Consent is mandatory (`422 BIZ_PDPL_CONSENT_REQUIRED`). A child (under 18 on today's date, Vietnam time) needs
          `consentGuardianTenantId`: an adult profile of the same building with its own consent
          (`422 BIZ_TENANT_GUARDIAN_INVALID`). Adults need a phone number and no guardian.
        - Phone normalised to E.164 like the login phone, so the person's account is found at move-in.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateTenantDto' }
      responses:
        '201':
          description: Person registered (ID number masked)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/TenantDetailDto' }
        '400': { $ref: '#/components/responses/BadRequestError' }
        '409': { $ref: '#/components/responses/ConflictError' }        # BIZ_TENANT_ID_CARD_DUPLICATE
        '422': { description: 'BIZ_PDPL_CONSENT_REQUIRED, BIZ_TENANT_GUARDIAN_INVALID' }
    get:
      tags: [Tenants & PDPL Privacy]
      summary: Search people of the active building by name or phone
      description: |
        - `tenants:read:department`. `q` matches the name without diacritics ("nguyen" finds "Nguyễn") or, if it is a
          phone number, the exact normalised phone. ID numbers are never searchable here (use `/tenants/lookup`).
        - Masked IDs only; nothing is decrypted.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: q, in: query, required: false, schema: { type: string, minLength: 2, maxLength: 100 } }
        - { name: minor, in: query, required: false, schema: { type: boolean }, description: Only children (true) or only adults (false) }
        - { name: page, in: query, required: false, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200':
          description: People ordered by name (meta.pagination)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/TenantSafeResponseDto' } }

  /tenants/lookup:
    get:
      tags: [Tenants & PDPL Privacy]
      summary: Exact lookup by CCCD / personal ID / passport through the blind index
      description: |
        - `tenants:read:department`, `@ThrottleSearch()`. The number is normalised and HMAC-hashed; no row is decrypted.
        - Every lookup (found or not) is written to the audit log with the masked number.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: idCardNumber, in: query, required: true, example: "079099001234", schema: { type: string, maxLength: 20 } }
      responses:
        '200':
          description: Person found via idx_tenants_bld_id_hash_unique
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/TenantSafeResponseDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }

  /tenants/me:
    get:
      tags: [Tenants & PDPL Privacy]
      summary: The signed-in tenant's own profile (tenants:read:own)
      description: |
        - The profile linked to the caller's login (`tenants.user_id`) in the active building; `404` when there is none
          (the link is created at move-in, module 3).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      responses:
        '200':
          description: Own profile (ID and bank account masked)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/TenantDetailDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }

  /tenants/{id}:
    get:
      tags: [Tenants & PDPL Privacy]
      summary: One person's profile (masked)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Profile
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/TenantDetailDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
    patch:
      tags: [Tenants & PDPL Privacy]
      summary: Correct a person's data (contact, addresses, refund bank, ID document, guardian)
      description: |
        - `tenants:update:department`, optimistic `version`. The merged profile is validated with the same rules as
          creation; a new ID number is re-normalised, re-hashed and checked for duplicates (`409`).
        - `refundBankAccount: null` removes the refund account. Consent cannot be changed here.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateTenantDto' }
      responses:
        '200':
          description: Profile updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/TenantDetailDto' }
        '400': { $ref: '#/components/responses/BadRequestError' }
        '404': { $ref: '#/components/responses/NotFoundError' }
        '409': { $ref: '#/components/responses/ConflictError' }        # BIZ_TENANT_ID_CARD_DUPLICATE, RES_CONCURRENCY_CONFLICT
        '422': { description: BIZ_TENANT_GUARDIAN_INVALID }
```

  \# \===========================================================================

  \# 5\. CONTRACTS & 1-MONTH DEPOSIT ESCROW ("TIỀN ĐẶT CỌC")

  \# \===========================================================================

  /contracts:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: List contracts of the building (paged)
      description: |
        - `tenantId` matches the holder or anyone who lived in the room under the contract.
        - `endingBefore` lists active contracts ending on or before a date (renewal follow-up).
        - Ordered by start date (newest first), then contract code.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: status, in: query, required: false, schema: { type: string, enum: [DRAFT, ACTIVE, CANCELLED, TERMINATED, EXPIRED] } }
        - { name: roomId, in: query, required: false, schema: { type: string, format: uuid } }
        - { name: tenantId, in: query, required: false, schema: { type: string, format: uuid } }
        - { name: q, in: query, required: false, description: 'Part of the contract code or room number, case-insensitive (wildcards literal)', schema: { type: string, minLength: 2, maxLength: 50 } }
        - { name: endingBefore, in: query, required: false, schema: { type: string, format: date } }
        - { name: page, in: query, required: false, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200':
          description: Contract summaries
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/ContractSummaryDto' } }
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Create a DRAFT lease for a room (activation collects the deposit)
      description: |
        - Room must be AVAILABLE (or manually RESERVED) with no active or draft contract → becomes RESERVED.
        - The holder (`primaryTenantId`) must be eligible on `startDate`: adult, ID document, consent (`422 BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE`).
        - Holder + `coOccupants` ≤ `room.maxOccupants` (`409 BIZ_OCCUPANT_LIMIT_EXCEEDED`); each person needs a tenant profile.
        - `monthlyRoomRent` defaults to the room's effective rent, `depositAmount` to one month of rent.
        - Rented appliances must be installed in this room and not BROKEN; their fee is snapshotted.
        - Contract code `HD-{YYYY}/{NNN}-{room}`, unique per building.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateContractDto' }
      responses:
        '201':
          description: Draft created, room RESERVED
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractDto' }
        '404': { description: Room, person or installed unit not found in this building }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_ROOM_NOT_AVAILABLE, BIZ_OCCUPANT_LIMIT_EXCEEDED
        '422': { description: BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE }

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

```yaml
  # ===========================================================================
  # 5c. LEASE LIFECYCLE (decision D8): DRAFT → ACTIVE → RENEWED, TENANT VIEW
  # ===========================================================================
  /contracts/mine:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: The contract the signed-in tenant currently lives under
      description: |
        Derived from the tenant's ACTIVE occupancy (`OCCUPANCY_SELF_SCOPE`); ends at move-out.
        Staff without a tenant profile → `403`; a tenant not living in this building → `404 BIZ_NO_ACTIVE_ROOM`.
        The holder's ID number is not included.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      responses:
        '200':
          description: Own contract
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractDto' }
        '403': { $ref: '#/components/responses/ForbiddenError' }
        '404': { description: BIZ_NO_ACTIVE_ROOM }

  /contracts/{id}:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Contract detail (terms, holder, deposit balance, appliances, services)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Contract
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractDto' }
        '404': { $ref: '#/components/responses/NotFoundError' }
    patch:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Edit a DRAFT (terms, holder, planned co-occupants, rented appliances)
      description: |
        Draft only (`409 BIZ_CONTRACT_NOT_DRAFT`). The merged draft is re-validated as on creation.
        Lists (`coOccupants`, `rentedRoomAssetIds`) replace the current ones. Optimistic `version`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateDraftContractDto' }
      responses:
        '200': { description: Draft updated }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_CONTRACT_NOT_DRAFT, RES_CONCURRENCY_CONFLICT
        '422': { description: BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE }

  /contracts/{id}/activate:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Activate a draft — everybody moves in, 1-month deposit collected, room OCCUPIED
      description: |
        - Lock `lock:{buildingId}:room:contract:{roomId}` + partial unique index `idx_unique_active_contract_per_room`.
        - Re-checks the holder, every planned person (not living in another room → else `409 BIZ_OCCUPANT_ALREADY_ACTIVE`),
          capacity and the room; `pcccCommitmentSigned` must be true (`422 BIZ_PCCC_COMMITMENT_REQUIRED`); `endDate` not past (`400`).
        - Occupants: holder PRIMARY_HOLDER, others CO_OCCUPANT, residence PENDING_DECLARATION each; channel by nationality.
        - Deposit HELD + `INITIAL_COLLECTION` ledger row (holder as counterparty); appliance handover condition recorded.
        - Adults with a phone get a TENANT account linked to their profile; new accounts receive an ACCOUNT_INVITATION SMS after commit
          and activate with `POST /auth/otp/request` (ACTIVATE_ACCOUNT) + `POST /auth/activate`.
        - Outbox: `contract.activated`, `occupant.moved_in` and `residence.declaration_required` per person,
          `deposit.collected`, `room.status_changed`.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/VersionedActionDto' }
      responses:
        '201':
          description: Contract ACTIVE
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractDto' }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_CONTRACT_NOT_DRAFT, BIZ_ROOM_HAS_ACTIVE_CONTRACT, BIZ_OCCUPANT_ALREADY_ACTIVE
        '400': { description: 'REQ_VALIDATION_ERROR: the term already ended (endDate before today)' }
        '422': { description: 'BIZ_PCCC_COMMITMENT_REQUIRED or BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE' }

  /contracts/{id}/cancel:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Cancel a draft (room back to AVAILABLE)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/VersionedActionDto' }
      responses:
        '201': { description: Draft CANCELLED }
        '409': { $ref: '#/components/responses/ConflictError' }   # BIZ_CONTRACT_NOT_DRAFT

  /contracts/{id}/renew:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Renew an active contract (new end date, optional new rent and deposit top-up)
      description: |
        - Active only (`409 BIZ_CONTRACT_NOT_ACTIVE`); `newEndDate` after the current end date and after today.
        - A new rent applies from `effectiveDate` = current end date + 1 day.
        - `topUpDeposit` brings the deposit up to one month of the new rent (`TOP_UP` ledger row).
        - Writes `contract_renewals` with an addendum number (shared counter with holder transfers).
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RenewContractDto' }
      responses:
        '201':
          description: Renewal recorded
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractRenewalDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /contracts/{id}/renewals:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Renewal history (addenda)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Renewals, oldest first
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/ContractRenewalDto' } }

  # ===========================================================================
  # 5d. VEHICLES & EXTRA SERVICES (decision D8)
  # ===========================================================================
  /contracts/{id}/vehicles:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Vehicles of the people living under this contract
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: status, in: query, required: false, schema: { type: string, enum: [ACTIVE, ALL], default: ACTIVE } }
      responses:
        '200':
          description: Vehicles
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/VehicleDto' } }
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Register a vehicle (parking subscription follows automatically)
      description: |
        - Active contract; the owner is an active occupant of it.
        - Plate normalised (upper case, single spaces) and unique among the building's active vehicles, like the
          parking card (`409 RES_ALREADY_EXISTS`); bicycles need no plate.
        - The per-vehicle catalogue item of that vehicle type (if any) is subscribed / counted up.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RegisterVehicleDto' }
      responses:
        '201':
          description: Vehicle registered
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/VehicleDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /contracts/{id}/vehicles/{vehicleId}:
    patch:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Correct the plate, model or parking card of an active vehicle
      description: |
        - The vehicle type cannot change (register a new vehicle). Inactive vehicles → `409 RES_CONFLICT` (`INACTIVE`).
        - Plate normalised and unique among active vehicles, like the parking card (`409 RES_ALREADY_EXISTS`);
          `licensePlate: null` only for bicycles; `parkingCardCode: null` removes the card.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: vehicleId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateVehicleDto' }
      responses:
        '200':
          description: Vehicle updated
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/VehicleDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /contracts/{id}/vehicles/{vehicleId}/deactivate:
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Deactivate a vehicle (parking subscription counted down / removed)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: vehicleId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/DeactivateVehicleDto' }
      responses:
        '201': { description: Vehicle deactivated }
        '409': { description: Already inactive (RES_CONFLICT) }

  /contracts/{id}/services:
    get:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Extra services of the contract (Wi-Fi, parking, sanitation…)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Subscriptions
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/ContractServiceDto' } }
    post:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Subscribe a draft or active contract to a catalogue service
      description: |
        - Per-room: `quantity` (default 1). Per-person: quantity = active (or planned) occupants, not settable.
        - Per-vehicle items are subscribed by registering vehicles → `409 BIZ_SERVICE_QUANTITY_DERIVED`.
        - One live subscription per item (`409 RES_ALREADY_EXISTS`); `agreedUnitPrice` defaults to the catalogue price.
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AddContractServiceDto' }
      responses:
        '201':
          description: Subscribed
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { $ref: '#/components/schemas/ContractServiceDto' }
        '409': { $ref: '#/components/responses/ConflictError' }

  /contracts/{id}/services/{subscriptionId}:
    patch:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Change the agreed price (or the quantity of a per-room service)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: subscriptionId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateContractServiceDto' }
      responses:
        '200': { description: Updated }
        '409': { description: BIZ_SERVICE_QUANTITY_DERIVED or contract closed }
    delete:
      tags: [Contracts & 1-Month Deposit Escrow]
      summary: Unsubscribe (not for per-vehicle items — deactivate the vehicles)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: subscriptionId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '204': { description: Removed }
        '409': { description: BIZ_SERVICE_QUANTITY_DERIVED or contract closed }

  # ===========================================================================
  # 5e. SERVICE CATALOGUE PER BUILDING (decision D8)
  # ===========================================================================
  /service-catalog:
    get:
      tags: [Service Catalogue]
      summary: Services offered by the building
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      responses:
        '200':
          description: Catalogue items ordered by code
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/StandardSuccessEnvelope'
                  - type: object
                    properties:
                      data: { type: array, items: { $ref: '#/components/schemas/ServiceCatalogDto' } }
    post:
      tags: [Service Catalogue]
      summary: Add a service (per room / per person / per vehicle type)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateServiceCatalogDto' }
      responses:
        '201': { description: Created }
        '409': { description: Code or vehicle type already used (RES_ALREADY_EXISTS) }

  /service-catalog/{id}:
    patch:
      tags: [Service Catalogue]
      summary: Rename / re-price (existing subscriptions keep their agreed price)
      description: '`chargeUnit` and `vehicleType` cannot change while contracts subscribe to the item (`409 BIZ_SERVICE_IN_USE`).'
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateServiceCatalogDto' }
      responses:
        '200': { description: Updated }
        '409': { $ref: '#/components/responses/ConflictError' }
    delete:
      tags: [Service Catalogue]
      summary: Remove an unused service (soft delete)
      parameters:
        - $ref: '#/components/parameters/BuildingIdHeader'
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '204': { description: Removed }
        '409': { description: BIZ_SERVICE_IN_USE }
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

      description: 15-minute JWT access token from POST /auth/login (claims sub, sid, phoneMasked, buildingId, buildingIds, roles); tokens of a revoked session are rejected with AUTH_SESSION_REVOKED

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

        roomTypeId: { type: string, format: uuid }

        priceOverride: { type: number, nullable: true, description: null = room type base rent }

        version: { type: integer, description: Optimistic lock for PATCH }

        isPubliclyListed: { type: boolean, description: Shown on the portfolio site }

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

```yaml
    PublicBuildingSummaryDto:
      type: object
      properties:
        slug: { type: string, example: sunrise-quan-7 }
        name: { type: string, example: "Tòa nhà Sunrise" }
        district: { type: string, example: "Quận 7" }
        city: { type: string, example: "Thành phố Hồ Chí Minh" }
        totalRooms: { type: integer, example: 80 }
        availableRooms: { type: integer, example: 6 }
        monthlyRentFrom: { type: number, nullable: true, example: 6500000 }
        monthlyRentTo: { type: number, nullable: true, example: 12000000 }

    PublicBuildingDto:
      type: object
      properties:
        slug: { type: string }
        name: { type: string }
        description: { type: string, nullable: true }
        addressLine: { type: string, example: "12 Nguyễn Thị Thập" }
        ward: { type: string }
        district: { type: string }
        city: { type: string }
        totalRooms: { type: integer }
        availableRooms: { type: integer }
        floors: { type: array, items: { type: integer }, example: [1, 2, 3, 4, 5, 6, 7, 8] }
        roomTypes: { type: array, items: { $ref: '#/components/schemas/PublicRoomTypeDto' } }
        utilities:
          type: object
          properties:
            electricityBillingMode: { type: string, enum: [EVN_TIERED_QUOTA, EVN_TIER_3_FLAT], description: EVN residential tiers by registered residents, or flat tier-3 rate }
            waterRatePerM3: { type: number, example: 25000 }
        depositMonths: { type: integer, example: 1, description: Security deposit equal to one month of rent }

    PublicRoomTypeDto:
      type: object
      properties:
        code: { type: string, example: STUDIO }
        name: { type: string, example: Studio }
        baseMonthlyRent: { type: number, example: 6500000 }
        standardAreaSqm: { type: number, example: 28.5 }
        maxOccupants: { type: integer, example: 2 }
        totalRooms: { type: integer, example: 40 }
        availableRooms: { type: integer, example: 3 }

    PublicFloorDto:
      type: object
      properties:
        floor: { type: integer, example: 3 }
        totalRooms: { type: integer, example: 10 }
        availableRooms: { type: integer, example: 2 }
        roomNumbers: { type: array, items: { type: string }, example: ["P.301", "P.302"] }

    PublicRoomListItemDto:
      type: object
      properties:
        roomNumber: { type: string, example: "P.302" }
        floor: { type: integer, example: 3 }
        roomTypeCode: { type: string, example: STUDIO }
        roomTypeName: { type: string, example: Studio }
        areaSqm: { type: number, example: 30 }
        maxOccupants: { type: integer, example: 2 }
        monthlyRent: { type: number, example: 6500000 }
        availability: { type: string, enum: [AVAILABLE, UNAVAILABLE] }

    PublicRoomDetailDto:
      allOf:
        - $ref: '#/components/schemas/PublicRoomListItemDto'
        - type: object
          properties:
            buildingSlug: { type: string }
            equipment:
              type: array
              items:
                type: object
                properties:
                  name: { type: string, example: "Máy lạnh Daikin Inverter 1.5 HP" }
                  category: { type: string, enum: [APPLIANCE, FURNITURE] }
                  conditionGrade: { type: string, enum: [GRADE_A_NEW, GRADE_B_GOOD, GRADE_C_FAIR, BROKEN] }
                  monthlyFee: { type: number, example: 300000 }
            depositMonths: { type: integer, example: 1 }

    PublicVacancyDto:
      type: object
      properties:
        roomTypeCode: { type: string }
        roomTypeName: { type: string }
        baseMonthlyRent: { type: number }
        totalRooms: { type: integer }
        availableRooms: { type: integer }

    PublicAssetDto:
      type: object
      properties:
        name: { type: string }
        category: { type: string, enum: [APPLIANCE, FURNITURE] }
        standardMonthlyRentalFee: { type: number }
        roomsEquipped: { type: integer, description: Published rooms with at least one unit installed }

```

```yaml
    BuildingDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        code: { type: string, example: "BLD-HCM-Q7-01" }
        name: { type: string, example: "Tòa nhà Sunrise" }
        addressLine: { type: string, example: "12 Nguyễn Thị Thập" }
        ward: { type: string, example: "Phường Tân Phú" }
        district: { type: string, example: "Quận 7" }
        city: { type: string, example: "Thành phố Hồ Chí Minh" }
        landlordTaxCode: { type: string, example: "0312345678" }
        landlordFullName: { type: string, example: "Nguyễn Văn Chủ" }
        bankAccountNumber: { type: string, nullable: true, example: "0071000123456" }
        bankBinCode: { type: string, nullable: true, example: "970436" }
        totalRoomsCapacity: { type: integer, example: 80 }
        roomCount: { type: integer, example: 80 }
        isPubliclyListed: { type: boolean, example: true }
        publicSlug: { type: string, nullable: true, example: sunrise-quan-7 }
        publicDescription: { type: string, nullable: true }
        electricityBillingMode: { type: string, enum: [EVN_TIERED_QUOTA, EVN_TIER_3_FLAT] }
        defaultWaterRatePerM3: { type: number, example: 25000 }
        version: { type: integer }

    CreateBuildingDto:
      type: object
      required: [code, name, addressLine, ward, district, landlordTaxCode, landlordFullName]
      properties:
        code: { type: string, pattern: '^[A-Z0-9][A-Z0-9-]{2,29}$', example: "BLD-HCM-Q7-01" }
        name: { type: string, maxLength: 150 }
        addressLine: { type: string, maxLength: 255 }
        ward: { type: string, maxLength: 100 }
        district: { type: string, maxLength: 100 }
        city: { type: string, maxLength: 100, default: "Thành phố Hồ Chí Minh" }
        landlordTaxCode: { type: string, pattern: '^[0-9]{10}(-[0-9]{3})?$' }
        landlordFullName: { type: string, maxLength: 150 }
        bankAccountNumber: { type: string, pattern: '^[0-9]{6,19}$' }
        bankBinCode: { type: string, pattern: '^[0-9]{6}$', description: NAPAS bank BIN for VietQR }
        totalRoomsCapacity: { type: integer, minimum: 1, maximum: 500, default: 80 }
        electricityBillingMode: { type: string, enum: [EVN_TIERED_QUOTA, EVN_TIER_3_FLAT], default: EVN_TIERED_QUOTA }
        defaultWaterRatePerM3: { type: number, minimum: 0, default: 25000 }

    UpdateBuildingDto:
      type: object
      minProperties: 1
      description: Same fields as CreateBuildingDto except code (all optional), plus version
      properties:
        name: { type: string, maxLength: 150 }
        addressLine: { type: string, maxLength: 255 }
        ward: { type: string, maxLength: 100 }
        district: { type: string, maxLength: 100 }
        city: { type: string, maxLength: 100 }
        landlordTaxCode: { type: string, pattern: '^[0-9]{10}(-[0-9]{3})?$' }
        landlordFullName: { type: string, maxLength: 150 }
        bankAccountNumber: { type: string, nullable: true, pattern: '^[0-9]{6,19}$' }
        bankBinCode: { type: string, nullable: true, pattern: '^[0-9]{6}$' }
        totalRoomsCapacity: { type: integer, minimum: 1, maximum: 500 }
        electricityBillingMode: { type: string, enum: [EVN_TIERED_QUOTA, EVN_TIER_3_FLAT] }
        defaultWaterRatePerM3: { type: number, minimum: 0 }
        isPubliclyListed: { type: boolean, description: Show the building on the portfolio site (needs publicSlug) }
        publicSlug: { type: string, nullable: true, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', minLength: 3, maxLength: 80 }
        publicDescription: { type: string, nullable: true, maxLength: 2000 }
        version: { type: integer, minimum: 1 }

    RoomTypeDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        code: { type: string, example: "STUDIO_BALCONY" }
        name: { type: string, example: "Studio Balcony" }
        baseMonthlyRent: { type: number, example: 6500000 }
        standardAreaSqm: { type: number, example: 28.5 }
        defaultMaxOccupants: { type: integer, example: 2 }
        version: { type: integer }

    CreateRoomTypeDto:
      type: object
      required: [code, name, baseMonthlyRent, standardAreaSqm]
      properties:
        code: { type: string, pattern: '^[A-Z0-9_]{2,50}$', example: "1BR_DELUXE" }
        name: { type: string, maxLength: 100 }
        baseMonthlyRent: { type: number, minimum: 1, maximum: 999999999999, description: VND, whole number }
        standardAreaSqm: { type: number, exclusiveMinimum: true, minimum: 0, maximum: 9999 }
        defaultMaxOccupants: { type: integer, minimum: 1, maximum: 20, default: 2 }

    UpdateRoomTypeDto:
      type: object
      minProperties: 1
      properties:
        name: { type: string, maxLength: 100 }
        baseMonthlyRent: { type: number, minimum: 1 }
        standardAreaSqm: { type: number, minimum: 0, exclusiveMinimum: true }
        defaultMaxOccupants: { type: integer, minimum: 1, maximum: 20 }
        version: { type: integer, minimum: 1 }

    CreateRoomDto:
      type: object
      required: [roomNumber, floor, areaSqm, roomTypeId]
      properties:
        roomNumber: { type: string, pattern: '^[A-Z0-9][A-Z0-9.-]{0,19}$', example: "P.302" }
        floor: { type: integer, minimum: 1, maximum: 30, example: 3 }
        areaSqm: { type: number, minimum: 0, exclusiveMinimum: true, example: 32.5 }
        roomTypeId: { type: string, format: uuid }
        maxOccupants: { type: integer, minimum: 1, maximum: 20, description: Defaults to the room type's defaultMaxOccupants }
        priceOverride: { type: number, minimum: 1, nullable: true, description: VND; null = room type base rent }

    UpdateRoomDto:
      type: object
      minProperties: 1
      properties:
        roomNumber: { type: string, pattern: '^[A-Z0-9][A-Z0-9.-]{0,19}$' }
        floor: { type: integer, minimum: 1, maximum: 30 }
        areaSqm: { type: number, minimum: 0, exclusiveMinimum: true }
        roomTypeId: { type: string, format: uuid }
        maxOccupants: { type: integer, minimum: 1, maximum: 20 }
        priceOverride: { type: number, minimum: 1, nullable: true }
        status: { type: string, enum: [AVAILABLE, RESERVED, MAINTENANCE] }
        isPubliclyListed: { type: boolean, description: false hides the room from the portfolio site }
        version: { type: integer, minimum: 1 }

    AssetDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        code: { type: string, example: "AC_DAIKIN_1_5HP" }
        name: { type: string, example: "Máy lạnh Daikin Inverter 1.5 HP" }
        category: { type: string, enum: [APPLIANCE, FURNITURE] }
        standardMonthlyRentalFee: { type: number, example: 300000 }
        replacementValue: { type: number, example: 9500000 }
        installedUnits: { type: integer, example: 42 }
        version: { type: integer }

    CreateAssetDto:
      type: object
      required: [code, name, category, standardMonthlyRentalFee]
      properties:
        code: { type: string, pattern: '^[A-Z0-9_]{2,50}$' }
        name: { type: string, maxLength: 150 }
        category: { type: string, enum: [APPLIANCE, FURNITURE] }
        standardMonthlyRentalFee: { type: number, minimum: 0 }
        replacementValue: { type: number, minimum: 0, default: 0 }

    UpdateAssetDto:
      type: object
      minProperties: 1
      properties:
        name: { type: string, maxLength: 150 }
        standardMonthlyRentalFee: { type: number, minimum: 0 }
        replacementValue: { type: number, minimum: 0 }
        version: { type: integer, minimum: 1 }

    RoomAssetDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        roomId: { type: string, format: uuid }
        roomNumber: { type: string, example: "P.302" }
        assetId: { type: string, format: uuid }
        assetName: { type: string }
        category: { type: string, enum: [APPLIANCE, FURNITURE] }
        serialNumber: { type: string, example: "DK-2026-992019" }
        conditionGrade: { type: string, enum: [GRADE_A_NEW, GRADE_B_GOOD, GRADE_C_FAIR, BROKEN] }
        customMonthlyFee: { type: number, example: 300000 }
        installedDate: { type: string, format: date }
        rentedUnderContractId: { type: string, format: uuid, nullable: true, description: 'Inventory list only: draft / active contract renting the unit' }
        version: { type: integer }

    UpdateRoomAssetDto:
      type: object
      minProperties: 1
      properties:
        roomId: { type: string, format: uuid, description: Move the unit to another room of the building }
        conditionGrade: { type: string, enum: [GRADE_A_NEW, GRADE_B_GOOD, GRADE_C_FAIR, BROKEN] }
        customMonthlyFee: { type: number, minimum: 0 }
        version: { type: integer, minimum: 1 }

    AssignRoomAssetDto:
      type: object
      required: [roomId, assetId, serialNumber]
      properties:
        roomId: { type: string, format: uuid }
        assetId: { type: string, format: uuid }
        serialNumber: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$', example: "DK-2026-992019" }
        conditionGrade: { type: string, enum: [GRADE_A_NEW, GRADE_B_GOOD, GRADE_C_FAIR, BROKEN], default: GRADE_A_NEW }
        customMonthlyFee: { type: number, minimum: 0, description: Defaults to the catalogue item's standardMonthlyRentalFee }
        installedDate: { type: string, format: date, description: Defaults to today (Vietnam time); not in the future }

```

```yaml
    LoginDto:
      type: object
      required: [phone, password]
      properties:
        phone: { type: string, maxLength: 20, example: "0901 234 567", description: "Vietnamese or E.164 number, normalised to +84901234567" }
        password: { type: string, format: password, minLength: 1, maxLength: 128 }
        deviceId: { type: string, maxLength: 100, example: "ios-7F3A2C" }
        deviceName: { type: string, maxLength: 150, example: "iPhone 15" }

    VerifyLoginOtpDto:
      type: object
      required: [challengeId, code]
      properties:
        challengeId: { type: string, format: uuid }
        code: { type: string, pattern: '^[0-9]{6}$', example: "482913" }
        deviceId: { type: string, maxLength: 100, description: Same deviceId as sent to POST /auth/login }

    RefreshTokenDto:
      type: object
      required: [refreshToken]
      properties:
        refreshToken: { type: string, example: "3f0c9a52-6f1e-4d0b-9a77-1c2d3e4f5a6b.r7Hq…" }

    RequestOtpDto:
      type: object
      required: [phone, purpose]
      properties:
        phone: { type: string, maxLength: 20, example: "0901234567" }
        purpose: { type: string, enum: [ACTIVATE_ACCOUNT, RESET_PASSWORD] }

    OtpRequestAcceptedDto:
      type: object
      properties:
        expiresInSeconds: { type: integer, example: 300 }
        resendAfterSeconds: { type: integer, example: 60 }
        debugCode: { type: string, description: Only when AUTH_OTP_DEBUG_ECHO=true (local / test) and a code was really sent }

    ActivateAccountDto:
      type: object
      required: [phone, code, newPassword]
      properties:
        phone: { type: string, maxLength: 20, example: "0901234567" }
        code: { type: string, pattern: '^[0-9]{6}$' }
        newPassword: { type: string, format: password, minLength: 10, maxLength: 128 }
        deviceId: { type: string, maxLength: 100 }
        deviceName: { type: string, maxLength: 150 }

    ResetPasswordDto:
      type: object
      required: [phone, code, newPassword]
      properties:
        phone: { type: string, maxLength: 20 }
        code: { type: string, pattern: '^[0-9]{6}$' }
        newPassword: { type: string, format: password, minLength: 10, maxLength: 128 }

    ChangePasswordDto:
      type: object
      required: [currentPassword, newPassword]
      properties:
        currentPassword: { type: string, format: password, maxLength: 128 }
        newPassword: { type: string, format: password, minLength: 10, maxLength: 128 }

    TokenPairDto:
      type: object
      properties:
        tokenType: { type: string, enum: [Bearer] }
        accessToken: { type: string, description: "JWT, 15 minutes" }
        accessTokenExpiresIn: { type: integer, example: 900 }
        refreshToken: { type: string, description: "Opaque, single use (rotated on every refresh)" }
        refreshTokenExpiresAt: { type: string, format: date-time, description: Idle expiry; never later than the absolute expiry }
        sessionId: { type: string, format: uuid }
        user:
          type: object
          properties:
            id: { type: string, format: uuid }
            fullName: { type: string, example: "Nguyễn Văn A" }
            phoneMasked: { type: string, example: "090****567" }
            roles: { type: array, items: { type: string }, example: [TENANT] }
            buildingIds: { type: array, items: { type: string, format: uuid } }

    MfaChallengeDto:
      type: object
      properties:
        mfaRequired: { type: boolean, example: true }
        challengeId: { type: string, format: uuid }
        otpSentTo: { type: string, example: "090****567" }
        channel: { type: string, enum: [ZALO, SMS] }
        expiresInSeconds: { type: integer, example: 300 }
        debugCode: { type: string, description: Only when AUTH_OTP_DEBUG_ECHO=true (local / test) }

    MeDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        fullName: { type: string }
        phoneMasked: { type: string, example: "090****567" }
        status: { type: string, enum: [PENDING_ACTIVATION, ACTIVE, DISABLED] }
        roles: { type: array, items: { type: string } }
        activeBuildingId: { type: string, format: uuid, nullable: true }
        buildings:
          type: array
          items:
            type: object
            properties:
              id: { type: string, format: uuid }
              name: { type: string, example: "Tòa nhà Sunrise" }
        permissions: { type: array, items: { type: string }, example: ["rooms:read:own", "invoices:read:own"] }
        residence:
          type: object
          nullable: true
          description: Only for a TENANT who currently lives in a room of the active building
          properties:
            tenantId: { type: string, format: uuid }
            contractId: { type: string, format: uuid }
            roomId: { type: string, format: uuid }
            roomNumber: { type: string, example: "P.302" }
            occupantRole: { type: string, enum: [PRIMARY_HOLDER, CO_OCCUPANT] }

    SessionDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        deviceName: { type: string, nullable: true, example: "iPhone 15" }
        ipAddress: { type: string, example: "113.161.45.10" }
        userAgent: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        lastUsedAt: { type: string, format: date-time }
        current: { type: boolean }

    CreateUserDto:
      type: object
      required: [phone, fullName, roles, buildingIds]
      properties:
        phone: { type: string, maxLength: 20, example: "0912345678" }
        fullName: { type: string, maxLength: 150, example: "Trần Thị B" }
        roles: { type: array, minItems: 1, items: { type: string, enum: [LANDLORD, PROPERTY_MANAGER, ACCOUNTANT, GUARD] } }
        buildingIds: { type: array, minItems: 1, items: { type: string, format: uuid } }

    UpdateUserDto:
      type: object
      minProperties: 1
      properties:
        fullName: { type: string, maxLength: 150 }
        roles: { type: array, minItems: 1, items: { type: string, enum: [LANDLORD, PROPERTY_MANAGER, ACCOUNTANT, GUARD] } }
        buildingIds: { type: array, minItems: 1, items: { type: string, format: uuid } }
        status: { type: string, enum: [ACTIVE, DISABLED] }
        version: { type: integer, description: Optimistic lock (users.version) }

    UserDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        fullName: { type: string }
        phoneMasked: { type: string, example: "091****678" }
        status: { type: string, enum: [PENDING_ACTIVATION, ACTIVE, DISABLED] }
        roles: { type: array, items: { type: string } }
        buildingIds: { type: array, items: { type: string, format: uuid } }
        lastLoginAt: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
        version: { type: integer }

    CreateTenantDto:
      type: object
      description: One profile per PERSON (contract holder, roommate or child). Register every occupant.
      required: [fullName, idDocumentType, idCardNumber, gender, dateOfBirth, hometownAddress, permanentAddress, pdplConsentAccepted]
      properties:
        fullName: { type: string, maxLength: 150, example: "Nguyễn Văn A" }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT], default: CCCD }
        idCardNumber:
          type: string
          maxLength: 20
          example: "079099001234"
          description: 12-digit CCCD or a child's personal identification number (VN), or passport number. Encrypted at rest; blind-indexed.
        idCardIssueDate: { type: string, format: date, nullable: true, example: "2022-05-10", description: Not in the future and not before the date of birth; null for children without a card }
        idCardIssuePlace: { type: string, nullable: true, maxLength: 150, example: "Bộ Công an" }
        nationality: { type: string, pattern: '^[A-Z]{2}$', default: VN, example: VN }
        gender: { type: string, enum: [MALE, FEMALE] }
        dateOfBirth: { type: string, format: date, example: "1999-08-15", description: Not in the future, at most 120 years ago }
        phone: { type: string, nullable: true, example: "0901234567", description: Required for adults; normalised to E.164 }
        email: { type: string, format: email, nullable: true }
        hometownAddress: { type: string, maxLength: 255, example: "Quận 1, TP. Hồ Chí Minh" }
        permanentAddress: { type: string, maxLength: 255, example: "123 Nguyễn Huệ, Phường Bến Nghé, TP.HCM" }
        refundBankAccount: { type: string, nullable: true, pattern: '^[0-9]{6,19}$', example: "0071001234567" }
        refundBankName: { type: string, nullable: true, maxLength: 100, example: "Vietcombank", description: Required with refundBankAccount }
        pdplConsentAccepted: { type: boolean, example: true, description: Mandatory consent (Law 91/2025/QH15) }
        consentGuardianTenantId:
          type: string
          format: uuid
          nullable: true
          description: Required for a minor and refused for an adult - an adult profile of the same building that has given consent (Decree 13/2023/NĐ-CP, Art. 20)

    UpdateTenantDto:
      type: object
      minProperties: 1
      description: Any CreateTenantDto field except pdplConsentAccepted, all optional; idCardNumber and idDocumentType are re-validated together
      properties:
        fullName: { type: string, maxLength: 150 }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT] }
        idCardNumber: { type: string, maxLength: 20 }
        idCardIssueDate: { type: string, format: date, nullable: true }
        idCardIssuePlace: { type: string, nullable: true, maxLength: 150 }
        nationality: { type: string, pattern: '^[A-Z]{2}$' }
        gender: { type: string, enum: [MALE, FEMALE] }
        dateOfBirth: { type: string, format: date }
        phone: { type: string, nullable: true }
        email: { type: string, format: email, nullable: true }
        hometownAddress: { type: string, maxLength: 255 }
        permanentAddress: { type: string, maxLength: 255 }
        refundBankAccount: { type: string, nullable: true, pattern: '^[0-9]{6,19}$' }
        refundBankName: { type: string, nullable: true, maxLength: 100 }
        consentGuardianTenantId: { type: string, format: uuid, nullable: true }
        version: { type: integer, minimum: 1 }

    TenantSafeResponseDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        fullName: { type: string, example: "Nguyễn Văn A" }
        idDocumentType: { type: string, enum: [CCCD, PASSPORT] }
        idCardMasked: { type: string, example: "********1234" }
        isMinor: { type: boolean, example: false }
        phone: { type: string, nullable: true, example: "+84901234567" }
        createdAt: { type: string, format: date-time }

    TenantDetailDto:
      allOf:
        - $ref: '#/components/schemas/TenantSafeResponseDto'
        - type: object
          properties:
            nationality: { type: string, example: VN }
            gender: { type: string, enum: [MALE, FEMALE] }
            dateOfBirth: { type: string, format: date }
            email: { type: string, nullable: true }
            idCardIssueDate: { type: string, format: date, nullable: true }
            idCardIssuePlace: { type: string, nullable: true }
            hometownAddress: { type: string }
            permanentAddress: { type: string }
            refundBankName: { type: string, nullable: true }
            refundBankAccountMasked: { type: string, nullable: true, example: "*********4567" }
            pdplConsentAcceptedAt: { type: string, format: date-time }
            pdplConsentVersion: { type: string, example: v2026.1 }
            guardian:
              type: object
              nullable: true
              properties:
                id: { type: string, format: uuid }
                fullName: { type: string }
            hasLogin: { type: boolean, description: A TENANT account is linked (created at move-in) }
            currentOccupancy:
              type: object
              nullable: true
              description: Where the person lives now (null = not living in a room of this building)
              properties:
                occupantId: { type: string, format: uuid }
                contractId: { type: string, format: uuid }
                contractCode: { type: string, example: "HD-2026/007-P302" }
                roomId: { type: string, format: uuid }
                roomNumber: { type: string, example: "P.302" }
                role: { type: string, enum: [PRIMARY_HOLDER, CO_OCCUPANT] }
                movedInAt: { type: string, format: date }
                residencyStatus: { type: string, enum: [PENDING_DECLARATION, SUBMITTED, REGISTERED, DEREGISTRATION_PENDING, DEREGISTERED] }
            version: { type: integer }

    CreateContractDto:
      type: object
      required: [roomId, primaryTenantId, startDate, endDate]
      properties:
        roomId: { type: string, format: uuid }
        primaryTenantId:
          type: string
          format: uuid
          description: Contract holder (người đứng tên) — an adult with an ID document and consent on startDate
        coOccupants:
          type: array
          description: Everyone else who moves in at activation (each needs a tenant profile). Holder + these ≤ room.maxOccupants.
          items: { $ref: '#/components/schemas/PlannedOccupantDto' }
        startDate: { type: string, format: date, example: "2026-10-01" }
        endDate: { type: string, format: date, example: "2027-09-30" }
        monthlyRoomRent: { type: number, example: 6500000, description: "Per room, not per person; default = the room's effective rent" }
        depositAmount: { type: number, description: "Security deposit (Tiền đặt cọc); default = one month of rent", example: 6500000 }
        paymentDueDay: { type: integer, minimum: 1, maximum: 28, default: 5 }
        pcccCommitmentSigned: { type: boolean, default: false, description: Must be true to activate }
        rentedRoomAssetIds: { type: array, items: { type: string, format: uuid }, description: Installed units of this room rented with the contract }

    PlannedOccupantDto:
      type: object
      required: [tenantId]
      properties:
        tenantId: { type: string, format: uuid }
        movedInAt: { type: string, format: date, nullable: true, description: "Default = startDate; between startDate and endDate" }
        successionOrder: { type: integer, minimum: 1, nullable: true }
        relationshipToHolder: { type: string, nullable: true, example: "Con" }

    UpdateDraftContractDto:
      type: object
      properties:
        primaryTenantId: { type: string, format: uuid }
        coOccupants: { type: array, items: { $ref: '#/components/schemas/PlannedOccupantDto' }, description: Replaces the planned list }
        startDate: { type: string, format: date }
        endDate: { type: string, format: date }
        monthlyRoomRent: { type: number }
        depositAmount: { type: number }
        paymentDueDay: { type: integer, minimum: 1, maximum: 28 }
        pcccCommitmentSigned: { type: boolean }
        rentedRoomAssetIds: { type: array, items: { type: string, format: uuid }, description: Replaces the rented units }
        version: { type: integer }

    VersionedActionDto:
      type: object
      properties:
        version: { type: integer, description: Optional optimistic lock }

    RenewContractDto:
      type: object
      required: [newEndDate]
      properties:
        newEndDate: { type: string, format: date, example: "2028-09-30" }
        newMonthlyRoomRent: { type: number, nullable: true, example: 7000000, description: From current end date + 1 }
        topUpDeposit: { type: boolean, default: false, description: Bring the deposit up to one month of the new rent }
        notes: { type: string, nullable: true }
        version: { type: integer }

    ContractSummaryDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        contractCode: { type: string, example: "HD-2026/007-P302" }
        status: { type: string, enum: [DRAFT, ACTIVE, CANCELLED, TERMINATED, EXPIRED] }
        roomId: { type: string, format: uuid }
        roomNumber: { type: string, example: "P.302" }
        primaryTenantName: { type: string }
        startDate: { type: string, format: date }
        endDate: { type: string, format: date }
        monthlyRoomRent: { type: number }
        activeOccupantCount: { type: integer }

    ContractDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        contractCode: { type: string }
        status: { type: string, enum: [DRAFT, ACTIVE, CANCELLED, TERMINATED, EXPIRED] }
        room: { type: object, properties: { id: { type: string, format: uuid }, roomNumber: { type: string }, floor: { type: integer }, maxOccupants: { type: integer } } }
        primaryHolder:
          type: object
          properties:
            tenantId: { type: string, format: uuid }
            fullName: { type: string }
            idCardMasked: { type: string, description: Not returned by /contracts/mine }
            phone: { type: string, nullable: true }
        startDate: { type: string, format: date }
        endDate: { type: string, format: date }
        monthlyRoomRent: { type: number }
        depositAmount: { type: number }
        depositStatus: { type: string, enum: [PENDING_COLLECTION, HELD, PARTIALLY_REFUNDED, FULLY_REFUNDED, FORFEITED] }
        depositBalance: { type: number, description: balanceAfter of the latest ledger row }
        paymentDueDay: { type: integer }
        pcccCommitmentSigned: { type: boolean }
        registeredEvnQuotaHeadcount: { type: integer }
        activeOccupantCount: { type: integer }
        plannedCoOccupants: { type: array, nullable: true, description: Draft only, items: { type: object, properties: { tenantId: { type: string }, fullName: { type: string }, movedInAt: { type: string, format: date }, successionOrder: { type: integer, nullable: true }, relationshipToHolder: { type: string, nullable: true } } } }
        rentedAssets: { type: array, items: { type: object, properties: { contractAssetId: { type: string }, roomAssetId: { type: string }, name: { type: string }, serialNumber: { type: string }, agreedMonthlyFee: { type: number }, handoverCondition: { type: string } } } }
        services: { type: array, items: { $ref: '#/components/schemas/ContractServiceDto' } }
        activatedAt: { type: string, format: date-time, nullable: true }
        cancelledAt: { type: string, format: date-time, nullable: true }
        version: { type: integer }

    ContractRenewalDto:
      type: object
      properties:
        renewalId: { type: string, format: uuid }
        previousEndDate: { type: string, format: date }
        newEndDate: { type: string, format: date }
        effectiveDate: { type: string, format: date }
        previousMonthlyRent: { type: number }
        newMonthlyRent: { type: number }
        depositTopUpAmount: { type: number }
        addendumNo: { type: string, example: "PL-2026/007-P302-01" }
        createdAt: { type: string, format: date-time }

    DepositLedgerEntryDto:
      type: object
      properties:
        entryNo: { type: integer }
        transactionType: { type: string, enum: [INITIAL_COLLECTION, TOP_UP, CHECKOUT_DEDUCTION, SURPLUS_REFUND, FORFEITURE, HOLDER_TRANSFER_CARRY_OVER, HOLDER_TRANSFER_REFUND, HOLDER_TRANSFER_COLLECTION] }
        amount: { type: number, description: "+ collected, - refunded / deducted" }
        balanceAfter: { type: number }
        counterpartyTenantId: { type: string, format: uuid }
        counterpartyName: { type: string }
        holderTransferId: { type: string, format: uuid, nullable: true }
        notes: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }

    RegisterVehicleDto:
      type: object
      required: [ownerTenantId, vehicleType, brandModel]
      properties:
        ownerTenantId: { type: string, format: uuid, description: An active occupant of the contract }
        vehicleType: { type: string, enum: [MOTORBIKE, ELECTRIC_BIKE, BICYCLE, CAR] }
        licensePlate: { type: string, nullable: true, example: "59-G2 123.45", description: Required except for bicycles }
        brandModel: { type: string, example: "Honda Vision" }
        parkingCardCode: { type: string, nullable: true }

    UpdateVehicleDto:
      type: object
      properties:
        licensePlate: { type: string, nullable: true, example: "59-G2 123.45", description: Null only for bicycles }
        brandModel: { type: string, maxLength: 100 }
        parkingCardCode: { type: string, nullable: true, description: null removes the card }

    DeactivateVehicleDto:
      type: object
      properties:
        deactivatedAt: { type: string, format: date, description: Default today; not in the future }

    VehicleDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        ownerTenantId: { type: string, format: uuid }
        ownerName: { type: string }
        vehicleType: { type: string, enum: [MOTORBIKE, ELECTRIC_BIKE, BICYCLE, CAR] }
        licensePlate: { type: string, nullable: true }
        brandModel: { type: string }
        parkingCardCode: { type: string, nullable: true }
        isActive: { type: boolean }
        deactivatedAt: { type: string, format: date, nullable: true }

    AddContractServiceDto:
      type: object
      required: [serviceCatalogId]
      properties:
        serviceCatalogId: { type: string, format: uuid }
        quantity: { type: integer, minimum: 1, maximum: 20, description: Per-room services only (default 1) }
        agreedUnitPrice: { type: number, minimum: 0, description: Default = catalogue price }

    UpdateContractServiceDto:
      type: object
      properties:
        quantity: { type: integer, minimum: 1, maximum: 20 }
        agreedUnitPrice: { type: number, minimum: 0 }

    ContractServiceDto:
      type: object
      properties:
        subscriptionId: { type: string, format: uuid }
        serviceCatalogId: { type: string, format: uuid }
        serviceCode: { type: string, example: "WIFI" }
        name: { type: string }
        chargeUnit: { type: string, enum: [PER_ROOM_MONTH, PER_PERSON_MONTH, PER_VEHICLE_MONTH] }
        quantity: { type: integer }
        agreedUnitPrice: { type: number }
        quantitySource: { type: string, enum: [MANUAL, OCCUPANTS, VEHICLES] }

    CreateServiceCatalogDto:
      type: object
      required: [code, name, chargeUnit, defaultUnitPrice]
      properties:
        code: { type: string, pattern: '^[A-Z][A-Z0-9_]{1,49}$', example: PARKING_MOTORBIKE }
        name: { type: string, example: "Gửi xe máy" }
        chargeUnit: { type: string, enum: [PER_ROOM_MONTH, PER_PERSON_MONTH, PER_VEHICLE_MONTH] }
        vehicleType: { type: string, enum: [MOTORBIKE, ELECTRIC_BIKE, BICYCLE, CAR], description: Required exactly for PER_VEHICLE_MONTH }
        defaultUnitPrice: { type: number, minimum: 0, example: 150000 }
        isProratableOnCheckout: { type: boolean, default: true }

    UpdateServiceCatalogDto:
      type: object
      properties:
        name: { type: string }
        chargeUnit: { type: string, enum: [PER_ROOM_MONTH, PER_PERSON_MONTH, PER_VEHICLE_MONTH] }
        vehicleType: { type: string, nullable: true, enum: [MOTORBIKE, ELECTRIC_BIKE, BICYCLE, CAR] }
        defaultUnitPrice: { type: number, minimum: 0 }
        isProratableOnCheckout: { type: boolean }
        version: { type: integer }

    ServiceCatalogDto:
      type: object
      properties:
        id: { type: string, format: uuid }
        code: { type: string }
        name: { type: string }
        chargeUnit: { type: string, enum: [PER_ROOM_MONTH, PER_PERSON_MONTH, PER_VEHICLE_MONTH] }
        vehicleType: { type: string, nullable: true }
        defaultUnitPrice: { type: number }
        isProratableOnCheckout: { type: boolean }
        version: { type: integer }

    AddOccupantDto:
      type: object
      required: [tenantId, movedInAt]
      properties:
        tenantId: { type: string, format: uuid }
        movedInAt: { type: string, format: date, example: "2026-11-01", description: "Between the contract's startDate and today" }
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
        residenceChannel: { type: string, enum: [CT01, FOREIGNER_TEMPORARY_RESIDENCE], description: By nationality (Vietnamese with a passport → CT01) }
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


```yaml
    ForbiddenError:
      description: Authenticated but not allowed (AUTH_FORBIDDEN_RESOURCE, AUTH_TENANT_MISMATCH, AUTH_ACCOUNT_DISABLED, RLS 42501)
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Rfc7807ErrorEnvelope' }

    LockedError:
      description: Too many wrong passwords for this phone number (AUTH_ACCOUNT_LOCKED); see Retry-After
      headers:
        Retry-After: { schema: { type: integer }, description: Seconds until the lock ends }
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Rfc7807ErrorEnvelope' }

    TooManyRequestsError:
      description: Rate or OTP limit reached (SEC_RATE_LIMIT_EXCEEDED, AUTH_OTP_RATE_LIMITED, AUTH_OTP_TOO_MANY_ATTEMPTS)
      headers:
        Retry-After: { schema: { type: integer }, description: Seconds to wait }
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Rfc7807ErrorEnvelope' }

    TokenPairResponse:
      description: Signed in; access + refresh token pair
      content:
        application/json:
          schema:
            allOf:
              - $ref: '#/components/schemas/StandardSuccessEnvelope'
              - type: object
                properties:
                  data: { $ref: '#/components/schemas/TokenPairDto' }
```


```yaml
  headers:
    PublicCacheControl:
      description: "public, max-age=60, stale-while-revalidate=300 (with a weak ETag; If-None-Match → 304)"
      schema: { type: string }
```

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
