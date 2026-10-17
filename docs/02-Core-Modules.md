# Document 02: Core Feature Modules (`02-Core-Modules.md`)

This document specifies the business domain modules (`src/modules/`) for the 80-room flat rental management system. Every domain module is built on \*\*NestJS, TypeORM, PostgreSQL, Redis, and `decimal.js**`, wrapping pure business logic inside the cross-cutting infrastructure defined in `01-Supporting-Modules.md` (`RlsService`, `DistributedLockModule`, `IdempotencyModule`, `CacheModule`, `OutboxModule`, `StorageModule`, and `DocumentReportModule`).

---

## 1\. Core Domain Directory Structure

src/modules/  
├── identity/                             \# Phone-number sign-in, OTP, sessions, accounts & RBAC assignment (global, no RLS)
│   ├── controllers/
│   │   ├── auth.controller.ts            \# /auth: login (+ OTP for finance roles), refresh rotation, logout, activation, reset, me, sessions
│   │   └── users.controller.ts           \# /users: landlord creates staff accounts, changes roles / buildings / status
│   ├── services/
│   │   ├── auth.service.ts               \# Credential check (argon2id), login lock, anti-enumeration, token pair issuance
│   │   ├── session.service.ts            \# auth_sessions, refresh rotation + reuse detection, revocation denylist
│   │   ├── otp.service.ts                \# HMAC-hashed 6-digit codes in Redis, cooldown / attempts / daily cap, Zalo (if linked) → SMS
│   │   ├── password-policy.service.ts    \# Length, phone-digits and common-password rules
│   │   ├── users.service.ts              \# Accounts, roles, building access, permission-cache eviction
│   │   └── tenant-account-provisioning.service.ts \# occupant.moved_in → TENANT login linked to tenants.user_id
│   ├── domain/
│   │   └── phone-number.ts               \# E.164 normalisation + Vietnamese mobile prefix validation, masking
│   ├── entities/
│   │   ├── user.entity.ts
│   │   ├── user-role.entity.ts
│   │   ├── user-building-access.entity.ts
│   │   └── auth-session.entity.ts
│   ├── dto/                              \# LoginDto, VerifyLoginOtpDto, RefreshTokenDto, RequestOtpDto, ActivateAccountDto, …
│   └── identity.module.ts                \# Also provides PERMISSION_RULES_LOADER (role_permissions + per-user overrides)
│  
├── tenants/                              \# Tenant Profiles, Encrypted PII & PDPL Consent Ledger  
│   ├── controllers/  
│   │   └── tenants.controller.ts         \# CRUD tenants, Blind Index lookup by Citizen ID (CCCD)  
│   ├── services/  
│   │   └── tenants.service.ts            \# AES-256-GCM FLE \+ HMAC-SHA256 hash \+ Law 91/2025 consent  
│   ├── entities/  
│   │   └── tenant.entity.ts              \# Tenant entity with FieldEncryptionTransformer  
│   ├── dto/  
│   │   ├── create-tenant.dto.ts  
│   │   └── tenant-response.dto.ts  
│   └── tenants.module.ts  
│  
├── properties/                           \# Building Layout, Room Tiers, 80 Rooms & Vacancy Engine  
│   ├── controllers/  
│   │   └── properties.controller.ts      \# Paginated room list, Room Detail, Cached Vacancy Summary  
│   ├── services/  
│   │   └── properties.service.ts         \# Index-backed QueryBuilder, XFetch cache & tag invalidation  
│   ├── guards/
│   │   └── room-access.guard.ts          \# TENANT: only the room they currently live in (OCCUPANCY_SELF_SCOPE)
│   ├── entities/  
│   │   ├── building.entity.ts  
│   │   ├── room-type.entity.ts  
│   │   └── room.entity.ts  
│   ├── dto/  
│   │   ├── query-rooms.dto.ts  
│   │   ├── room-list-item.dto.ts  
│   │   ├── room-detail.dto.ts  
│   │   └── vacancy-summary.dto.ts  
│   └── properties.module.ts  
│  
├── assets/                               \# Furniture & Appliance Rental Catalog & Room Assignment  
│   ├── controllers/  
│   │   └── assets.controller.ts          \# Catalog management, assign/unassign room appliances  
│   ├── services/  
│   │   └── assets.service.ts             \# Serial tracking, condition grading (A/B/C), rental pricing  
│   ├── entities/  
│   │   ├── asset.entity.ts  
│   │   └── room-asset.entity.ts  
│   └── assets.module.ts  
│  
├── contracts/                            \# Lease lifecycle, shared occupancy, contract holder, vehicles & deposit escrow
│   ├── controllers/
│   │   ├── contracts.controller.ts       \# Draft, Activate (1-month deposit intake), Renew
│   │   └── occupants.controller.ts       \# Move-in, move-out, contract-holder transfer, residence status
│   ├── domain/
│   │   ├── occupancy.enums.ts            \# IdDocumentType, OccupantRole, OccupancyStatus, ResidencyStatus…
│   │   └── occupancy.policy.ts           \# Capacity, successor selection (18+, ID, consent), EVN headcount
│   ├── services/
│   │   ├── contracts.service.ts          \# Room lock, contract activation with all occupants
│   │   ├── contract-occupancy.service.ts \# Move-in / move-out / holder transfer (shares the checkout lock)
│   │   └── deposit-escrow.service.ts     \# 1-month deposit ledger (incl. holder-transfer movements)
│   ├── entities/
│   │   ├── contract.entity.ts
│   │   ├── contract-occupant.entity.ts   \# EVERY resident: own CCCD, own residence status, one PRIMARY_HOLDER
│   │   ├── contract-holder-transfer.entity.ts \# Người đứng tên history + addendum
│   │   ├── contract-service.entity.ts    \# Recurring add-ons (Wi-Fi, Motorbike/Car Parking, Trash)
│   │   ├── contract-asset.entity.ts      \# Appliances rented under the lease
│   │   ├── tenant-vehicle.entity.ts      \# Vehicles owned by an occupant
│   │   └── deposit-ledger.entity.ts      \# Immutable deposit ledger
│   └── contracts.module.ts
│  
├── metering/                             \# Manual Guard Meter Photo Upload & Index Ingestion  
│   ├── controllers/  
│   │   └── metering.controller.ts        \# S3 Presigned PUT URL, Submit Reading, Missing Room Tracker  
│   ├── services/  
│   │   └── metering.service.ts           \# Delta validation, Meter Rollover/Reset & anomaly alerts  
│   ├── entities/  
│   │   └── meter-reading.entity.ts  
│   ├── dto/  
│   │   ├── create-presigned-url.dto.ts  
│   │   └── record-meter-reading.dto.ts  
│   └── metering.module.ts  
│  
├── billing/                              \# Monthly Invoicing, EVN Tariffs & Prorated Checkout Engine  
│   ├── controllers/  
│   │   ├── billing.controller.ts         \# Invoice queries, manual adjustments, Checkout Execution  
│   │   └── payment-webhook.controller.ts \# VietQR / Bank transfer HMAC-SHA256 webhook receiver  
│   ├── services/  
│   │   ├── billing-cron.service.ts       \# @DistributedCron (28th of month) batch invoice generator  
│   │   ├── utility-tariff.service.ts     \# EVN 6-tier residential quota vs. Tier 3 flat rate calculator  
│   │   ├── checkout-settlement.service.ts\# Exact-day prorated rent/assets/services \+ deposit deduction  
│   │   └── vietqr-payment.service.ts     \# Dynamic VietQR code generator & payment reconciliation  
│   ├── workers/  
│   │   └── invoice-generation.worker.ts  \# BullMQ consumer calculating invoices & rendering PDFs  
│   ├── entities/  
│   │   ├── invoice.entity.ts  
│   │   ├── invoice-line-item.entity.ts  
│   │   ├── checkout-settlement.entity.ts  
│   │   └── payment-transaction.entity.ts  
│   └── billing.module.ts  
│  
└── compliance-vn/                        \# Vietnam Statutory Tax, Residency (CT01 per person), Contracts & PCCC
    ├── controllers/
    │   └── compliance-vn.controller.ts   \# Tax Excel stream, legal PDFs, CT01 per occupant, residence work queue
    ├── services/
    │   ├── vn-tax-2026.service.ts        \# 1B VND threshold, 5% VAT \+ 5% excess PIT, Form 01/BĐS
    │   ├── vn-residency.service.ts       \# Per-occupant CT01, deregistration, household-head change, VNeID batch
    │   ├── vn-legal-pdf.service.ts       \# Builds StatutoryDocumentPayload for PdfGeneratorService
    │   ├── vn-einvoice.adapter.ts        \# Resilient adapter for VNPT/Viettel/MISA E-Invoice APIs
    │   └── vn-pccc-safety.service.ts     \# Fire Law 2024 compulsory insurance & equipment tracker
    ├── document-builders/                \# Payload builders rendered by infrastructure/document (pdfkit)
    │   ├── lease-contract.builder.ts     \# LEASE_CONTRACT — Housing Law 2023, Civil Code 2015, PCCC
    │   ├── handover-minutes.builder.ts   \# HANDOVER_MINUTES — assets & baseline meter indices
    │   ├── checkout-settlement.builder.ts\# CHECKOUT_SETTLEMENT — proration & deposit settlement
    │   ├── holder-transfer.builder.ts    \# HOLDER_TRANSFER_ADDENDUM — change of người đứng tên
    │   └── residence-ct01.builder.ts     \# RESIDENCE_CT01 — one form per occupant (Circular 66/2023/TT-BCA)
    └── compliance-vn.module.ts

---

## 2\. Module 1: `IdentityModule` & `TenantsModule`

### 2.0 Identity & Authentication (`IdentityModule`)

Endpoints: document 04, tag *Identity & Authentication*. Tables: document 03, section 3.0.

* **Sign-in with the phone number.** `PhoneNumber.normalize()` turns `0901 234 567`, `84901234567` or `+84 90 123 4567` into `+84901234567` (strict Vietnamese mobile prefixes; other countries in E.164 for foreign tenants). There is no email login.
* **Passwords:** argon2id (m = 19 MiB, t = 2, p = 1); 10–128 characters, must not contain the phone number's last 6 digits, rejected when on the common-password list (`422 AUTH_PASSWORD_POLICY_VIOLATION`).
* **Second factor for money:** `LANDLORD` and `ACCOUNTANT` confirm every login with a 6-digit OTP (`AUTH_MFA_ROLES`). OTPs are random, stored only as an HMAC in Redis, valid 5 minutes, 5 attempts, 60-second resend cooldown shared by all purposes, 5 activation / reset codes and 20 login codes per number per day (Vietnam calendar day), sent by SMS, or Zalo first when the account is linked to a Zalo user (`NotificationModule`). `AUTH_OTP_DEBUG_ECHO=true` (local / test only, refused in production) returns the code as `debugCode` for Postman.
* **Tokens:** 15-minute access JWT (`sub`, `sid`, `phoneMasked`, `buildingId`, `buildingIds`, `roles`) signed by the existing `JwtTokenService`; opaque refresh token `<sessionId>.<secret>` stored as HMAC-SHA256 keyed with `JWT_REFRESH_SECRET` and **rotated on every refresh** (row lock, so two simultaneous refreshes with one token cannot both win). Re-use of a rotated refresh token revokes the session and alerts the user. Sessions expire after 7 idle days or 30 days in total.
* **Revocation that works at once:** every revoked session gets `auth:revoked-sid:{sid}` in Redis for the access-token lifetime, and `JwtTokenService.verifyAccessToken()` rejects its tokens with `401 AUTH_SESSION_REVOKED`.
* **No account enumeration, no brute force:** the same `401 AUTH_CREDENTIALS_INVALID` for wrong password, unknown number and not-yet-activated accounts (unknown numbers are checked against a dummy hash); `@ThrottleSensitive()` per IP; 5 wrong passwords per number in 15 minutes → lock 15 minutes, doubling up to 24 hours (`423 AUTH_ACCOUNT_LOCKED`).
* **Accounts:** staff accounts are created by the landlord (`POST /users`). Tenant accounts are **created automatically** for every adult occupant with a phone number when they move in (`TenantAccountProvisioningService`, on `occupant.moved_in`), linked to `tenants.user_id` and activated by the tenant with an OTP. Role and building changes evict `permissions:user:{id}`; reducing access revokes the user's sessions.
* **Audit:** login success / failure, OTP sends, lockouts, password changes, session revocations and reuse detection are written to the WORM audit log (phone numbers masked).

#### 2.0.1 Login and refresh flow

```
POST /auth/login {phone, password}
  └─ normalize phone → auth:lock:{phoneKey}? → 423
  └─ load user (or dummy hash) → argon2.verify
       ├─ wrong → auth:login-fail++ (5 → lock) → 401 AUTH_CREDENTIALS_INVALID
       ├─ DISABLED → 403 AUTH_ACCOUNT_DISABLED
       ├─ finance role → OtpService.send(LOGIN_MFA) → 202 { challengeId }
       │                 POST /auth/login/mfa {challengeId, code} → continue below
       └─ SessionService.create(device, ip) → { accessToken (sid), refreshToken = sid.secret }

POST /auth/refresh {refreshToken = sid.secret}
  └─ lock row auth_sessions(sid) FOR UPDATE
       ├─ revoked / idle or absolute expiry passed → 401 AUTH_SESSION_REVOKED
       ├─ SHA256(secret) = previous_refresh_token_hash → revoke (ROTATION_REUSE_DETECTED),
       │     auth:revoked-sid, security alert → 401 AUTH_REFRESH_TOKEN_REUSED
       ├─ SHA256(secret) ≠ refresh_token_hash → 401 AUTH_TOKEN_INVALID
       └─ rotate: previous = current, current = SHA256(newSecret), idle expiry slides → new pair
```

#### 2.0.2 A tenant sees only the room they live in

`TENANT` has `rooms:read:own` and no `rooms:read:department`, so the room list and vacancy summary are closed to tenants. Room detail is guarded by `RoomAccessGuard`: staff holding `rooms:read:department` pass; anyone else passes **only** when their person profile is an `ACTIVE` occupant of that room's `ACTIVE` contract.

```ts
// src/core/access-control/occupancy-self-scope.ts — contract, implemented by ContractsModule (module 3)
export interface OccupancySelfScope {
  tenantId: string;
  contractId: string;
  roomId: string;
  occupantRole: OccupantRole;
}
export interface OccupancySelfScopeResolver {
  /** The caller's current room in this building, or null (never moved in / moved out / no tenant profile) */
  resolve(userId: string, buildingId: string): Promise<OccupancySelfScope | null>;
}
export const OCCUPANCY_SELF_SCOPE = Symbol('OCCUPANCY_SELF_SCOPE');
// Until ContractsModule registers the real resolver, the default returns null (fail-closed: tenants see no room).

// src/modules/properties/guards/room-access.guard.ts
@Injectable()
export class RoomAccessGuard implements CanActivate {
  constructor(
    private readonly abilityFactory: CaslAbilityFactory,
    @Inject(OCCUPANCY_SELF_SCOPE) private readonly selfScope: OccupancySelfScopeResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user: RequestUserContext = req.user;
    if (this.abilityFactory.hasScope(user, RentalResource.ROOMS, Action.READ, Scope.DEPARTMENT)) return true;

    const scope = await this.selfScope.resolve(user.id, user.tenantId); // cached 300 s
    if (scope?.roomId === req.params.id) return true;

    throw new ForbiddenException({
      errorCode: SystemErrorCode.AUTH_FORBIDDEN_RESOURCE,
      message: 'You can only view the room you currently live in.',
    });
  }
}

// src/modules/properties/controllers/properties.controller.ts
@Get('rooms/mine') // declared before rooms/:id
@RequirePermissions({ resource: RentalResource.ROOMS, action: Action.READ, scope: Scope.OWN })
getMyRoom(@CurrentUser() user: RequestUserContext) {
  return this.propertiesService.getRoomDetailForTenant(user); // 404 BIZ_NO_ACTIVE_ROOM when not living here
}

@Get('rooms/:id')
@RequirePermissions({ resource: RentalResource.ROOMS, action: Action.READ }) // OWN or DEPARTMENT
@UseGuards(RoomAccessGuard)
getRoomDetail(@Param('id', ParseUUIDStrictPipe) id: string) {
  return this.propertiesService.getRoomDetail(id);
}
```

* Staff with `rooms:read:department` pass through the building condition; a tenant opening another room, or their old room after moving out, gets `403 AUTH_FORBIDDEN_RESOURCE`.
* The self-scope result is cached as `auth:self-scope:{buildingId}:{userId}` (300 s) and evicted on `occupant.moved_in`, `occupant.moved_out`, `contract.primary_holder_changed` and checkout, so moving out closes access immediately.
* The same `OCCUPANCY_SELF_SCOPE` resolver backs every other `OWN` endpoint (the tenant's contract, occupancy, invoices, CT01) in later modules.

### 2.1 Domain Responsibilities & Legal Anchors

* **One profile per person, not per room.** A room can be shared (couples, families, roommates). Every person living there — the contract holder, every roommate, every child — gets a `tenants` profile with their **own** identity number. Nobody lives in a room without an ID on file.
  * **Adults:** CCCD (*Thẻ căn cước*), 12 digits.
  * **Children without a card:** the 12-digit **personal identification number** (*số định danh cá nhân*, same format, `idDocumentType = CCCD`).
  * **Foreigners:** passport (`idDocumentType = PASSPORT`); their temporary residence is declared through the foreigner channel (Law 47/2014/QH13, as amended), not Form CT01.
* **Personal Data Protection Law No. 91/2025/QH15 & Decree 13/2023/NĐ-CP:**
  * **Field-level encryption:** identity numbers and refund bank accounts are encrypted with `FieldEncryptionTransformer` (AES-256-GCM, `enc:v1:<iv>:<tag>:<cipher>`).
  * **Blind index (`idCardHash`):** `EncryptionService.computeBlindIndex()` (HMAC-SHA256 with `BLIND_INDEX_PEPPER`, normalised so `"079 203 001 234"` equals `"079203001234"`) is stored in the unique column `id_card_hash`, so duplicate checks and lookups by CCCD never decrypt rows.
  * **Consent per person:** `pdplConsentAcceptedAt` / `pdplConsentVersion` for everyone; for a child the consent is given by a parent or guardian (`consentGuardianTenantId`).
* **Reuse across rooms:** a person who moves to another room in the same building keeps the same profile (unique per building by `id_card_hash`); a person can only be an **active** occupant of one room at a time.

### 2.2 Service Implementation (`TenantsService`)

```ts
// src/modules/tenants/services/tenants.service.ts
@Injectable()
export class TenantsService {
  constructor(
    private readonly rlsService: RlsService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /** Registers ONE person (holder, roommate or child). Called once per occupant. */
  async createTenant(dto: CreateTenantDto) {
    const idNumber = dto.idCardNumber.replace(/[\s.-]/g, '').toUpperCase();
    const valid =
      dto.idDocumentType === IdDocumentType.PASSPORT
        ? REGEX_PATTERNS.PASSPORT.test(idNumber)
        : REGEX_PATTERNS.VIETNAM_CITIZEN_ID.test(idNumber); // CCCD or a child's personal ID number
    if (!valid) {
      throw new BadRequestException({ errorCode: SystemErrorCode.REQ_VALIDATION_ERROR, message: 'Invalid ID document number.' });
    }

    const minor = !isAdultOn(dto.dateOfBirth, todayInVietnam());
    if (minor && !dto.consentGuardianTenantId) {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.BIZ_PDPL_CONSENT_REQUIRED,
        message: 'A parent or guardian must give consent for a child.',
      });
    }
    if (!dto.pdplConsentAccepted) {
      throw new UnprocessableEntityException({ errorCode: SystemErrorCode.BIZ_PDPL_CONSENT_REQUIRED, message: 'Consent is required.' });
    }

    const idCardHash = this.encryptionService.computeBlindIndex(idNumber);

    return this.rlsService.runWithTenantTransaction(async (manager) => {
      // 1. Unique index scan on (building_id, id_card_hash) — no decryption
      const existing = await manager.findOne(Tenant, { where: { idCardHash }, select: ['id'] });
      if (existing) {
        throw new ConflictException({
          errorCode: SystemErrorCode.BIZ_TENANT_ID_CARD_DUPLICATE,
          message: 'This ID document is already registered; reuse the existing profile.',
          details: [{ field: 'idCardNumber', issue: 'DUPLICATE', tenantId: existing.id }],
        });
      }

      // 2. FieldEncryptionTransformer encrypts idCardEncrypted on INSERT; building_id injected by TenancySubscriber
      const saved = await manager.save(
        manager.create(Tenant, {
          fullName: dto.fullName.trim(),
          idDocumentType: dto.idDocumentType,
          idCardEncrypted: idNumber,
          idCardHash,
          idCardIssueDate: dto.idCardIssueDate ?? null,
          idCardIssuePlace: dto.idCardIssuePlace ?? null,
          nationality: dto.nationality ?? 'VN',
          gender: dto.gender,
          dateOfBirth: dto.dateOfBirth,
          phone: dto.phone?.trim() ?? null,
          email: dto.email?.trim() ?? null,
          hometownAddress: dto.hometownAddress,
          permanentAddress: dto.permanentAddress,
          refundBankAccountEncrypted: dto.refundBankAccount ?? null,
          refundBankName: dto.refundBankName ?? null,
          pdplConsentAcceptedAt: new Date(),
          pdplConsentVersion: 'v2026.1',
          consentGuardianTenantId: dto.consentGuardianTenantId ?? null,
        }),
      );

      // 3. Never return the raw number
      return {
        id: saved.id,
        fullName: saved.fullName,
        idDocumentType: saved.idDocumentType,
        idCardMasked: `********${idNumber.slice(-4)}`,
        isMinor: minor,
        phone: saved.phone,
        createdAt: saved.createdAt,
      };
    });
  }

  /** Exact lookup by CCCD / personal ID number / passport through the blind index */
  async findByIdNumber(rawIdNumber: string) {
    const idCardHash = this.encryptionService.computeBlindIndex(rawIdNumber);
    return this.rlsService.runWithTenantTransaction(async (manager) => {
      const tenant = await manager.findOne(Tenant, {
        where: { idCardHash },
        select: ['id', 'fullName', 'idDocumentType', 'phone', 'dateOfBirth', 'permanentAddress'],
      });
      if (!tenant) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Person not found' });
      return tenant;
    });
  }
}
```

---

## 3\. Module 2: `PropertiesModule` & `AssetsModule`

### 3.1 Domain Responsibilities & The 4 Optimization Mandates

* **Multi-Tier Room Hierarchy (Up to 80 Rooms):** Manages rooms across floors and categories (`STUDIO`, `1BR_DELUXE`, `DUPLEX`) with base pricing from `RoomType` and optional room-level price overrides (`basePriceOverride`).  
    
* **Appliance & Furniture Renting (`AssetsModule`):** Tracks individual rentable items (e.g., *Daikin Inverter 1.5HP AC*, *Electrolux Washer*, *Toshiba Fridge*, *Sofa Bed*) via `assets` (catalog) \$\\rightarrow\$ `room_assets` (physical unit with `serialNumber`, `conditionGrade`, and `customMonthlyFee` installed in a room) \$\\rightarrow\$ `contract_assets` (items actively rented by the tenant under a lease).  
    
* **Who sees which room:** staff (`rooms:read:department`) see every room of the active building; a `TENANT` (`rooms:read:own`) sees only the room they currently live in (`GET /properties/rooms/mine`, or `/{id}` of that room) — section 2.0.2.  
    
* **Strict Adherence to the 4 Database & API Optimization Rules:**  
    
1. **Index Optimization (No Sequential Scans):** Filtering and sorting use composite indexes `idx_rooms_bld_status_type (building_id, status, room_type_id)` and `idx_rooms_bld_floor_status (building_id, floor, status)`.  
     
2. **Zero N+1 Queries:** `getRoomDetail()` resolves the room, its `RoomType`, the active `Contract`, the primary `Tenant`, co-occupant headcount, and all assigned `RoomAsset` items in a **single TypeORM `SelectQueryBuilder` join**.  
     
3. **Lightweight RESTful Payloads:** `listRooms()` projects only 6 scalar fields (`id`, `roomNumber`, `floor`, `status`, `roomTypeName`, `effectivePrice`), omitting heavy contract histories, audit logs, and encrypted tenant PII.  
     
4. **Redis XFetch Caching & Tag Invalidation:** `getVacancySummary()` caches aggregated room availability by type in Redis using the **XFetch Probabilistic Early Expiration** algorithm and invalidates via non-blocking Redis `UNLINK` (`tag:{buildingId}:rooms`) whenever a contract is activated or a tenant checks out.

### 3.2 High-Performance TypeORM Implementation (`PropertiesService`)

// src/modules/properties/services/properties.service.ts  
import { Injectable, NotFoundException } from '@nestjs/common';  
import { EntityManager } from 'typeorm';  
import { RlsService } from '../../../core/multitenancy/rls.service';  
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';  
import { RequestContextService } from '../../../core/context/request-context.service';  
import { Room, RoomStatus } from '../entities/room.entity';  
import { RoomType } from '../entities/room-type.entity';  
import { QueryRoomsDto } from '../dto/query-rooms.dto';

@Injectable()  
export class PropertiesService {  
  constructor(  
    private readonly rlsService: RlsService,  
    private readonly cacheService: RedisCacheService,  
    private readonly contextService: RequestContextService,  
  ) {}

  /\*\*  
   \* OPTIMIZATION RULES \#1, \#2, \#3:  
   \* \- Covered by composite index idx\_rooms\_bld\_status\_type / idx\_rooms\_bld\_floor\_status  
   \* \- Single SQL query with INNER JOIN on room\_types (No N+1)  
   \* \- Lightweight projection (only 6 fields serialized over HTTP)  
   \*/  
  async listRooms(query: QueryRoomsDto) {  
    const { page \= 1, limit \= 20, status, roomTypeId, floor, sortBy \= 'roomNumber', sortOrder \= 'ASC' } \= query;  
    const offset \= (page \- 1\) \* limit;

    return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
      const qb \= manager  
        .createQueryBuilder(Room, 'r')  
        .innerJoin('r.roomType', 'rt')  
        .select(\[  
          'r.id AS "id"',  
          'r.roomNumber AS "roomNumber"',  
          'r.floor AS "floor"',  
          'r.status AS "status"',  
          'rt.name AS "roomTypeName"',  
          'COALESCE(r.basePriceOverride, rt.basePrice) AS "effectivePrice"',  
        \]);

      if (status) qb.andWhere('r.status \= :status', { status });  
      if (roomTypeId) qb.andWhere('r.roomTypeId \= :roomTypeId', { roomTypeId });  
      if (floor \!== undefined) qb.andWhere('r.floor \= :floor', { floor });

      const sortColumnMap: Record\<string, string\> \= {  
        roomNumber: 'r.roomNumber',  
        floor: 'r.floor',  
        effectivePrice: 'COALESCE(r.basePriceOverride, rt.basePrice)',  
      };

      qb.orderBy(sortColumnMap\[sortBy\] || 'r.roomNumber', sortOrder)  
        .offset(offset)  
        .limit(limit);

      const \[rawItems, totalItems\] \= await Promise.all(\[  
        qb.getRawMany(),  
        qb.getCount(),  
      \]);

      return {  
        items: rawItems.map((row) \=\> ({  
          id: row.id,  
          roomNumber: row.roomNumber,  
          floor: Number(row.floor),  
          status: row.status,  
          roomTypeName: row.roomTypeName,  
          effectivePrice: Number(row.effectivePrice),  
        })),  
        pagination: {  
          page,  
          limit,  
          totalItems,  
          totalPages: Math.ceil(totalItems / limit),  
        },  
      };  
    });  
  }

  /\*\*  
   \* OPTIMIZATION RULE \#2 & \#3:  
   \* Fetches complete room details, active lease, primary tenant, and assigned rental appliances  
   \* in a single joined query with explicit column selection (Zero N+1 queries).  
   \*/  
  async getRoomDetail(roomId: string) {  
    return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
      const room \= await manager  
        .createQueryBuilder(Room, 'r')  
        .innerJoin('r.roomType', 'rt')  
        .leftJoin('r.currentContract', 'c')  
        .leftJoin('c.primaryTenant', 'pt')  
        .leftJoin('c.occupants', 'o', "o.status = 'ACTIVE'") // only people living there now  
        .leftJoin('r.roomAssets', 'ra')  
        .leftJoin('ra.asset', 'a')  
        .select(\[  
          'r.id',  
          'r.roomNumber',  
          'r.floor',  
          'r.areaSqm',  
          'r.maxOccupants',  
          'r.status',  
          'r.basePriceOverride',  
          'rt.id',  
          'rt.name',  
          'rt.basePrice',  
          'c.id',  
          'c.contractCode',  
          'c.startDate',  
          'c.endDate',  
          'c.monthlyRoomRent',  
          'c.depositAmount',  
          'c.registeredEvnQuotaHeadcount',  
          'pt.id',  
          'pt.fullName',  
          'pt.phone',  
          'o.id',  
          'o.role',  
          'ra.id',  
          'ra.serialNumber',  
          'ra.conditionGrade',  
          'ra.customMonthlyFee',  
          'a.id',  
          'a.name',  
          'a.category',  
        \])  
        .where('r.id \= :roomId', { roomId })  
        .getOne();

      if (\!room) throw new NotFoundException(\`Room \${roomId} not found\`);

      return {  
        id: room.id,  
        roomNumber: room.roomNumber,  
        floor: room.floor,  
        areaSqm: Number(room.areaSqm),  
        maxOccupants: room.maxOccupants,  
        status: room.status,  
        roomTypeName: room.roomType.name,  
        effectiveRent: Number(room.basePriceOverride ?? room.roomType.basePrice),  
        activeContract: room.currentContract  
          ? {  
              id: room.currentContract.id,  
              contractCode: room.currentContract.contractCode,  
              primaryTenantName: room.currentContract.primaryTenant.fullName,  
              primaryTenantPhone: room.currentContract.primaryTenant.phone,  
              occupantCount: room.currentContract.occupants.length, // everyone living in the room  
              registeredResidentCount: room.currentContract.registeredEvnQuotaHeadcount, // residence REGISTERED (EVN quota)  
              monthlyRoomRent: Number(room.currentContract.monthlyRoomRent),  
              depositHeld: Number(room.currentContract.depositAmount),  
              startDate: room.currentContract.startDate,  
              endDate: room.currentContract.endDate,  
            }  
          : null,  
        rentedAssets: room.roomAssets.map((ra) \=\> ({  
          roomAssetId: ra.id,  
          name: ra.asset.name,  
          category: ra.asset.category,  
          serialNumber: ra.serialNumber,  
          conditionGrade: ra.conditionGrade,  
          monthlyFee: Number(ra.customMonthlyFee),  
        })),  
      };  
    });  
  }

  /\*\*  
   \* OPTIMIZATION RULE \#1 & \#4:  
   \* Aggregates vacancy counts by RoomType in a single SQL GROUP BY using idx\_rooms\_bld\_status\_type,  
   \* cached in Redis with XFetch Anti-Stampede protection and invalidated via tag 'rooms'.  
   \*/  
  async getVacancySummary() {  
    const buildingId \= this.contextService.getTenantId();  
    const cacheKey \= \`rooms:vacancies:summary\`;  

    return this.cacheService.getOrSet(  
      cacheKey,  
      async () \=\> {  
        return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
          const rows \= await manager  
            .createQueryBuilder(RoomType, 'rt')  
            .leftJoin(Room, 'r', 'r.roomTypeId \= rt.id AND r.deletedAt IS NULL')  
            .select(\[  
              'rt.id AS "roomTypeId"',  
              'rt.name AS "roomTypeName"',  
              'rt.basePrice AS "basePrice"',  
              'COUNT(r.id) AS "totalRooms"',  
              \`COUNT(r.id) FILTER (WHERE r.status \= '\${RoomStatus.AVAILABLE}') AS "availableRooms"\`,  
              \`COUNT(r.id) FILTER (WHERE r.status \= '\${RoomStatus.OCCUPIED}') AS "occupiedRooms"\`,  
              \`COUNT(r.id) FILTER (WHERE r.status \= '\${RoomStatus.MAINTENANCE}') AS "maintenanceRooms"\`,  
            \])  
            .groupBy('rt.id')  
            .orderBy('rt.basePrice', 'ASC')  
            .getRawMany();

          return rows.map((r) \=\> {  
            const total \= Number(r.totalRooms);  
            const occupied \= Number(r.occupiedRooms);  
            return {  
              roomTypeId: r.roomTypeId,  
              roomTypeName: r.roomTypeName,  
              basePrice: Number(r.basePrice),  
              totalRooms: total,  
              availableRooms: Number(r.availableRooms),  
              occupiedRooms: occupied,  
              maintenanceRooms: Number(r.maintenanceRooms),  
              occupancyPercentage: total \> 0 ? Number(((occupied / total) \* 100).toFixed(2)) : 0,  
            };  
          });  
        });  
      },  
      { ttlSeconds: 3600, tags: ['rooms'] } // key cache:{buildingId}:…, tag tag:{buildingId}:rooms,  
    );  
  }  
}

---

## 4\. Module 3: `MeteringModule` (Manual Guard Inspection & Photo Workflow)

### 4.1 Domain Responsibilities & Operational Safeguards

Because the 80-room business household building has no automated smart-meter IoT telemetry, the guard physically photographs each room's electricity and water sub-meters every month (and upon tenant check-out) and inputs the readings into the mobile app.

* **Zero-Proxy S3 Presigned PUT Upload:** The guard's mobile app requests a 15-minute presigned `PUT` URL from `StorageModule`, uploads the photo directly to S3/MinIO, and sends only the resulting `powerPhotoS3Key` and `waterPhotoS3Key` strings to the NestJS API.  
    
* **Missing Room Inspection Tracker:** Provides a real-time query listing which occupied rooms out of the 80 rooms still lack meter readings for the active billing month so no room is missed before the 28th billing cron.  
    
* **Delta Validation & Physical Meter Rollover (`isMeterReset`):**  
    
* Normal operation requires \$\\text{CurrentIndex} \\ge \\text{PreviousIndex}\$.  
    
* If a physical meter rolls over (`99999.9` \$\\rightarrow\$ `00000.0`) or is replaced due to hardware failure, the guard flags `isMeterReset: true` and provides `oldMeterFinalIndex` and `newMeterInitialIndex` so consumption is accurately computed as:

\$\$\\text{Consumption} \= (\\text{OldMeterFinalIndex} \- \\text{PrevIndex}) \+ (\\text{CurrentIndex} \- \\text{NewMeterInitialIndex})\$\$

* Abnormal spike detection (\> 250% of the room's 3-month rolling average) automatically dispatches a Telegram alert to the Property Manager via `NotificationModule`.

### 4.2 Guard Meter Ingestion Pipeline Diagram

\[Guard Mobile App\]                   \[NestJS MeteringModule\]                \[AWS S3 / MinIO\]  
        │                                       │                                   │  
        │ 1\. GET /metering/cycles/2026-10/missing-rooms                             │  
        ├──────────────────────────────────────►│                                   │  
        │◄──────────────────────────────────────┤                                   │  
        │    Returns 12 rooms pending inspection│                                   │  
        │                                       │                                   │  
        │ 2\. POST /metering/presigned-url       │                                   │  
        │    { roomId, meterType: 'POWER' }     │                                   │  
        ├──────────────────────────────────────►│ 3\. Sign S3 PUT Key (TTL: 900s)    │  
        │◄──────────────────────────────────────┤    (Private bucket path isolation)│  
        │    { uploadUrl, objectKey }           │                                   │  
        │                                       │                                   │  
        │ 4\. HTTP PUT Binary Photo (Direct to S3; Zero RAM/CPU load on NestJS)      │\[cite: 2, 4, 5\]  
        ├──────────────────────────────────────────────────────────────────────────►│  
        │                                       │                                   │  
        │ 5\. POST /metering/records (with Idempotency-Key header)                   │  
        │    { roomId, currPowerIndex, currWaterIndex, powerPhotoS3Key, ... }       │  
        ├──────────────────────────────────────►│                                   │  
        │                                       ├──► Acquire Redlock (room:meter)   │  
        │                                       ├──► Index Backward Scan Prev Meter │\[cite: 6\]  
        │                                       ├──► Validate Delta / Rollover      │  
        │                                       ├──► Save MeterReading \+ OutboxEvent│  
        │◄──────────────────────────────────────┤                                   │  
        │    201 Created (Wrapped in Envelope)  │                                   │

### 4.3 Service Implementation (`MeteringService`)

// src/modules/metering/services/metering.service.ts  
import { Injectable, BadRequestException } from '@nestjs/common';  
import { EntityManager } from 'typeorm';  
import Decimal from 'decimal.js';  
import { RlsService } from '../../../core/multitenancy/rls.service';  
import { DistributedLockService } from '../../../infrastructure/lock/services/distributed-lock.service';  
import { S3StorageService } from '../../../infrastructure/storage/services/s3-storage.service';  
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';  
import { FileVisibility } from '../../../infrastructure/storage/interfaces/storage.interface';  
import { STORAGE_CATEGORIES } from '../../../infrastructure/storage/utils/file-sanitizer.util';  
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';  
import { MeterReading } from '../entities/meter-reading.entity';  
import { Room, RoomStatus } from '../../properties/entities/room.entity';  
import { RecordMeterReadingDto } from '../dto/record-meter-reading.dto';

@Injectable()  
export class MeteringService {  
  constructor(  
    private readonly rlsService: RlsService,  
    private readonly lockService: DistributedLockService,  
    private readonly storageService: S3StorageService,  
    private readonly outboxService: OutboxService,  
  ) {}

  async generateGuardPhotoUploadUrl(roomId: string, meterType: 'POWER' | 'WATER', contentType: string) {  
    return this.storageService.generatePresignedUploadUrl({  
      visibility: FileVisibility.PRIVATE,  
      category: STORAGE_CATEGORIES.METER_PHOTOS, // buildings/{buildingId}/private/meter-photos/…  
      fileName: \`\${meterType.toLowerCase()}\_\${Date.now()}.jpg\`,  
      contentType,  
      expiresInSeconds: 900, // 15 minutes\[cite: 2, 4, 5, 7\]  
    });  
  }

  async recordManualReading(dto: RecordMeterReadingDto, guardUserId: string) {  
    const lockKey \= \`meter:room:\${dto.roomId}\`; // DistributedLockService prefixes lock:{buildingId}:

    return this.lockService.runWithLock(lockKey, async () \=\> {  
      return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
        // 1\. Fetch room and active contract ID  
        const room \= await manager.findOne(Room, {  
          where: { id: dto.roomId },  
          select: \['id', 'buildingId', 'roomNumber', 'currentContractId'\],  
        });  
        if (\!room) throw new BadRequestException('Invalid room ID');

        // 2\. Index Backward Scan via idx\_meter\_room\_date\_desc (Sub-millisecond, No Seq Scan)\[cite: 6\]  
        const prevReading \= await manager  
          .createQueryBuilder(MeterReading, 'mr')  
          .select(\['mr.id', 'mr.currPowerIndex', 'mr.currWaterIndex', 'mr.readingDate'\])  
          .where('mr.roomId \= :roomId', { roomId: dto.roomId })  
          .orderBy('mr.readingDate', 'DESC')  
          .addOrderBy('mr.createdAt', 'DESC')  
          .getOne();

        const prevPower \= new Decimal(prevReading?.currPowerIndex ?? 0);  
        const prevWater \= new Decimal(prevReading?.currWaterIndex ?? 0);  
        const currPower \= new Decimal(dto.currPowerIndex);  
        const currWater \= new Decimal(dto.currWaterIndex);

        let powerDelta: Decimal;  
        let waterDelta: Decimal;

        if (\!dto.isMeterReset) {  
          if (currPower.lessThan(prevPower)) {  
            throw new BadRequestException(  
              \`Current electricity reading (currPower)cannotbelowerthanpreviousreading({prevPower}) unless isMeterReset is flagged.\`,  
            );  
          }  
          if (currWater.lessThan(prevWater)) {  
            throw new BadRequestException(  
              \`Current water reading (currWater)cannotbelowerthanpreviousreading({prevWater}) unless isMeterReset is flagged.\`,  
            );  
          }  
          powerDelta \= currPower.minus(prevPower);  
          waterDelta \= currWater.minus(prevWater);  
        } else {  
          // Physical meter rollover or hardware replacement calculation  
          const oldPowerFinal \= new Decimal(dto.oldPowerMeterFinalIndex ?? prevPower);  
          const newPowerInit \= new Decimal(dto.newPowerMeterInitialIndex ?? 0);  
          powerDelta \= oldPowerFinal.minus(prevPower).plus(currPower.minus(newPowerInit));

          const oldWaterFinal \= new Decimal(dto.oldWaterMeterFinalIndex ?? prevWater);  
          const newWaterInit \= new Decimal(dto.newWaterMeterInitialIndex ?? 0);  
          waterDelta \= oldWaterFinal.minus(prevWater).plus(currWater.minus(newWaterInit));  
        }

        const reading \= manager.create(MeterReading, {  
          buildingId: room.buildingId,  
          roomId: room.id,  
          contractId: room.currentContractId,  
          billingPeriodMonth: dto.billingPeriodMonth,  
          readingDate: new Date().toISOString().split('T')\[0\],  
          prevPowerIndex: prevPower.toFixed(2),  
          currPowerIndex: currPower.toFixed(2),  
          powerConsumptionKwh: powerDelta.toFixed(2),  
          prevWaterIndex: prevWater.toFixed(2),  
          currWaterIndex: currWater.toFixed(2),  
          waterConsumptionM3: waterDelta.toFixed(2),  
          powerPhotoS3Key: dto.powerPhotoS3Key,  
          waterPhotoS3Key: dto.waterPhotoS3Key,  
          recordedByGuardId: guardUserId,  
          isMeterReset: Boolean(dto.isMeterReset),  
          isFinalCheckoutReading: Boolean(dto.isFinalCheckoutReading),  
        });

        const saved \= await manager.save(MeterReading, reading);

        // 3\. Emit transactional Outbox event for anomaly checks & realtime UI updates\[cite: 2, 4\]  
        await this.outboxService.createEventInTransaction(manager, {  
          aggregateType: 'METER_READING',  
          aggregateId: saved.id,  
          eventType: DOMAIN_EVENTS.METER_READING.RECORDED,  
          payload: {  
            readingId: saved.id,  
            roomId: room.id,  
            roomNumber: room.roomNumber,  
            powerConsumptionKwh: powerDelta.toNumber(),  
            waterConsumptionM3: waterDelta.toNumber(),  
            isFinalCheckoutReading: saved.isFinalCheckoutReading,  
          },  
        });

        return {  
          id: saved.id,  
          roomId: saved.roomId,  
          billingPeriodMonth: saved.billingPeriodMonth,  
          powerConsumptionKwh: powerDelta.toNumber(),  
          waterConsumptionM3: waterDelta.toNumber(),  
          isFinalCheckoutReading: saved.isFinalCheckoutReading,  
          createdAt: saved.createdAt,  
        };  
      });  
    }, { ttlMs: 10000 });  
  }

  /\*\*  
   \* Returns all OCCUPIED rooms in the building that do not yet have a meter reading  
   \* recorded for the target billing month (Guard Inspection Checklist).  
   \*/  
  async getRoomsMissingReadings(billingPeriodMonth: string) {  
    return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
      return manager  
        .createQueryBuilder(Room, 'r')  
        .leftJoin(  
          MeterReading,  
          'mr',  
          'mr.roomId \= r.id AND mr.billingPeriodMonth \= :billingPeriodMonth',  
          { billingPeriodMonth },  
        )  
        .select(\['r.id AS "roomId"', 'r.roomNumber AS "roomNumber"', 'r.floor AS "floor"'\])  
        .where('r.status \= :status', { status: RoomStatus.OCCUPIED })  
        .andWhere('mr.id IS NULL')  
        .orderBy('r.floor', 'ASC')  
        .addOrderBy('r.roomNumber', 'ASC')  
        .getRawMany();  
    });  
  }  
}

---

## 5\. Module 4: `ContractsModule` & `BillingModule`

### 5.1 Domain Responsibilities & Financial Mechanics

1. **1-Month Deposit Escrow (*Tiền đặt cọc*) (`ContractsModule`):**  
     
* Upon lease activation (`POST /contracts/:id/activate`), the system collects a standard **1-month security deposit** (`depositAmount = monthlyRoomRent`), sets `depositStatus = HELD`, and writes an immutable `COLLECTION` entry into `deposit_ledgers`.  
    
* Concurrency is protected at two levels: `DistributedLockService` (`lock:room:contract:{roomId}`) at the application layer and the PostgreSQL partial unique index `idx_unique_active_contract_per_room` at the database kernel layer.  
    
2. **EVN Electricity Tariff Compliance (`UtilityTariffService`):**  
     
* Complies with **Circular 16/2014/TT-BCT, Circular 25/2018/TT-BCT, and Circular 09/2023/TT-BCT**:  
    
* **Mode A — Tiered Residential Quota (*Định mức bậc thang*):** Every 4 registered temporary residents (`registeredEvnQuotaHeadcount`) receive 1 full household progressive quota (1 person \= 25% of each tier's kWh width; 2 people \= 50%; 3 people \= 75%; 4 people \= 100%).  
    
* **Headcount source:** `registeredEvnQuotaHeadcount` is recomputed by `countEvnQuotaHeadcount()` from occupants whose temporary residence is `REGISTERED`; people who live in the room but are not registered yet do not raise the quota.  
    
* **Mode B — Statutory Flat Tier 3 Rate:** When temporary stay headcount is unregistered or short-term, bills all kWh at the statutory EVN Retail Tier 3 rate (plus VAT), protecting the landlord from administrative fines under Decree 17/2022/NĐ-CP.  
    
3. **Mid-Month Clock-Out Proration & Deposit Reconciliation (`CheckoutSettlementService`):**  
     
* Tenants can clock out on any date of the month (`checkoutDate`).  
    
* Rather than using `checkoutDate.getDate()` (which fails if the lease started mid-month), the engine computes the **exact inclusive calendar days occupied** within the active billing window (`periodStartDate` to `checkoutDate`):

\$\$M \= \\text{DaysInCalendarMonth}(\\text{checkoutDate})\$\$

\$\$D \= \\lfloor (\\text{checkoutDate}*{\\text{UTC}} \- \\text{periodStartDate}*{\\text{UTC}}) / 86,400,000 \\rfloor \+ 1\$\$

\$\$\\text{Ratio} \= \\min\\left(1, \\frac{D}{M}\\right)\$\$

* Applies \$\\text{Ratio}\$ across **Base Room Rent**, **Rented Appliance/Furniture Fees (`contract_assets`)**, and **Fixed Recurring Services (`contract_services` like Wi-Fi and Parking)** using `decimal.js` (`ROUND_HALF_UP` to 0 decimal places for VND).  
* Adds final electricity and water charges (from the guard's `isFinalCheckoutReading = true` submission), any unpaid prior invoice balances, and asset damage penalties (`damagePenaltyFee`), then **deducts the 1-month security deposit (`depositAmount`)**.

### 5.2 Mid-Month Checkout & Deposit Settlement Flowchart

> **When is it a checkout?** Only when the room is handed back — the **last** occupant leaves. A co-occupant moving out, or the contract holder moving out while others stay, is handled by `ContractOccupancyService` (section 5.4) and does not prorate rent or touch the deposit settlement.

 \[Tenant Requests Clock-Out on Date X\]  
                                           │  
                                           ▼  
                   \[Guard Captures Final Sub-Meter Photos & Numbers\]  
                     (POST /metering/records, isFinalReading \= true)\[cite: 5, 7\]  
                                           │  
                                           ▼  
               \[POST /billing/checkout/execute (with Idempotency-Key)\]\[cite: 2, 4, 7\]  
                                           │  
                                           ▼  
           \[Acquire Redis Redlock: lock:checkout:contract:{contractId}\]\[cite: 2, 4\]  
                                           │  
             ┌─────────────────────────────┴─────────────────────────────┐  
             ▼                                                           ▼  
\[1. Prorate Fixed Monthly Charges\]                         \[2. Compute Final Utilities\]  
• DaysInMonth (M) \= 28 / 29 / 30 / 31                      • Power kWh \= Final \- Prev\[cite: 5\]  
• DaysOccupied (D) \= (Checkout \- PeriodStart) \+ 1          • Water m3  \= Final \- Prev\[cite: 5\]  
• ProratedRoomRent   \= round(RoomRent \* D / M)             • Apply EVN Quota or Flat Rate\[cite: 3\]  
• ProratedAssetRent  \= round(Sum(Appliances) \* D / M)      • Add Damage Penalties & Arrears  
• ProratedServices   \= round(Sum(Wi-Fi, Parking) \* D / M)  
             │                                                           │  
             └─────────────────────────────┬─────────────────────────────┘  
                                           │  
                                           ▼  
                         \[3. Reconcile Against 1-Month Deposit\]  
                   GrossObligation \= ProratedTotal \+ Utilities \+ Damages\[cite: 5\]  
                   NetBalance      \= GrossObligation \- DepositHeld\[cite: 5\]  
                                           │  
              ┌────────────────────────────┼────────────────────────────┐  
              ▼                            ▼                            ▼  
       NetBalance \> 0               NetBalance \== 0              NetBalance \< 0  
   \[TENANT OWES EXTRA\]          \[SETTLED EXACT TO ZERO\]     \[REFUND SURPLUS TO TENANT\]  
   Deposit: FORFEITED           Deposit: FULLY\_APPLIED      Deposit: PARTIALLY\_REFUNDED\[cite: 5\]  
   Generate Balance Invoice     Close Lease                 Generate Refund Voucher  
              │                            │                            │  
              └────────────────────────────┼────────────────────────────┘  
                                           │  
                                           ▼  
             \[4. ACID Commit: Settlement \+ DepositLedger \+ OutboxEvent\]\[cite: 2, 4\]  
             \[5. Transition Room Status \-\> MAINTENANCE & Unlink currentContractId\]\[cite: 5\]  
             \[6. Invalidate Redis Cache Tag: tag:{buildingId}:rooms (UNLINK)\]\[cite: 2, 4, 5\]

### 5.3 Service Implementation (`CheckoutSettlementService`)

// src/modules/billing/services/checkout-settlement.service.ts  
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';  
import { EntityManager } from 'typeorm';  
import Decimal from 'decimal.js';  
import { RlsService } from '../../../core/multitenancy/rls.service';  
import { DistributedLockService } from '../../../infrastructure/lock/services/distributed-lock.service';  
import { RedisCacheService } from '../../../infrastructure/cache/services/redis-cache.service';  
import { OutboxService } from '../../../infrastructure/outbox/services/outbox.service';  
import { Contract, ContractStatus, DepositStatus } from '../../contracts/entities/contract.entity';  
import { Room, RoomStatus } from '../../properties/entities/room.entity';  
import { MeterReading } from '../../metering/entities/meter-reading.entity';  
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';  
import { CheckoutSettlement } from '../entities/checkout-settlement.entity';  
import { DepositLedger, DepositLedgerType } from '../../contracts/entities/deposit-ledger.entity';  
import { UtilityTariffService } from './utility-tariff.service';  
import { ExecuteCheckoutDto } from '../dto/execute-checkout.dto';
import { ContractOccupancyService } from '../../contracts/services/contract-occupancy.service';  
import { LOCK_KEYS } from '../../../infrastructure/lock/constants/lock-keys.constant';  
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';  

@Injectable()  
export class CheckoutSettlementService {  
  constructor(  
    private readonly rlsService: RlsService,  
    private readonly lockService: DistributedLockService,  
    private readonly cacheService: RedisCacheService,  
    private readonly outboxService: OutboxService,  
    private readonly utilityTariffService: UtilityTariffService,  
    private readonly occupancyService: ContractOccupancyService,  
  ) {}

  async executeCheckout(dto: ExecuteCheckoutDto, actorUserId: string) {  
    const lockKey \= LOCK_KEYS.checkoutContract(dto.contractId); // same key as occupancy changes

    return this.lockService.runWithLock(lockKey, async () \=\> {  
      return this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
        // 1\. Single-query fetch of Contract \+ Rented Appliances \+ Subscribed Extra Services  
        const contract \= await manager  
          .createQueryBuilder(Contract, 'c')  
          .leftJoinAndSelect('c.rentedAssets', 'ca')  
          .leftJoinAndSelect('ca.roomAsset', 'ra')  
          .leftJoinAndSelect('c.serviceSubscriptions', 'cs')  
          .where('c.id \= :contractId', { contractId: dto.contractId })  
          .setLock('pessimistic\_write')  
          .getOne();

        if (\!contract || contract.status \!== ContractStatus.ACTIVE) {  
          throw new BadRequestException('Contract is not in ACTIVE state for checkout');  
        }

        // 2\. Verify Guard has submitted the Final Exit Meter Reading  
        const finalReading \= await manager.findOne(MeterReading, {  
          where: { contractId: contract.id, isFinalCheckoutReading: true },  
          orderBy: { readingDate: 'DESC', createdAt: 'DESC' },  
        });

        if (\!finalReading) {  
          throw new BadRequestException(  
            'Guard must upload final electricity and water meter photos and readings before checkout settlement.',  
          );  
        }

        // 3\. Determine exact billing window \[periodStartDate .. checkoutDate\]  
        const checkoutDate \= new Date(dto.checkoutDate);  
        const year \= checkoutDate.getUTCFullYear();  
        const month \= checkoutDate.getUTCMonth();  
        const daysInMonth \= new Decimal(new Date(Date.UTC(year, month \+ 1, 0)).getUTCDate());

        const firstOfCheckoutMonth \= new Date(Date.UTC(year, month, 1));  
        const contractStart \= new Date(contract.startDate);  
        const periodStartDate \= contractStart \> firstOfCheckoutMonth ? contractStart : firstOfCheckoutMonth;

        const msPerDay \= 86\_400\_000;  
        const diffDays \= Math.floor((checkoutDate.getTime() \- periodStartDate.getTime()) / msPerDay) \+ 1;  
        if (diffDays \<= 0\) {  
          throw new BadRequestException('Checkout date cannot precede the billing period start date');  
        }

        const daysOccupied \= Decimal.min(daysInMonth, new Decimal(diffDays));  
        const prorationRatio \= daysOccupied.div(daysInMonth);

        // 4\. Prorate Room Rent, Appliance Rent & Extra Services (Wi-Fi, Parking, Sanitation)  
        const monthlyRoomRent \= new Decimal(contract.monthlyRoomRent);  
        const monthlyAssetRent \= contract.rentedAssets.reduce(  
          (sum, item) \=\> sum.plus(new Decimal(item.roomAsset.customMonthlyFee)),  
          new Decimal(0),  
        );  
        const monthlyServiceFee \= contract.serviceSubscriptions.reduce(  
          (sum, sub) \=\> sum.plus(new Decimal(sub.unitPrice).mul(sub.quantity)),  
          new Decimal(0),  
        );

        const proratedRoomRent \= monthlyRoomRent.mul(prorationRatio).toDecimalPlaces(0, Decimal.ROUND\_HALF\_UP);  
        const proratedAssetRent \= monthlyAssetRent.mul(prorationRatio).toDecimalPlaces(0, Decimal.ROUND\_HALF\_UP);  
        const proratedServiceFee \= monthlyServiceFee.mul(prorationRatio).toDecimalPlaces(0, Decimal.ROUND\_HALF\_UP);

        // 5\. Calculate Final Electricity & Water Fees  
        const powerKwh \= new Decimal(finalReading.powerConsumptionKwh);  
        const waterM3 \= new Decimal(finalReading.waterConsumptionM3);

        const finalPowerFee \= this.utilityTariffService.calculateElectricityFee(  
          powerKwh,  
          contract.registeredEvnQuotaHeadcount,  
        );  
        const finalWaterFee \= this.utilityTariffService.calculateWaterFee(  
          waterM3,  
          contract.registeredEvnQuotaHeadcount,  
        );  
        const finalUtilityFee \= finalPowerFee.plus(finalWaterFee);

        // 6\. Sum any unpaid prior invoices \+ damage penalties  
        const unpaidInvoices \= await manager.find(Invoice, {  
          where: { contractId: contract.id, status: InvoiceStatus.PENDING },  
          select: \['id', 'netBalanceDue'\],  
        });  
        const unpaidPriorBalance \= unpaidInvoices.reduce(  
          (sum, inv) \=\> sum.plus(new Decimal(inv.netBalanceDue)),  
          new Decimal(0),  
        );

        const damagePenaltyFee \= new Decimal(dto.damagePenaltyFee ?? 0);  
        const grossObligation \= proratedRoomRent  
          .plus(proratedAssetRent)  
          .plus(proratedServiceFee)  
          .plus(finalUtilityFee)  
          .plus(damagePenaltyFee)  
          .plus(unpaidPriorBalance);

        // 7\. Deduct 1-Month Security Deposit ("Tiền đặt cọc")  
        const depositHeld \= new Decimal(contract.depositAmount);  
        const depositApplied \= Decimal.min(depositHeld, grossObligation);  
        const netSettlementBalance \= grossObligation.minus(depositHeld);

        // 8\. Persist CheckoutSettlement & DepositLedger entries  
        const settlement \= manager.create(CheckoutSettlement, {  
          buildingId: contract.buildingId,  
          contractId: contract.id,  
          checkoutDate: dto.checkoutDate,  
          settledWithTenantId: contract.primaryTenantId, // current người đứng tên  
          daysOccupied: daysOccupied.toNumber(),  
          daysInMonth: daysInMonth.toNumber(),  
          proratedRoomRent: proratedRoomRent.toFixed(2),  
          proratedAssetRent: proratedAssetRent.toFixed(2),  
          proratedServiceFee: proratedServiceFee.toFixed(2),  
          finalPowerFee: finalPowerFee.toFixed(2),  
          finalWaterFee: finalWaterFee.toFixed(2),  
          damagePenaltyFee: damagePenaltyFee.toFixed(2),  
          unpaidPriorBalance: unpaidPriorBalance.toFixed(2),  
          grossObligation: grossObligation.toFixed(2),  
          depositHeld: depositHeld.toFixed(2),  
          depositApplied: depositApplied.toFixed(2),  
          netSettlementBalance: netSettlementBalance.toFixed(2),  
          damageNotes: dto.damageNotes ?? null,  
        });  
        await manager.save(CheckoutSettlement, settlement);

        await manager.save(  
          DepositLedger,  
          manager.create(DepositLedger, {  
            buildingId: contract.buildingId,  
            contractId: contract.id,  
            transactionType: DepositLedgerType.CHECKOUT\_DEDUCTION,  
            counterpartyTenantId: contract.primaryTenantId,  
            amount: depositApplied.negated().toFixed(2),  
            balanceAfter: depositHeld.minus(depositApplied).toFixed(2),  
            recordedById: actorUserId,  
            notes: \`Deducted against checkout settlement on \${dto.checkoutDate}\`,  
          }),  
        );

        // 9\. Update Contract Status & Release Room to MAINTENANCE\[cite: 5\]  
        contract.status \= ContractStatus.TERMINATED;  
        contract.actualCheckoutDate \= dto.checkoutDate;  
        contract.depositStatus \= netSettlementBalance.lessThan(0)  
          ? DepositStatus.PARTIALLY\_REFUNDED  
          : DepositStatus.FORFEITED;  
        await manager.save(Contract, contract);

        await manager.update(  
          Room,  
          { id: contract.roomId },  
          { status: RoomStatus.MAINTENANCE, currentContractId: null },  
        );

        // 9b. Everyone still living in the room leaves with the holder: one residence deregistration per person  
        await this.occupancyService.moveOutAllOccupants(manager, contract.id, dto.checkoutDate);  

        // 10\. Publish Outbox Event (triggers PDF settlement generation & Zalo ZNS dispatch)\[cite: 2, 4\]  
        await this.outboxService.createEventInTransaction(manager, {  
          aggregateType: 'CONTRACT',  
          aggregateId: contract.id,  
          eventType: DOMAIN_EVENTS.CHECKOUT.SETTLED,  
          payload: {  
            contractId: contract.id,  
            roomId: contract.roomId,  
            netSettlementBalance: netSettlementBalance.toNumber(),  
          },  
        });

        // 11\. Invalidate Redis Vacancy Summary Cache via Non-Blocking Tag UNLINK\[cite: 2, 4, 5\]  
        await this.cacheService.invalidateTag('rooms'); // tag:{buildingId}:rooms, UNLINK

        return {  
          contractId: contract.id,  
          checkoutDate: dto.checkoutDate,  
          daysOccupied: daysOccupied.toNumber(),  
          daysInMonth: daysInMonth.toNumber(),  
          proratedRoomRent: proratedRoomRent.toNumber(),  
          proratedAssetRent: proratedAssetRent.toNumber(),  
          proratedServiceFee: proratedServiceFee.toNumber(),  
          finalUtilityFee: finalUtilityFee.toNumber(),  
          damagePenaltyFee: damagePenaltyFee.toNumber(),  
          unpaidPriorBalance: unpaidPriorBalance.toNumber(),  
          grossObligation: grossObligation.toNumber(),  
          depositHeld: depositHeld.toNumber(),  
          depositApplied: depositApplied.toNumber(),  
          netSettlementBalance: netSettlementBalance.toNumber(),  
          settlementAction: netSettlementBalance.greaterThan(0)  
            ? 'COLLECT\_ADDITIONAL\_FROM\_TENANT'  
            : netSettlementBalance.lessThan(0)  
            ? 'REFUND\_SURPLUS\_TO\_TENANT'  
            : 'EXACT\_ZERO\_SETTLEMENT',  
        };  
      });  
    }, { ttlMs: 15000 });  
  }  
}

---

### 5.4 Shared Rooms & the Contract Holder (`ContractOccupancyService`)

#### 5.4.1 Rules

| Rule | Where it is enforced |
| :-- | :-- |
| Every occupant has an ID document (CCCD / child's personal ID number / passport) and consent | `assertCanAddOccupant()`, `TenantsService` |
| Active occupants ≤ `rooms.max_occupants` | `assertCanAddOccupant()` under the contract lock |
| A person is an active occupant of one room at a time | `idx_occupants_tenant_one_active` (partial unique) |
| Exactly one active contract holder (*người đứng tên*) per contract, equal to `contracts.primary_tenant_id` | `idx_occupants_one_active_holder` + deferred trigger `trg_contract_primary_holder_consistency` |
| Every occupant is declared for temporary residence on move-in and deregistered on move-out | `residency_status` per occupant, daily compliance job |
| EVN tiered quota counts only occupants whose residence is `REGISTERED` | `countEvnQuotaHeadcount()` recomputes `registered_evn_quota_headcount` |
| Rent is per room: a co-occupant moving in or out changes neither the rent nor the deposit | — |
| Occupancy changes, holder transfers and checkout never run concurrently on one contract | `LOCK_KEYS.contractOccupancy(contractId)` = checkout lock |

#### 5.4.2 Flows

```
 [Co-occupant moves in]  POST /contracts/{id}/occupants
   lock checkout:contract:{id} → assertCanAddOccupant (ID, consent, capacity, not active elsewhere)
   → insert occupant (CO_OCCUPANT, ACTIVE, residency PENDING_DECLARATION, residence channel from ID type)
   → outbox occupant.moved_in + residence.declaration_required → CT01 PDF for THIS person

 [Co-occupant moves out]  POST /contracts/{id}/occupants/{occupantId}/move-out
   holder? → 409, use the transfer endpoint below
   → status MOVED_OUT, moved_out_at, residency DEREGISTRATION_PENDING
   → deactivate the person's vehicles, reduce the parking subscription
   → recompute EVN headcount → outbox occupant.moved_out + residence.deregistration_required

 [Contract holder moves out]  POST /contracts/{id}/primary-holder/transfer
   selectNextPrimaryHolder(occupants, holder, effectiveDate, newPrimaryTenantId?)
     ├─ nobody else lives there  → 409 BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT → POST /billing/checkout/execute
     ├─ only minors / ineligible → 409 BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED (register an adult first)
     └─ successor found (designated, else lowest successionOrder, else earliest moved in)
          → successor role PRIMARY_HOLDER, contracts.primary_tenant_id = successor   ← the contract's CCCD changes
          → outgoing holder MOVED_OUT (or CO_OCCUPANT when staying), residency DEREGISTRATION_PENDING
          → contract_holder_transfers row + deposit handling (CARRY_OVER | REFUND_AND_RECOLLECT)
          → addendum HOLDER_TRANSFER_ADDENDUM (landlord + outgoing + incoming holder sign)
          → remaining occupants registered as one household: residence.declaration_required (change of
            household head, Residence Law 2020 Art. 26)
          → outbox contract.primary_holder_changed → notify new holder & occupants (PRIMARY_HOLDER_CHANGED)

 [Last occupant / whole room leaves]  POST /billing/checkout/execute  (section 5.3)
   proration + deposit settlement with the holder → every active occupant MOVED_OUT, DEREGISTRATION_PENDING
```

**Money when the holder changes.** Rent stays per room. Invoices are addressed to the holder at issue time (`invoices.billed_to_tenant_id`): invoices issued before the transfer remain the outgoing holder's; later ones go to the successor. Unpaid invoices at the transfer date are written into the addendum (`outstandingBalance`, `outstandingBalanceAssumedBy`). The deposit either stays with the contract and is now owed to the successor (`HOLDER_TRANSFER_CARRY_OVER`, settled privately between the two people and recorded in the addendum), or is refunded to the outgoing holder and collected again from the successor (`HOLDER_TRANSFER_REFUND` + `HOLDER_TRANSFER_COLLECTION`). Every ledger row names the person (`counterparty_tenant_id`).

#### 5.4.3 Service Implementation

```ts
// src/modules/contracts/services/contract-occupancy.service.ts
@Injectable()
export class ContractOccupancyService {
  constructor(
    private readonly rlsService: RlsService,
    private readonly lockService: DistributedLockService,
    private readonly outboxService: OutboxService,
    private readonly cacheService: RedisCacheService,
    private readonly depositEscrow: DepositEscrowService,
  ) {}

  async addOccupant(contractId: string, dto: AddOccupantDto) {
    return this.lockService.runWithLock(LOCK_KEYS.contractOccupancy(contractId), () =>
      this.rlsService.runWithTenantTransaction(async (manager) => {
        const contract = await this.loadActiveContract(manager, contractId); // + room.maxOccupants
        const occupants = await this.loadSnapshots(manager, contractId);
        const person = await manager.findOneOrFail(Tenant, { where: { id: dto.tenantId } });

        assertCanAddOccupant(
          occupants,
          { tenantId: person.id, hasIdDocument: !!person.idCardHash, hasPdplConsent: !!person.pdplConsentAcceptedAt },
          contract.room.maxOccupants,
        );

        // idx_occupants_tenant_one_active rejects a person still living in another room (409)
        const occupant = await manager.save(
          manager.create(ContractOccupant, {
            contractId,
            tenantId: person.id,
            role: OccupantRole.CO_OCCUPANT,
            status: OccupancyStatus.ACTIVE,
            movedInAt: dto.movedInAt,
            successionOrder: dto.successionOrder ?? null,
            relationshipToHolder: dto.relationshipToHolder ?? null,
            residenceChannel: residenceChannelFor(person.idDocumentType),
            residencyStatus: ResidencyStatus.PENDING_DECLARATION,
          }),
        );

        await this.publish(manager, contractId, DOMAIN_EVENTS.OCCUPANT.MOVED_IN, { occupantId: occupant.id, tenantId: person.id });
        await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DECLARATION_REQUIRED, {
          occupantId: occupant.id,
          channel: occupant.residenceChannel,
        });
        return occupant;
      }),
    { ttlMs: 10_000 });
  }

  async transferPrimaryHolder(contractId: string, dto: TransferPrimaryHolderDto, approvedById: string) {
    return this.lockService.runWithLock(LOCK_KEYS.contractOccupancy(contractId), () =>
      this.rlsService.runWithTenantTransaction(async (manager) => {
        const contract = await this.loadActiveContract(manager, contractId);
        const occupants = await this.loadSnapshots(manager, contractId);

        // Pure policy: eligibility (18+, ID document, consent), succession order, last-occupant guard
        const successor = selectNextPrimaryHolder(occupants, contract.primaryTenantId, dto.effectiveDate, dto.newPrimaryTenantId);

        // 1. Outgoing holder leaves (or stays as a co-occupant) — order matters for the partial unique index
        await manager.update(
          ContractOccupant,
          { contractId, tenantId: contract.primaryTenantId, status: OccupancyStatus.ACTIVE },
          dto.outgoingHolderStays
            ? { role: OccupantRole.CO_OCCUPANT }
            : {
                role: OccupantRole.CO_OCCUPANT,
                status: OccupancyStatus.MOVED_OUT,
                movedOutAt: dto.effectiveDate,
                residencyStatus: ResidencyStatus.DEREGISTRATION_PENDING,
              },
        );
        // 2. Successor becomes người đứng tên — the contract's identity (holder CCCD) changes here
        await manager.update(ContractOccupant, { contractId, tenantId: successor.tenantId, status: OccupancyStatus.ACTIVE }, { role: OccupantRole.PRIMARY_HOLDER });
        await manager.update(Contract, { id: contractId }, { primaryTenantId: successor.tenantId });

        // 3. History, addendum number, outstanding balance and deposit movements
        const outstanding = await this.sumUnpaidInvoices(manager, contractId);
        const transfer = await manager.save(
          manager.create(ContractHolderTransfer, {
            contractId,
            fromTenantId: contract.primaryTenantId,
            toTenantId: successor.tenantId,
            effectiveDate: dto.effectiveDate,
            reason: dto.outgoingHolderStays ? HolderTransferReason.MUTUAL_AGREEMENT : HolderTransferReason.HOLDER_MOVED_OUT,
            selection: dto.newPrimaryTenantId ? HolderSelection.DESIGNATED : HolderSelection.AUTO_SUCCESSION,
            depositHandling: dto.depositHandling ?? HolderTransferDepositHandling.CARRY_OVER,
            outstandingBalance: outstanding.toFixed(2),
            outstandingBalanceAssumedBy: dto.outstandingBalanceAssumedBy ?? 'OUTGOING_HOLDER',
            addendumNo: await this.nextAddendumNo(manager, contract),
            approvedById,
          }),
        );
        await this.depositEscrow.recordHolderTransfer(manager, contract, transfer); // ledger rows per person

        // 4. Recompute the EVN quota from REGISTERED occupants (never increment)
        await manager.update(Contract, { id: contractId }, {
          registeredEvnQuotaHeadcount: countEvnQuotaHeadcount(await this.loadSnapshots(manager, contractId)),
        });

        // 5. Same transaction: addendum PDF, notifications, residence follow-ups, realtime update
        await this.publish(manager, contractId, DOMAIN_EVENTS.CONTRACT.PRIMARY_HOLDER_CHANGED, {
          transferId: transfer.id,
          fromTenantId: transfer.fromTenantId,
          toTenantId: transfer.toTenantId,
        });
        if (!dto.outgoingHolderStays) {
          await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DEREGISTRATION_REQUIRED, { tenantId: transfer.fromTenantId });
        }
        await this.cacheService.invalidateTag('rooms'); // room detail shows the holder
        return transfer;
      }),
    { ttlMs: 15_000 });
  }

  /** Used by CheckoutSettlementService inside its own transaction and lock */
  async moveOutAllOccupants(manager: EntityManager, contractId: string, checkoutDate: string) {
    await manager.update(
      ContractOccupant,
      { contractId, status: OccupancyStatus.ACTIVE },
      { status: OccupancyStatus.MOVED_OUT, movedOutAt: checkoutDate, residencyStatus: ResidencyStatus.DEREGISTRATION_PENDING },
    );
    await this.publish(manager, contractId, DOMAIN_EVENTS.RESIDENCE.DEREGISTRATION_REQUIRED, { allOccupants: true });
  }

  private publish(manager: EntityManager, contractId: string, eventType: string, payload: Record<string, unknown>) {
    return this.outboxService.createEventInTransaction(manager, { aggregateType: 'CONTRACT', aggregateId: contractId, eventType, payload });
  }
}
```

Error responses of these endpoints: `BIZ_OCCUPANT_ID_DOCUMENT_REQUIRED`, `BIZ_PDPL_CONSENT_REQUIRED`, `BIZ_OCCUPANT_LIMIT_EXCEEDED`, `BIZ_OCCUPANT_ALREADY_ACTIVE`, `BIZ_OCCUPANT_NOT_ACTIVE`, `BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE` (with reasons `UNDERAGE`, `MISSING_ID_DOCUMENT`, `MISSING_PDPL_CONSENT`, `NOT_ACTIVE`), `BIZ_PRIMARY_HOLDER_SUCCESSOR_REQUIRED`, `BIZ_LAST_OCCUPANT_REQUIRES_CHECKOUT`.

---

## 6\. Module 5: `ComplianceVnModule` (2026 Vietnam Legal, Tax, Residency & PCCC Engine)

### 6.1 Statutory & Tax Framework (2026 Regulations)

1. **2026 Property Rental Taxation (`VnTax2026Service`):**  
* Governed by the **Law on Personal Income Tax No. 109/2025/QH15 (Article 7, Clause 4\)**, **Law on VAT No. 48/2024/QH15 (amended by Law 149/2025/QH15)**, **Decree 68/2026/NĐ-CP (amended by Decree 141/2026/NĐ-CP)**, and **Circular 18/2026/TT-BTC & Circular 89/2026/TT-BTC**:  
* **Tax-Exempt Threshold:** **1,000,000,000 VND/year (1 tỷ đồng/năm)** across property leasing revenue (configurable via `AppConfigModule` to support historical audits under the pre-2026 100M VND rule).  
* **Business License Fee (*Lệ phí môn bài*):** **0 VND** (permanently abolished starting January 1, 2026 per **Resolution 198/2025/QH15**).  
* **Value-Added Tax (GTGT — 5%):** Once annual revenue exceeds 1,000,000,000 VND, VAT is calculated at \$5%\$ on total taxable rental revenue:

\$\$\\text{VAT Payable} \= \\text{Taxable Gross Revenue} \\times 5%\$\$

* **Personal Income Tax (TNCN — 5% on Excess):** PIT is calculated at \$5%\$ **strictly on the revenue portion exceeding 1,000,000,000 VND**:

\$\$\\text{PIT Payable} \= \\max(0, \\text{Taxable Gross Revenue} \- 1,000,000,000) \\times 5%\$\$

* **Pass-Through Utility Separation (*Thu hộ \- Chi hộ*):** Electricity and water collected from tenants at exact EVN/Water supplier rates without markup are segregated from taxable leasing revenue (`roomRentTotal + assetRentTotal + fixedServiceTotal`).  
    
* **Statutory Tax Exports:** Streams **Form 01/BĐS** (*Tờ khai thuế đối với hoạt động cho thuê bất động sản*) and **Annex 01/BK-BĐS** (*Bảng kê chi tiết bất động sản cho thuê*) using `ExcelJS.stream.xlsx.WorkbookWriter` (\< 60MB RAM).  
    
* **Mandatory E-Invoice Integration (`VnEInvoiceAdapter`):** Because an 80-room building exceeds 1 Billion VND/year, invoices are dispatched to VNPT/Viettel/MISA E-Invoice gateways via `ResilienceModule` (`@Resilient()` Circuit Breaker \+ Bulkhead) in compliance with **Decree 70/2025/NĐ-CP & Decree 68/2026/NĐ-CP**.  
    
2. **Residence Registration (`VnResidencyService`) — per person:**

* Complies with the **Law on Residence 2020** and **Circular 66/2023/TT-BCA**. Residence is declared for **each occupant**, not per room:

  | Occupant event | Residence action | Status |
  | :-- | :-- | :-- |
  | Moves in (contract activation or `POST /contracts/{id}/occupants`) | Temporary-residence registration — Form **CT01** for CCCD / personal-ID holders, foreigner temporary-residence declaration for passports | `PENDING_DECLARATION → SUBMITTED → REGISTERED` |
  | Moves out (co-occupant, holder transfer, checkout) | Deletion of temporary residence (*xóa đăng ký tạm trú*) | `DEREGISTRATION_PENDING → DEREGISTERED` |
  | Contract holder changes while the others were registered as one household | Change of household head (Residence Law 2020, Art. 26) for the remaining occupants | new CT01 per remaining occupant |
  | Temporary-residence term ends (`temporary_stay_valid_until`, max 2 years, Art. 27) | Extension | reminder from the daily job |

* **One CT01 PDF per occupant** (`RESIDENCE_CT01` document type, private `residence-ct01` storage): full name, date of birth, gender, personal identification number (decrypted only inside the builder), permanent address, relationship to the household head (`relationshipToHolder`) and the landlord's consent as owner of the lawful residence.
* **Daily work queue** (`RENTAL_SCHEDULES.COMPLIANCE_EXPIRY`, 02:00): occupants in `PENDING_DECLARATION` or `DEREGISTRATION_PENDING` (partial index `idx_occupants_residence_pending`) are sent to the building's managers (`RESIDENCE_ACTIONS_PENDING` Telegram template) and exported as a batch Excel / JSON file for the Ward Police (*Công an phường*) or VNeID / National Public Service Portal.
* Status updates (`PATCH /contracts/{id}/occupants/{occupantId}/residency`) recompute `registered_evn_quota_headcount`.

3. **Civil Code 2015, Housing Law 2023 & Fire Safety Law 2024 (`VnLegalPdfService` & `VnPcccSafetyService`):**  
     
* Renders bilingual or Vietnamese PDFs via Puppeteer (`DocumentReportModule`):  
    
* **Residential Lease Agreement (*Hợp đồng thuê nhà ở*):** Incorporates Civil Code 2015 (Articles 472–482), Housing Law 2023, and mandatory tenant fire safety (PCCC) rules.  
    
* **Asset & Meter Handover Minutes (*Biên bản bàn giao phòng, thiết bị & chỉ số điện nước*):** Lists every rented appliance's `serialNumber`, `conditionGrade`, and starting electricity/water indices.  
    
* **Checkout & Deposit Liquidation Statement (*Biên bản thanh lý hợp đồng & quyết toán tiền cọc*):** Itemizes prorated days stayed, final utility deltas, deposit deductions, and net refund/due amounts.  
    
* Tracks **Compulsory Fire & Explosion Insurance (*Bảo hiểm cháy nổ bắt buộc*)**, centralized fire alarm inspection logs (**QCVN 10:2025/BCA**), and fire extinguisher expiry dates required for buildings \$\\ge 5\$ floors or \$\\ge 1,000\\text{ m}^2\$ under **Fire Safety Law 2024, Decree 105/2025/NĐ-CP, and Decree 69/2026/NĐ-CP**.

### 6.2 Streaming 2026 Tax Declaration Service (`VnTax2026Service`)

// src/modules/compliance-vn/services/vn-tax-2026.service.ts  
import { Injectable } from '@nestjs/common';  
import { EntityManager } from 'typeorm';  
import \* as ExcelJS from 'exceljs';  
import { PassThrough } from 'node:stream';  
import Decimal from 'decimal.js';  
import { RlsService } from '../../../core/multitenancy/rls.service';  
import { AppConfigService } from '../../../core/config/app-config.service';  
import { Invoice, InvoiceStatus } from '../../billing/entities/invoice.entity';

@Injectable()  
export class VnTax2026Service {  
  private readonly VAT\_RATE \= new Decimal(0.05); // 5% GTGT\[cite: 3, 5\]  
  private readonly PIT\_RATE \= new Decimal(0.05); // 5% TNCN\[cite: 3, 5\]

  constructor(  
    private readonly rlsService: RlsService,  
    private readonly config: AppConfigService,  
  ) {}

  /\*\*  
   \* Calculates 2026 Vietnam Property Rental Tax (Law 109/2025/QH15 & Decree 141/2026/NĐ-CP)  
   \* \- Threshold: 1,000,000,000 VND / year  
   \* \- VAT: 5% of total taxable gross revenue  
   \* \- PIT: 5% ONLY on the revenue portion exceeding 1,000,000,000 VND  
   \* \- Business License Fee (Lệ phí môn bài): Abolished (0 VND)  
   \*/  
  computeTaxSummary(taxableGrossRevenue: Decimal, passThroughUtilities: Decimal) {  
    const threshold \= new Decimal(this.config.tax.annualExemptThresholdVnd ?? 1\_000\_000\_000);

    if (taxableGrossRevenue.lessThanOrEqualTo(threshold)) {  
      return {  
        taxableGrossRevenue: taxableGrossRevenue.toNumber(),  
        passThroughUtilities: passThroughUtilities.toNumber(),  
        exemptThreshold: threshold.toNumber(),  
        isTaxExempt: true,  
        eInvoiceMandatory: false,  
        vatPayable: 0,  
        pitPayable: 0,  
        businessLicenseFee: 0,  
        totalTaxPayable: 0,  
      };  
    }

    const vatPayable \= taxableGrossRevenue  
      .mul(this.VAT\_RATE)  
      .toDecimalPlaces(0, Decimal.ROUND\_HALF\_UP);

    const excessRevenue \= taxableGrossRevenue.minus(threshold);  
    const pitPayable \= excessRevenue  
      .mul(this.PIT\_RATE)  
      .toDecimalPlaces(0, Decimal.ROUND\_HALF\_UP);

    return {  
      taxableGrossRevenue: taxableGrossRevenue.toNumber(),  
      passThroughUtilities: passThroughUtilities.toNumber(),  
      exemptThreshold: threshold.toNumber(),  
      isTaxExempt: false,  
      eInvoiceMandatory: true,  
      vatPayable: vatPayable.toNumber(),  
      pitPayable: pitPayable.toNumber(),  
      businessLicenseFee: 0,  
      totalTaxPayable: vatPayable.plus(pitPayable).toNumber(),  
    };  
  }

  /\*\*  
   \* Streams Form 01/BĐS & Annex 01/BK-BĐS (Circular 18/2026/TT-BTC) via ExcelJS WorkbookWriter  
   \* keeping Node.js memory flat (\< 60MB RAM)\[cite: 2, 4\].  
   \*/  
  async streamForm01BdsExcel(taxYear: number, quarter?: number): Promise\<PassThrough\> {  
    const stream \= new PassThrough();

    // Run streaming generation asynchronously into the PassThrough stream  
    void this.rlsService.runWithTenantTransaction(async (manager: EntityManager) \=\> {  
      const workbook \= new ExcelJS.stream.xlsx.WorkbookWriter({  
        stream,  
        useStyles: true,  
      });

      const sheet \= workbook.addWorksheet('01-BK-BDS\_2026');  
      sheet.columns \= \[  
        { header: 'STT', key: 'index', width: 8 },  
        { header: 'Mã Hợp Đồng (Contract Code)', key: 'contractCode', width: 24 },  
        { header: 'Phòng (Room)', key: 'roomNumber', width: 12 },  
        { header: 'Họ tên bên thuê (Tenant Name)', key: 'tenantName', width: 28 },  
        { header: 'Kỳ thanh toán (Billing Period)', key: 'period', width: 16 },  
        { header: 'Doanh thu tiền phòng & thiết bị (Taxable VND)', key: 'taxableRev', width: 26 },  
        { header: 'Thu hộ Điện/Nước (Pass-Through VND)', key: 'utilityRev', width: 24 },  
      \];

      const qb \= manager  
        .createQueryBuilder(Invoice, 'inv')  
        .innerJoin('inv.contract', 'c')  
        .innerJoin('c.room', 'r')  
        .innerJoin('c.primaryTenant', 'pt')  
        .select(\[  
          'inv.id AS "id"',  
          'inv.billingPeriodMonth AS "period"',  
          'inv.roomRentTotal AS "roomRent"',  
          'inv.assetRentTotal AS "assetRent"',  
          'inv.fixedServiceTotal AS "serviceFee"',  
          'inv.powerFeeTotal AS "powerFee"',  
          'inv.waterFeeTotal AS "waterFee"',  
          'c.contractCode AS "contractCode"',  
          'r.roomNumber AS "roomNumber"',  
          'pt.fullName AS "tenantName"',  
        \])  
        .where('EXTRACT(YEAR FROM inv.billingPeriodMonth) \= :taxYear', { taxYear })  
        .andWhere('inv.status IN (:...statuses)', {  
          statuses: \[InvoiceStatus.PAID, InvoiceStatus.PARTIALLY\_PAID, InvoiceStatus.PENDING\],  
        })  
        .orderBy('inv.billingPeriodMonth', 'ASC')  
        .addOrderBy('r.roomNumber', 'ASC');

      if (quarter) {  
        qb.andWhere('EXTRACT(QUARTER FROM inv.billingPeriodMonth) \= :quarter', { quarter });  
      }

      const rows \= await qb.getRawMany();

      let totalTaxable \= new Decimal(0);  
      let totalPassThrough \= new Decimal(0);

      rows.forEach((row, idx) \=\> {  
        const taxable \= new Decimal(row.roomRent)  
          .plus(row.assetRent)  
          .plus(row.serviceFee);  
        const utilities \= new Decimal(row.powerFee).plus(row.waterFee);

        totalTaxable \= totalTaxable.plus(taxable);  
        totalPassThrough \= totalPassThrough.plus(utilities);

        sheet  
          .addRow({  
            index: idx \+ 1,  
            contractCode: row.contractCode,  
            roomNumber: row.roomNumber,  
            tenantName: row.tenantName,  
            period: row.period,  
            taxableRev: taxable.toNumber(),  
            utilityRev: utilities.toNumber(),  
          })  
          .commit();  
      });

      const summary \= this.computeTaxSummary(totalTaxable, totalPassThrough);

      sheet.addRow({}).commit();  
      sheet  
        .addRow({  
          tenantName: 'TỔNG DOANH THU TÍNH THUẾ (GROSS TAXABLE):',  
          taxableRev: summary.taxableGrossRevenue,  
          utilityRev: summary.passThroughUtilities,  
        })  
        .commit();  
      sheet  
        .addRow({  
          tenantName: 'THUẾ GTGT PHẢI NỘP (VAT 5%):',  
          taxableRev: summary.vatPayable,  
        })  
        .commit();  
      sheet  
        .addRow({  
          tenantName: 'THUẾ TNCN PHẢI NỘP (PIT 5% TRÊN PHẦN VƯỢT 1 TỶ):',  
          taxableRev: summary.pitPayable,  
        })  
        .commit();  
      sheet  
        .addRow({  
          tenantName: 'TỔNG THUẾ PHẢI NỘP (TOTAL TAX PAYABLE):',  
          taxableRev: summary.totalTaxPayable,  
        })  
        .commit();

      await workbook.commit();  
    });

    return stream;  
  }  
}
