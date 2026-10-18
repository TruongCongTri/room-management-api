# Document 03: Database Architecture (`03-Database.md`)

This document defines the normalized **PostgreSQL + TypeORM** schema of the 80-room flat rental platform: **21 operational tables** across 4 bounded contexts plus **5 reference tables** seeded by the platform. It uses composite B-Tree and partial unique indexes, Row-Level Security per building, WORM audit triggers, and AES-256-GCM field-level encryption with deterministic blind indexing.

> **Shared rooms.** A room is rented under **one contract** but can be shared by **several people**. Every person — the contract holder (*người đứng tên*), roommates, family members, children — is a `tenants` row with their **own** encrypted CCCD (or the 12-digit personal identification number of a child, or a passport for foreigners) and their **own** temporary-residence declaration. Exactly **one** active occupant is the contract holder; when that person moves out while others remain, the contract is transferred to the next eligible occupant (section 3.2, tables 7–8b) and the contract's identity (holder CCCD) changes with it.

---

## 1\. Entity-Relationship Architecture

```
+------------------------------------------------------------------------------------------------+
| 0. IDENTITY & ACCESS (4, global — no RLS: sign-in happens before a building is chosen)         |
|  [users] (login = phone_e164) 1 ── * [user_roles] * ── 1 [system_roles]                        |
|          1 ── * [user_building_access] * ── 1 [buildings]                                      |
|          1 ── * [auth_sessions]   refresh-token rotation, revocation                           |
|          1 ── * [tenants.user_id] a TENANT login ↔ their person profile (one per building)     |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 1. PROPERTY & ASSET TOPOLOGY (5)                                                               |
|  [buildings] 1 ── * [rooms] * ── 1 [room_types]            rooms.max_occupants = capacity        |
|                        └── 1 ── * [room_assets] * ── 1 [assets]                                 |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 2. TENANTS, SHARED OCCUPANCY, LEASES & DEPOSIT ESCROW (8)                                      |
|  [rooms] 1 ── * [contracts] ── primary_tenant_id ──> [tenants]  (current người đứng tên)        |
|                     │                                                                          |
|                     ├── 1 ── * [contract_occupants] * ── 1 [tenants]                            |
|                     │         EVERY resident: own CCCD / passport (AES-256-GCM + blind index),  |
|                     │         own residence status (CT01), exactly ONE active PRIMARY_HOLDER     |
|                     ├── 1 ── * [contract_holder_transfers]   người đứng tên history + addendum  |
|                     ├── 1 ── * [contract_assets] * ── 1 [room_assets]                           |
|                     ├── 1 ── * [contract_services] * ── 1 [service_catalogs]                    |
|                     ├── 1 ── * [tenant_vehicles]  (owner = an occupant)                         |
|                     └── 1 ── * [deposit_ledgers]  (1-month deposit escrow)                      |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 3. METERING, BILLING & CHECKOUT (5)                                                            |
|  [contracts] 1 ── * [meter_readings]                                                            |
|              1 ── 1 [checkout_settlements]   settled with the holder at checkout                |
|              1 ── * [invoices]  billed_to_tenant_id = holder when issued                        |
|                        ├── 1 ── * [invoice_line_items]                                          |
|                        └── 1 ── * [payment_transactions]                                        |
+------------------------------------------------------------------------------------------------+
                                            │
+------------------------------------------------------------------------------------------------+
| 4. COMPLIANCE, AUDIT & ASYNC INFRASTRUCTURE (3)                                                |
|  [pccc_compliance_logs]  [audit_logs] (WORM)  [outbox_events] (FOR UPDATE SKIP LOCKED)          |
+------------------------------------------------------------------------------------------------+
| REFERENCE DATA (5, global, seeded): system_roles, role_permissions, evn_tariff_tiers,           |
|                                     statutory_tax_rules, statutory_forms                       |
+------------------------------------------------------------------------------------------------+
```

---

## 2\. Base Entities & Naming Strategy

Domain tables inherit from two base classes. Column names are converted to `snake_case` by `SnakeNamingStrategy`.

```ts
// src/core/database/base.entity.ts — global / catalog tables
export abstract class EnterpriseBaseEntity extends BaseEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
  @DeleteDateColumn({ type: 'timestamptz', nullable: true }) deletedAt?: Date | null; // soft delete
  @VersionColumn({ default: 1 }) version: number; // optimistic locking
}

// src/core/multitenancy/tenant-base.entity.ts — building-scoped tables (RLS + TenancySubscriber)
export abstract class BuildingScopedEntity extends EnterpriseBaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'building_id', update: false })
  buildingId: string;
}
```

* `TenancySubscriber` fills `building_id` from the verified request context and rejects cross-building writes; PostgreSQL RLS (section 4) is the second layer.
* Every migration creating a building-scoped table calls `SELECT setup_building_rls('<table>')`.
* Shared enums for occupancy live in `src/modules/contracts/domain/occupancy.enums.ts` (`IdDocumentType`, `OccupantRole`, `OccupancyStatus`, `ResidencyStatus`, `ResidenceChannel`, `HolderTransferDepositHandling`).

---

## 3\. TypeORM Entity Specifications

> **Precision Note:** PostgreSQL `numeric(12, 2)` columns are typed as `string` in TypeORM entities to prevent JavaScript IEEE-754 floating-point precision loss before passing values into `decimal.js`.

### 3.0 Bounded Context 0: Identity & Access (global tables, no RLS)

Sign-in happens **before** a building is chosen, so these tables are global (no `building_id`, no RLS). Access to them is enforced by `IdentityModule`: users, roles and sessions are only reachable through `/auth/*` (the caller's own rows) and `/users` (`LANDLORD`, limited to people who share one of the landlord's buildings).

* **Login identifier = phone number** in E.164 (`+84901234567`), unique among live accounts. Email is not used for sign-in.
* **One account per person.** A tenant who also works as a guard has one account with both roles.
* **Roles are per account** and apply in every building listed in `user_building_access`; the access token carries those buildings as `buildingIds` (switch with `X-Building-ID`).
* **Tenant link:** a `TENANT` account points to the person's profile through `tenants.user_id` (one profile per building). Which room the tenant may open is derived from their **active occupancy**, never stored on the account.
* Short-lived state — OTP codes, login lock counters, revoked-session markers — lives in Redis (table at the end of this section), not in PostgreSQL.

#### I-1. `User` (`users`)

```ts
// src/modules/identity/entities/user.entity.ts
export enum UserStatus {
  PENDING_ACTIVATION = 'PENDING_ACTIVATION', // created by the landlord or at move-in; no password yet
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED', // by the landlord; all sessions revoked
}

@Entity('users')
export class User extends EnterpriseBaseEntity {
  // E.164, normalised by PhoneNumber.normalize(); unique among live rows (idx_users_phone_unique, section 4)
  @Column({ type: 'varchar', length: 16 })
  phoneE164: string;

  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt?: Date | null; // set by the first successful OTP (activation)

  @Column({ type: 'varchar', length: 150 })
  fullName: string;

  // argon2id ($argon2id$v=19$m=19456,t=2,p=1$...). Never selected unless asked for explicitly.
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  passwordHash?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt?: Date | null;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING_ACTIVATION })
  status: UserStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt?: Date | null;

  @Column({ type: 'varchar', length: 10, default: 'vi-VN' })
  preferredLocale: string; // OTP and security-alert language

  @OneToMany(() => UserRole, (r) => r.user)
  roles: UserRole[];

  @OneToMany(() => UserBuildingAccess, (a) => a.user)
  buildingAccess: UserBuildingAccess[];
}
```

#### I-2. `UserRole` (`user_roles`)

```ts
// src/modules/identity/entities/user-role.entity.ts
@Entity('user_roles')
export class UserRole {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  roleCode: string; // FK system_roles.code — LANDLORD | PROPERTY_MANAGER | ACCOUNTANT | GUARD | TENANT

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string | null; // null = system (tenant provisioning)

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, (u) => u.roles, { onDelete: 'CASCADE' })
  user: User;
}
```

#### I-3. `UserBuildingAccess` (`user_building_access`)

```ts
// src/modules/identity/entities/user-building-access.entity.ts
@Entity('user_building_access')
@Index('idx_user_building_access_building', ['buildingId'])
export class UserBuildingAccess {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @PrimaryColumn({ type: 'uuid' })
  buildingId: string; // FK buildings.id

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, (u) => u.buildingAccess, { onDelete: 'CASCADE' })
  user: User;
}
```

#### I-4. `AuthSession` (`auth_sessions`)

One row per signed-in device. The refresh token is `<sessionId>.<secret>`; only `HMAC-SHA256(secret, JWT_REFRESH_SECRET)` is stored, so a copy of this table alone cannot be used to forge tokens. On every refresh the hash is replaced and the old one moved to `previous_refresh_token_hash`: if that old token is ever presented again, the session is revoked with `ROTATION_REUSE_DETECTED`.

```ts
// src/modules/identity/entities/auth-session.entity.ts
export enum SessionRevokedReason {
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  ROTATION_REUSE_DETECTED = 'ROTATION_REUSE_DETECTED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  ACCESS_REDUCED = 'ACCESS_REDUCED', // role or building removed by the landlord
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  REVOKED_BY_USER = 'REVOKED_BY_USER', // DELETE /auth/sessions/{id}
}

@Entity('auth_sessions')
@Index('idx_auth_sessions_user_active', ['userId', 'lastUsedAt'], { where: '"revoked_at" IS NULL' })
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id: string; // = `sid` claim of every access token of this session

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'char', length: 64 })
  refreshTokenHash: string;

  @Column({ type: 'char', length: 64, nullable: true })
  previousRefreshTokenHash?: string | null;

  @Column({ type: 'int', default: 0 })
  rotationCount: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  deviceId?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  deviceName?: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent?: string | null;

  @Column({ type: 'varchar', length: 45 })
  ipAddress: string; // last IP that used the session

  @Column({ type: 'timestamptz', nullable: true })
  mfaVerifiedAt?: Date | null; // finance roles: when the OTP step was passed

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;

  @Column({ type: 'timestamptz' })
  idleExpiresAt: Date; // lastUsedAt + AUTH_REFRESH_IDLE_DAYS (7)

  @Column({ type: 'timestamptz' })
  absoluteExpiresAt: Date; // createdAt + AUTH_REFRESH_ABSOLUTE_DAYS (30), never extended

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ type: 'enum', enum: SessionRevokedReason, nullable: true })
  revokedReason?: SessionRevokedReason | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;
}
```

#### I-5. Short-lived identity state in Redis

`phoneKey` = `HMAC-SHA256(phoneE164, BLIND_INDEX_PEPPER)` (`EncryptionService.computeBlindIndex`), so raw phone numbers never appear in Redis keys.

| Key | Value | TTL | Purpose |
| :-- | :-- | :-- | :-- |
| `otp:ACTIVATE_ACCOUNT:{phoneKey}`, `otp:RESET_PASSWORD:{phoneKey}` | `{ challengeId, codeHash, userId }` | 300 s | Current activation / reset code (body carries the phone); a new code replaces the old one |
| `otp:LOGIN_MFA:{challengeId}` | `{ challengeId, codeHash, userId, deviceId, deviceName, ip }` | 300 s | Login second factor (body carries only the challenge id); bound to the device and IP of the password step |
| `otp:attempts:{challengeId}` | counter | 300 s | Wrong codes; the 5th burns the challenge |
| `otp:cooldown:{phoneKey}` | `1` | 60 s | Resend cooldown, set for unknown numbers too |
| `otp:daily:{purpose}:{phoneKey}:{yyyymmdd}` | counter | until end of day (VN time) | Max 5 activation / reset codes and 20 login codes per number per day |
| `auth:login-fail:{phoneKey}` | counter | 900 s | Wrong passwords within the window (unknown numbers included) |
| `auth:lock:{phoneKey}` | `{ until, level }` | lock length | Lock after 5 failures: 15 min, doubling per level up to 24 h (`auth:lock-level:{phoneKey}`); the level resets 24 h after the last lock **ended** |
| `auth:revoked-sid:{sid}` | `1` | access-token lifetime (900 s) | Checked by `JwtTokenService.verifyAccessToken()` → `401 AUTH_SESSION_REVOKED` |
| `auth:self-scope:{buildingId}:{userId}` | `{ tenantId, contractId, roomId, occupantRole }` or `none` | 300 s | Cached result of `OCCUPANCY_SELF_SCOPE` (the tenant's current room); evicted on `occupant.moved_in`, `occupant.moved_out`, `contract.primary_holder_changed` and checkout |

### 3.1 Bounded Context 1: Property & Asset Topology

* `buildings` is global (no RLS): access goes through `user_building_access`. `room_types`, `rooms`, `assets` and `room_assets` are building-scoped (RLS).
* **Same-building guarantee in the kernel:** every child row references its parent together with `building_id` (composite foreign keys onto `UNIQUE (building_id, id)`), so a room can never use another building's room type and an appliance unit can never sit in another building's room — even with raw SQL that bypasses the application.
* `rooms.current_contract_id` is created here; its foreign key to `contracts` is added by the Contracts migration (module 3).
* Rooms, room types, buildings and catalogue items are never deleted (financial and residence history); a room is taken out of service with status `MAINTENANCE`. Installed appliance units are soft-deleted when disposed of.

#### 1\. `Building` (`buildings`)

Stores the physical building profile, landlord tax registration code, and statutory fire safety metadata.

// src/modules/properties/entities/building.entity.ts

import { Entity, Column, OneToMany, Index } from 'typeorm';

import { EnterpriseBaseEntity } from '../../../core/database/base.entity';

import { Room } from './room.entity';

export enum ElectricityBillingMode {

  EVN\_TIERED\_QUOTA \= 'EVN\_TIERED\_QUOTA', // Circular 16/2014 & 09/2023/TT-BCT progressive tiers

  EVN\_TIER\_3\_FLAT \= 'EVN\_TIER\_3\_FLAT',   // Statutory Tier 3 retail flat rate for unregistered quotas

}

@Entity('buildings')

export class Building extends EnterpriseBaseEntity {

  @Index('idx\_buildings\_code\_unique', { unique: true })

  @Column({ type: 'varchar', length: 30 })

  code: string; // e.g., "BLD-HCM-Q7-01"

  @Column({ type: 'varchar', length: 150 })

  name: string;

  @Column({ type: 'varchar', length: 255 })

  addressLine: string;

  @Column({ type: 'varchar', length: 100 })

  ward: string;

  @Column({ type: 'varchar', length: 100 })

  district: string;

  @Column({ type: 'varchar', length: 100, default: 'Thành phố Hồ Chí Minh' })

  city: string;

  @Index('idx\_buildings\_tax\_code')

  @Column({ type: 'varchar', length: 30 })

  landlordTaxCode: string; // Business Household Tax ID (Mã số thuế hộ kinh doanh)

  @Column({ type: 'varchar', length: 150 })

  landlordFullName: string;

  @Column({ type: 'varchar', length: 50, nullable: true })

  bankAccountNumber?: string | null; // Used for VietQR dynamic invoice generation

  @Column({ type: 'varchar', length: 20, nullable: true })

  bankBinCode?: string | null; // NAPAS Bank BIN (e.g., "970436" for Vietcombank)

  @Column({ type: 'smallint', default: 80 })

  totalRoomsCapacity: number;

  @Column({

    type: 'enum',

    enum: ElectricityBillingMode,

    default: ElectricityBillingMode.EVN\_TIERED\_QUOTA,

  })

  electricityBillingMode: ElectricityBillingMode;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 25000 })

  defaultWaterRatePerM3: string;

  // Portfolio website (module 1b): shown on /public/* only when listed AND a slug is set

  @Column({ type: 'boolean', default: false })

  isPubliclyListed: boolean;

  @Index('idx_buildings_public_slug_unique', { unique: true, where: '"public_slug" IS NOT NULL' })

  @Column({ type: 'varchar', length: 80, nullable: true })

  publicSlug?: string | null; // e.g. "sunrise-quan-7"

  @Column({ type: 'text', nullable: true })

  publicDescription?: string | null;

  @OneToMany(() \=\> Room, (room) \=\> room.building)

  rooms: Room\[\];

}

#### 2\. `RoomType` (`room_types`)

Normalizes room tiers (`STUDIO`, `1BR_DELUXE`, `DUPLEX`) and their baseline monthly rent.

// src/modules/properties/entities/room-type.entity.ts

import { Entity, Column, OneToMany, Index } from 'typeorm';

import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

import { Room } from './room.entity';

@Entity('room\_types')

@Index('idx\_room\_types\_bld\_code\_unique', \['buildingId', 'code'\], { unique: true })

export class RoomType extends BuildingScopedEntity {

  @Column({ type: 'varchar', length: 50 })

  code: string; // e.g., "STUDIO\_BALCONY", "1BR\_DELUXE"

  @Column({ type: 'varchar', length: 100 })

  name: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  baseMonthlyRent: string; // Standard monthly price in VND

  @Column({ type: 'numeric', precision: 6, scale: 2 })

  standardAreaSqm: string;

  @Column({ type: 'smallint', default: 2 })

  defaultMaxOccupants: number;

  @OneToMany(() \=\> Room, (room) \=\> room.roomType)

  rooms: Room\[\];

}

#### 3\. `Room` (`rooms`)

Represents each of the 80 individual flats, indexed for sub-millisecond filtering, sorting, and vacancy aggregation without sequential scans.

// src/modules/properties/entities/room.entity.ts

import { Entity, Column, ManyToOne, OneToMany, OneToOne, JoinColumn, Index } from 'typeorm';

import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

import { Building } from './building.entity';

import { RoomType } from './room-type.entity';

import { Contract } from '../../contracts/entities/contract.entity';

import { RoomAsset } from '../../assets/entities/room-asset.entity';

import { MeterReading } from '../../metering/entities/meter-reading.entity';

export enum RoomStatus {

  AVAILABLE \= 'AVAILABLE',

  RESERVED \= 'RESERVED',

  OCCUPIED \= 'OCCUPIED',

  MAINTENANCE \= 'MAINTENANCE',

}

@Entity('rooms')

// Composite indexes engineered for Optimization Rule \#1 (Zero Sequential Scans)

@Index('idx\_rooms\_bld\_status\_type', \['buildingId', 'status', 'roomTypeId'\])

@Index('idx\_rooms\_bld\_floor\_status', \['buildingId', 'floor', 'status'\])

@Index('idx\_rooms\_bld\_number\_unique', \['buildingId', 'roomNumber'\], { unique: true })

export class Room extends BuildingScopedEntity {

  @ManyToOne(() \=\> Building, (b) \=\> b.rooms, { onDelete: 'RESTRICT' })

  @JoinColumn({ name: 'building\_id' })

  building: Building;

  @Column({ type: 'varchar', length: 20 })

  roomNumber: string; // e.g., "P.302"

  @Column({ type: 'smallint' })

  floor: number;

  @Column({ type: 'numeric', precision: 6, scale: 2 })

  areaSqm: string;

  @Column({ type: 'smallint', default: 2 })

  maxOccupants: number;

  @Column({ type: 'uuid' })

  roomTypeId: string;

  @ManyToOne(() \=\> RoomType, (rt) \=\> rt.rooms, { onDelete: 'RESTRICT' })

  @JoinColumn({ name: 'room\_type\_id' })

  roomType: RoomType;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })

  priceOverride?: string | null; // Optional custom room rate overriding RoomType.baseMonthlyRent

  @Column({ type: 'enum', enum: RoomStatus, default: RoomStatus.AVAILABLE })

  status: RoomStatus;

  @Column({ type: 'uuid', nullable: true, unique: true })

  currentContractId?: string | null;

  // Portfolio website (module 1b): false hides this room from /public/* (default: shown)

  @Column({ type: 'boolean', default: true })

  isPubliclyListed: boolean;

  @OneToOne(() \=\> Contract, { nullable: true, onDelete: 'SET NULL' })

  @JoinColumn({ name: 'current\_contract\_id' })

  currentContract?: Contract | null;

  @OneToMany(() \=\> Contract, (c) \=\> c.room)

  contractHistory: Contract\[\];

  @OneToMany(() \=\> RoomAsset, (ra) \=\> ra.room)

  roomAssets: RoomAsset\[\];

  @OneToMany(() \=\> MeterReading, (mr) \=\> mr.room)

  meterReadings: MeterReading\[\];

}

#### 4\. `Asset` (`assets`) & 5\. `RoomAsset` (`room_assets`)

Separates the master appliance/furniture catalog (`assets`) from physical serial-numbered units installed in specific rooms (`room_assets`).

// src/modules/assets/entities/asset.entity.ts

import { Entity, Column, OneToMany, Index } from 'typeorm';

import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

import { RoomAsset } from './room-asset.entity';

export enum AssetCategory {

  APPLIANCE \= 'APPLIANCE', // Air conditioner, fridge, washing machine, microwave

  FURNITURE \= 'FURNITURE', // Bed frame, mattress, wardrobe, sofa, work desk

}

@Entity('assets')

@Index('idx\_assets\_bld\_code\_unique', \['buildingId', 'code'\], { unique: true })

export class Asset extends BuildingScopedEntity {

  @Column({ type: 'varchar', length: 50 })

  code: string; // e.g., "AC\_DAIKIN\_1\_5HP"

  @Column({ type: 'varchar', length: 150 })

  name: string; // e.g., "Máy lạnh Daikin Inverter 1.5 HP"

  @Column({ type: 'enum', enum: AssetCategory })

  category: AssetCategory;

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  standardMonthlyRentalFee: string; // Default monthly rental fee in VND

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })

  replacementValue: string; // Used for checkout damage compensation reference

  @OneToMany(() \=\> RoomAsset, (ra) \=\> ra.asset)

  roomInstallations: RoomAsset\[\];

}

// src/modules/assets/entities/room-asset.entity.ts

import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';

import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

import { Room } from '../../properties/entities/room.entity';

import { Asset } from './asset.entity';

export enum AssetConditionGrade {

  GRADE\_A\_NEW \= 'GRADE\_A\_NEW',   // 95% \- 100% condition

  GRADE\_B\_GOOD \= 'GRADE\_B\_GOOD', // 80% \- 94% condition

  GRADE\_C\_FAIR \= 'GRADE\_C\_FAIR', // Functional with cosmetic wear

  BROKEN \= 'BROKEN',

}

@Entity('room\_assets')

@Index('idx\_room\_assets\_room\_id', \['roomId'\])

// Unique among INSTALLED units only (partial: deleted_at IS NULL) so a disposed unit's serial can be installed again

@Index('idx\_room\_assets\_bld\_serial\_unique', \['buildingId', 'serialNumber'\], { unique: true, where: '"deleted_at" IS NULL' })

export class RoomAsset extends BuildingScopedEntity {

  @Column({ type: 'uuid' })

  roomId: string;

  @ManyToOne(() \=\> Room, (r) \=\> r.roomAssets, { onDelete: 'CASCADE' })

  @JoinColumn({ name: 'room\_id' })

  room: Room;

  @Column({ type: 'uuid' })

  assetId: string;

  @ManyToOne(() \=\> Asset, (a) \=\> a.roomInstallations, { onDelete: 'RESTRICT' })

  @JoinColumn({ name: 'asset\_id' })

  asset: Asset;

  @Column({ type: 'varchar', length: 100 })

  serialNumber: string; // Manufacturer serial / QR tag

  @Column({

    type: 'enum',

    enum: AssetConditionGrade,

    default: AssetConditionGrade.GRADE\_A\_NEW,

  })

  conditionGrade: AssetConditionGrade;

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  customMonthlyFee: string; // Negotiated or room-specific monthly rental fee

  @Column({ type: 'date' })

  installedDate: string;

}

---

### 3.2 Bounded Context 2: Tenants, Shared Occupancy, Leases, Extra Services & Deposit Escrow

#### 6\. `Tenant` (`tenants`) — one row per person

Every person living in a room has a profile, **including roommates and children**. Identity numbers and refund bank accounts are encrypted with `FieldEncryptionTransformer` (AES-256-GCM, Law 91/2025/QH15 & Decree 13/2023/NĐ-CP); `id_card_hash` is the deterministic `HMAC-SHA256` blind index (`EncryptionService.computeBlindIndex`, pepper `BLIND_INDEX_PEPPER`) used for duplicate detection and exact lookup without decryption.

* **ID document is mandatory for everyone:** CCCD (*Thẻ căn cước*) for adults; for children without a card, the 12-digit **personal identification number** (*số định danh cá nhân*, same format as the CCCD number); passport for foreigners (`id_document_type = PASSPORT`, declared through the foreigner temporary-residence channel instead of CT01).
* **Consent:** every person's data needs verifiable consent; for a child it is recorded through a parent / guardian (`consent_guardian_tenant_id`, Decree 13/2023/NĐ-CP, Art. 20).
* A person is unique per building by `(building_id, id_card_hash)`; moving between rooms reuses the same profile.
* **Never decrypted in normal use:** the encrypted columns are `select: false`; lists, lookups and detail screens show `id_card_last4` / `refund_bank_account_last4` only. A profile correction (`PATCH /tenants/{id}`) loads them in memory to re-validate the merged profile against the stored number and never returns them; otherwise only the CT01 builder (module 6) decrypts.
* **Guardian:** a child's `consent_guardian_tenant_id` must point to an adult profile of the **same building** (composite FK) with its own consent; adults have no guardian.
* **Login link (`user_id`):** when an **adult occupant with a phone number** moves in, `TenantAccountProvisioningService` finds the account with the same normalised phone number or creates one (`PENDING_ACTIVATION`, role `TENANT`, access to this building) and stores its id here. Children and people without a phone have no login. One account per profile per building (`idx_tenants_bld_user_unique`).

```ts
// src/modules/tenants/entities/tenant.entity.ts
@Entity('tenants')
@Index('idx_tenants_bld_id_hash_unique', ['buildingId', 'idCardHash'], { unique: true })
@Index('idx_tenants_bld_phone', ['buildingId', 'phone'])
@Index('idx_tenants_bld_name_search', ['buildingId', 'fullNameSearch'])
@Index('idx_tenants_bld_user_unique', ['buildingId', 'userId'], { unique: true, where: '"user_id" IS NOT NULL AND "deleted_at" IS NULL' })
@Unique('uq_tenants_bld_id', ['buildingId', 'id']) // target of the same-building guardian FK
export class Tenant extends BuildingScopedEntity {
  @Column({ type: 'varchar', length: 150 })
  fullName: string;

  // Lower-case, without Vietnamese diacritics ("nguyen van an" for "Nguyễn Văn An") - search without unaccent()
  @Column({ type: 'varchar', length: 150 })
  fullNameSearch: string;

  @Column({ type: 'enum', enum: IdDocumentType, default: IdDocumentType.CCCD })
  idDocumentType: IdDocumentType;

  // enc:v1:<iv>:<tag>:<cipher> — CCCD / personal ID number (12 digits) or passport number.
  // select: false - never loaded (and therefore never decrypted) unless a query asks for it explicitly
  @Column({ type: 'text', select: false, transformer: new FieldEncryptionTransformer() })
  idCardEncrypted: string;

  // HMAC-SHA256(normalized number, BLIND_INDEX_PEPPER), 64 hex chars
  @Column({ type: 'char', length: 64 })
  idCardHash: string;

  // Last 4 characters, for masked display ("********1234") without decrypting
  @Column({ type: 'varchar', length: 4 })
  idCardLast4: string;

  // Nullable: children identified only by a personal ID number have no card
  @Column({ type: 'date', nullable: true })
  idCardIssueDate?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  idCardIssuePlace?: string | null; // e.g. "Bộ Công an"

  // Private scans (identity-documents category) - columns ready, upload endpoints not in scope yet
  @Column({ type: 'varchar', length: 255, nullable: true })
  idDocumentFrontKey?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idDocumentBackKey?: string | null;

  @Column({ type: 'char', length: 2, default: 'VN' })
  nationality: string; // ISO 3166-1 alpha-2

  @Column({ type: 'varchar', length: 10 })
  gender: 'MALE' | 'FEMALE'; // required by CT01

  @Column({ type: 'date' })
  dateOfBirth: string; // decides whether the person can become contract holder (18+)

  // E.164 (+84901234567), same normalisation as the login phone: matches users.phone_e164 at move-in
  @Column({ type: 'varchar', length: 16, nullable: true })
  phone?: string | null; // required for adults, optional for children

  @Column({ type: 'varchar', length: 150, nullable: true })
  email?: string | null;

  @Column({ type: 'varchar', length: 255 })
  hometownAddress: string; // Quê quán

  @Column({ type: 'varchar', length: 255 })
  permanentAddress: string; // Nơi thường trú (CT01)

  // Only meaningful for the person who may receive a deposit refund; select: false like the ID number
  @Column({ type: 'text', nullable: true, select: false, transformer: new FieldEncryptionTransformer() })
  refundBankAccountEncrypted?: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  refundBankAccountLast4?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  refundBankName?: string | null;

  // Verifiable consent (Law 91/2025/QH15); for a child, given by the guardian below
  @Column({ type: 'timestamptz' })
  pdplConsentAcceptedAt: Date;

  @Column({ type: 'varchar', length: 30, default: 'v2026.1' })
  pdplConsentVersion: string;

  // Same-building composite FK (building_id, consent_guardian_tenant_id) → tenants (building_id, id)
  @Column({ type: 'uuid', nullable: true })
  consentGuardianTenantId?: string | null;

  // TENANT login of this person (users.id); null for children / no phone. Room access comes from occupancy.
  @Column({ type: 'uuid', nullable: true })
  userId?: string | null;

  @OneToMany(() => ContractOccupant, (co) => co.tenant)
  occupancies: ContractOccupant[]; // module 3
}
```

#### 7\. `Contract` (`contracts`)

One contract per room tenancy. It carries the rent, the **1-month security deposit** (*tiền đặt cọc*) and a pointer to the **current contract holder**. Who lives in the room is in `contract_occupants`; who held the contract over time is in `contract_holder_transfers`.

* `primary_tenant_id` is a denormalised pointer to the occupant with `role = PRIMARY_HOLDER` and `status = ACTIVE`. `ContractOccupancyService` changes both in the same transaction and the deferred trigger `trg_contract_primary_holder_consistency` (section 4) rejects any commit where they disagree.
* `registered_evn_quota_headcount` is **recomputed** (never incremented) from occupants whose residence is `REGISTERED` every time an occupancy or residence status changes. It defaults to 0, so a room with nobody registered is billed at the flat tier-3 rate.

```ts
// src/modules/contracts/entities/contract.entity.ts
export enum ContractStatus { DRAFT = 'DRAFT', ACTIVE = 'ACTIVE', TERMINATED = 'TERMINATED', EXPIRED = 'EXPIRED' }

export enum DepositStatus {
  PENDING_COLLECTION = 'PENDING_COLLECTION',
  HELD = 'HELD',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  FULLY_REFUNDED = 'FULLY_REFUNDED',
  FORFEITED = 'FORFEITED',
}

@Entity('contracts')
@Index('idx_contracts_bld_status_room', ['buildingId', 'status', 'roomId'])
@Index('idx_contracts_primary_tenant', ['primaryTenantId'])
@Index('idx_contracts_dates', ['buildingId', 'startDate', 'endDate'])
export class Contract extends BuildingScopedEntity {
  @Index('idx_contracts_code_unique', { unique: true })
  @Column({ type: 'varchar', length: 50 })
  contractCode: string; // e.g. "HD-2026/080-P302"

  @Column({ type: 'uuid' })
  roomId: string;

  @ManyToOne(() => Room, (r) => r.contractHistory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  // Current người đứng tên — always equal to the ACTIVE PRIMARY_HOLDER occupant (checked at COMMIT)
  @Column({ type: 'uuid' })
  primaryTenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'primary_tenant_id' })
  primaryTenant: Tenant;

  @Column({ type: 'date' }) startDate: string;
  @Column({ type: 'date' }) endDate: string;
  @Column({ type: 'date', nullable: true }) actualCheckoutDate?: string | null; // room handed back

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monthlyRoomRent: string; // per room, not per person

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  depositAmount: string; // standard 1-month deposit

  @Column({ type: 'enum', enum: DepositStatus, default: DepositStatus.HELD })
  depositStatus: DepositStatus;

  @Column({ type: 'smallint', default: 5 })
  paymentDueDay: number;

  // Recomputed from occupants with residencyStatus = REGISTERED (Circular 09/2023/TT-BCT)
  @Column({ type: 'smallint', default: 0 })
  registeredEvnQuotaHeadcount: number;

  @Column({ type: 'boolean', default: true })
  pcccCommitmentSigned: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  signedContractPdfS3Key?: string | null;

  @Column({ type: 'enum', enum: ContractStatus, default: ContractStatus.DRAFT })
  status: ContractStatus;

  @OneToMany(() => ContractOccupant, (co) => co.contract, { cascade: true }) occupants: ContractOccupant[];
  @OneToMany(() => ContractHolderTransfer, (t) => t.contract) holderTransfers: ContractHolderTransfer[];
  @OneToMany(() => ContractAsset, (ca) => ca.contract, { cascade: true }) rentedAssets: ContractAsset[];
  @OneToMany(() => ContractServiceSubscription, (cs) => cs.contract, { cascade: true }) serviceSubscriptions: ContractServiceSubscription[];
  @OneToMany(() => TenantVehicle, (tv) => tv.contract, { cascade: true }) vehicles: TenantVehicle[];
  @OneToMany(() => DepositLedger, (dl) => dl.contract) depositLedgers: DepositLedger[];
  @OneToMany(() => Invoice, (inv) => inv.contract) invoices: Invoice[];
  @OneToOne(() => CheckoutSettlement, (cs) => cs.contract) checkoutSettlement?: CheckoutSettlement | null;
}
```

#### 8\. `ContractOccupant` (`contract_occupants`) — who lives in the room

One row per person per stay. A person who moves out keeps the row (`status = MOVED_OUT`, `moved_out_at`) for residence and audit history; moving back in creates a new row.

* **Exactly one active contract holder** per contract (`idx_occupants_one_active_holder`).
* **A person lives in one room at a time** — one temporary residence (`idx_occupants_tenant_one_active`).
* **Capacity:** active occupants ≤ `rooms.max_occupants` (checked by `assertCanAddOccupant()` under the contract lock).
* **Residence per person:** `PENDING_DECLARATION → SUBMITTED → REGISTERED` on move-in; `DEREGISTRATION_PENDING → DEREGISTERED` on move-out. `residence_channel` is `CT01` for CCCD holders and `FOREIGNER_TEMPORARY_RESIDENCE` for passports. Only `REGISTERED` occupants count towards the EVN quota.
* **Succession:** `succession_order` (1 = first) records who the parties agreed takes over the contract; without it, the earliest `moved_in_at` eligible adult succeeds (`selectNextPrimaryHolder`).

```ts
// src/modules/contracts/entities/contract-occupant.entity.ts
@Entity('contract_occupants')
@Index('idx_occupants_contract_status', ['contractId', 'status'])
@Index('idx_occupants_bld_residency', ['buildingId', 'residencyStatus'])
export class ContractOccupant extends BuildingScopedEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, (c) => c.occupants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contract_id' })
  contract: Contract;

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, (t) => t.occupancies, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ type: 'enum', enum: OccupantRole, default: OccupantRole.CO_OCCUPANT })
  role: OccupantRole; // PRIMARY_HOLDER (người đứng tên) | CO_OCCUPANT

  @Column({ type: 'enum', enum: OccupancyStatus, default: OccupancyStatus.ACTIVE })
  status: OccupancyStatus;

  @Column({ type: 'date' })
  movedInAt: string;

  @Column({ type: 'date', nullable: true })
  movedOutAt?: string | null;

  @Column({ type: 'smallint', nullable: true })
  successionOrder?: number | null;

  // CT01 "Quan hệ với chủ hộ": e.g. "Bạn cùng phòng", "Vợ", "Con"
  @Column({ type: 'varchar', length: 50, nullable: true })
  relationshipToHolder?: string | null;

  @Column({ type: 'enum', enum: ResidenceChannel, default: ResidenceChannel.CT01 })
  residenceChannel: ResidenceChannel;

  @Column({ type: 'enum', enum: ResidencyStatus, default: ResidencyStatus.PENDING_DECLARATION })
  residencyStatus: ResidencyStatus;

  @Column({ type: 'timestamptz', nullable: true }) residenceSubmittedAt?: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) residenceRegisteredAt?: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) residenceDeregisteredAt?: Date | null;

  // Temporary residence term (Residence Law 2020, Art. 27: up to 2 years, renewable)
  @Column({ type: 'date', nullable: true })
  temporaryStayValidUntil?: string | null;

  // Latest CT01 PDF for this person (residence-ct01 category)
  @Column({ type: 'varchar', length: 255, nullable: true })
  ct01DocumentKey?: string | null;
}
```

#### 8b\. `ContractHolderTransfer` (`contract_holder_transfers`) — người đứng tên history

Written whenever the contract holder changes. Changing the lessee transfers the lease obligations, which requires the landlord's consent (Civil Code 2015, Art. 370), so every transfer produces a **contract addendum** (*phụ lục hợp đồng*, `HOLDER_TRANSFER_ADDENDUM` PDF) signed by the landlord, the outgoing and the incoming holder.

```ts
// src/modules/contracts/entities/contract-holder-transfer.entity.ts
export enum HolderTransferReason { HOLDER_MOVED_OUT = 'HOLDER_MOVED_OUT', MUTUAL_AGREEMENT = 'MUTUAL_AGREEMENT' }
export enum HolderSelection { DESIGNATED = 'DESIGNATED', AUTO_SUCCESSION = 'AUTO_SUCCESSION' }

@Entity('contract_holder_transfers')
@Index('idx_holder_transfers_contract_date', ['contractId', 'effectiveDate'])
export class ContractHolderTransfer extends BuildingScopedEntity {
  @Column({ type: 'uuid' }) contractId: string;

  @ManyToOne(() => Contract, (c) => c.holderTransfers, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'contract_id' })
  contract: Contract;

  @Column({ type: 'uuid' }) fromTenantId: string;
  @Column({ type: 'uuid' }) toTenantId: string;
  @Column({ type: 'date' }) effectiveDate: string;

  @Column({ type: 'enum', enum: HolderTransferReason }) reason: HolderTransferReason;
  @Column({ type: 'enum', enum: HolderSelection }) selection: HolderSelection;
  @Column({ type: 'enum', enum: HolderTransferDepositHandling }) depositHandling: HolderTransferDepositHandling;

  // Unpaid invoices at the transfer date and who takes them over (recorded in the addendum)
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 }) outstandingBalance: string;
  @Column({ type: 'varchar', length: 20 }) outstandingBalanceAssumedBy: 'OUTGOING_HOLDER' | 'INCOMING_HOLDER';

  @Column({ type: 'varchar', length: 50 }) addendumNo: string; // e.g. "PL-2026/080-P302-01"
  @Column({ type: 'varchar', length: 255, nullable: true }) addendumPdfKey?: string | null;

  @Column({ type: 'uuid' }) approvedById: string; // landlord / property manager
  @Column({ type: 'text', nullable: true }) notes?: string | null;
}
```

#### 9\. `ContractAsset` (`contract_assets`)

Links a lease contract to the specific furniture and appliances rented by that tenant, snapping the agreed monthly rental fee and initial handover condition.

// src/modules/contracts/entities/contract-asset.entity.ts

import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';

import { EnterpriseBaseEntity } from '../../../core/database/base.entity';

import { Contract } from './contract.entity';

import { RoomAsset, AssetConditionGrade } from '../../assets/entities/room-asset.entity';

@Entity('contract\_assets')

@Index('idx\_contract\_assets\_contract\_room\_asset', \['contractId', 'roomAssetId'\], { unique: true })

export class ContractAsset extends EnterpriseBaseEntity {

  @Column({ type: 'uuid' })

  contractId: string;

  @ManyToOne(() \=\> Contract, (c) \=\> c.rentedAssets, { onDelete: 'CASCADE' })

  @JoinColumn({ name: 'contract\_id' })

  contract: Contract;

  @Column({ type: 'uuid' })

  roomAssetId: string;

  @ManyToOne(() \=\> RoomAsset, { onDelete: 'RESTRICT' })

  @JoinColumn({ name: 'room\_asset\_id' })

  roomAsset: RoomAsset;

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  agreedMonthlyFee: string; // Locked-in monthly appliance rental fee for this contract

  @Column({ type: 'enum', enum: AssetConditionGrade })

  handoverCondition: AssetConditionGrade;

  @Column({ type: 'enum', enum: AssetConditionGrade, nullable: true })

  checkoutCondition?: AssetConditionGrade | null;

}

#### 10\. `ServiceCatalog` (`service_catalogs`) & 11\. `ContractServiceSubscription` (`contract_services`)

Normalizes recurring extra fees (Wi-Fi, Motorbike Parking, Car Parking, Sanitation, Security) so new building services can be added dynamically without altering table columns.

// src/modules/contracts/entities/service-catalog.entity.ts

import { Entity, Column, Index } from 'typeorm';

import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

export enum ServiceChargeUnit {

  PER\_ROOM\_MONTH \= 'PER\_ROOM\_MONTH',       // e.g., High-Speed Wi-Fi: 150,000 VND / room / month

  PER\_PERSON\_MONTH \= 'PER\_PERSON\_MONTH',   // e.g., Trash & Elevator: 50,000 VND / person / month

  PER\_VEHICLE\_MONTH \= 'PER\_VEHICLE\_MONTH', // e.g., Motorbike Parking: 150,000 VND / bike / month

}

@Entity('service\_catalogs')

@Index('idx\_service\_catalogs\_bld\_code\_unique', \['buildingId', 'code'\], { unique: true })

export class ServiceCatalog extends BuildingScopedEntity {

  @Column({ type: 'varchar', length: 50 })

  code: string; // "WIFI", "PARKING\_MOTORBIKE", "PARKING\_EBIKE", "PARKING\_CAR", "SANITATION"

  @Column({ type: 'varchar', length: 100 })

  name: string;

  @Column({ type: 'enum', enum: ServiceChargeUnit })

  chargeUnit: ServiceChargeUnit;

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  defaultUnitPrice: string;

  @Column({ type: 'boolean', default: true })

  isProratableOnCheckout: boolean;

}

// src/modules/contracts/entities/contract-service.entity.ts

import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';

import { EnterpriseBaseEntity } from '../../../core/database/base.entity';

import { Contract } from './contract.entity';

import { ServiceCatalog, ServiceChargeUnit } from './service-catalog.entity';

@Entity('contract\_services')

@Index('idx\_contract\_services\_contract\_id', \['contractId'\])

export class ContractServiceSubscription extends EnterpriseBaseEntity {

  @Column({ type: 'uuid' })

  contractId: string;

  @ManyToOne(() \=\> Contract, (c) \=\> c.serviceSubscriptions, { onDelete: 'CASCADE' })

  @JoinColumn({ name: 'contract\_id' })

  contract: Contract;

  @Column({ type: 'uuid' })

  serviceCatalogId: string;

  @ManyToOne(() \=\> ServiceCatalog, { onDelete: 'RESTRICT' })

  @JoinColumn({ name: 'service\_catalog\_id' })

  serviceCatalog: ServiceCatalog;

  @Column({ type: 'varchar', length: 50 })

  serviceCode: string;

  @Column({ type: 'enum', enum: ServiceChargeUnit })

  chargeUnit: ServiceChargeUnit;

  @Column({ type: 'smallint', default: 1 })

  quantity: number; // e.g., 2 motorbikes

  @Column({ type: 'numeric', precision: 12, scale: 2 })

  agreedUnitPrice: string;

}

#### 12\. `TenantVehicle` (`tenant_vehicles`)

Vehicles, licence plates and parking cards, tied to parking subscriptions. Each vehicle belongs to **one occupant** (`owner_tenant_id`): when that person moves out the vehicle is deactivated and the parking subscription quantity is reduced in the same transaction.

```ts
// src/modules/contracts/entities/tenant-vehicle.entity.ts
export enum VehicleType { MOTORBIKE = 'MOTORBIKE', ELECTRIC_BIKE = 'ELECTRIC_BIKE', BICYCLE = 'BICYCLE', CAR = 'CAR' }

@Entity('tenant_vehicles')
@Index('idx_tenant_vehicles_contract', ['contractId'])
@Index('idx_tenant_vehicles_bld_plate', ['buildingId', 'licensePlate'])
export class TenantVehicle extends BuildingScopedEntity {
  @Column({ type: 'uuid' }) contractId: string;

  @ManyToOne(() => Contract, (c) => c.vehicles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contract_id' })
  contract: Contract;

  @Column({ type: 'uuid' }) ownerTenantId: string; // the occupant who uses the vehicle

  @Column({ type: 'enum', enum: VehicleType }) vehicleType: VehicleType; // e-bikes tracked for PCCC charging safety
  @Column({ type: 'varchar', length: 30 }) licensePlate: string; // e.g. "59-G2 123.45"
  @Column({ type: 'varchar', length: 100 }) brandModel: string;
  @Column({ type: 'varchar', length: 50, nullable: true }) parkingCardCode?: string | null;

  @Column({ type: 'boolean', default: true }) isActive: boolean;
  @Column({ type: 'date', nullable: true }) deactivatedAt?: string | null; // owner moved out
}
```

#### 13\. `DepositLedger` (`deposit_ledgers`)

Immutable ledger of the **1-month security deposit** per contract: collection, deductions, checkout offsets, refunds — and movements caused by a change of contract holder. `counterparty_tenant_id` records **which person** paid or received money, because the deposit can change hands when the holder changes.

```ts
// src/modules/contracts/entities/deposit-ledger.entity.ts
export enum DepositLedgerType {
  INITIAL_COLLECTION = 'INITIAL_COLLECTION',
  TOP_UP = 'TOP_UP',
  CHECKOUT_DEDUCTION = 'CHECKOUT_DEDUCTION',
  SURPLUS_REFUND = 'SURPLUS_REFUND',
  FORFEITURE = 'FORFEITURE',
  // Change of người đứng tên
  HOLDER_TRANSFER_CARRY_OVER = 'HOLDER_TRANSFER_CARRY_OVER', // amount 0: deposit stays, now owed to the incoming holder
  HOLDER_TRANSFER_REFUND = 'HOLDER_TRANSFER_REFUND',         // refunded to the outgoing holder
  HOLDER_TRANSFER_COLLECTION = 'HOLDER_TRANSFER_COLLECTION', // collected from the incoming holder
}

@Entity('deposit_ledgers')
@Index('idx_deposit_ledgers_contract_created', ['contractId', 'createdAt'])
export class DepositLedger extends BuildingScopedEntity {
  @Column({ type: 'uuid' }) contractId: string;

  @ManyToOne(() => Contract, (c) => c.depositLedgers, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'contract_id' })
  contract: Contract;

  @Column({ type: 'enum', enum: DepositLedgerType }) transactionType: DepositLedgerType;
  @Column({ type: 'numeric', precision: 12, scale: 2 }) amount: string; // + collection, - deduction / refund
  @Column({ type: 'numeric', precision: 12, scale: 2 }) balanceAfter: string;

  @Column({ type: 'uuid' }) counterpartyTenantId: string; // person who paid / received
  @Column({ type: 'uuid', nullable: true }) holderTransferId?: string | null;

  @Column({ type: 'uuid' }) recordedById: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) notes?: string | null;
}
```

---

### 3.3 Bounded Context 3: Manual Guard Metering, Invoicing & Prorated Checkout

#### 14\. `MeterReading` (`meter_readings`)

Stores manual electricity and water indices input by the building guard along with S3 private object keys for the inspection photos, supporting physical meter rollover (`isMeterReset`) and mid-month checkout readings (`isFinalCheckoutReading`).

// src/modules/metering/entities/meter-reading.entity.ts  
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';  
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';  
import { Room } from '../../properties/entities/room.entity';  
import { Contract } from '../../contracts/entities/contract.entity';

@Entity('meter\_readings')  
// Enables sub-millisecond Index Backward Scans to fetch previous readings (Zero Sequential Scan)  
@Index('idx\_meter\_room\_date\_desc', \['roomId', 'readingDate', 'createdAt'\])  
@Index('idx\_meter\_bld\_billing\_month', \['buildingId', 'billingPeriodMonth'\])  
@Index('idx\_meter\_contract\_final', \['contractId', 'isFinalCheckoutReading'\])  
export class MeterReading extends BuildingScopedEntity {  
  @Column({ type: 'uuid' })  
  roomId: string;

  @ManyToOne(() \=\> Room, (r) \=\> r.meterReadings, { onDelete: 'RESTRICT' })  
  @JoinColumn({ name: 'room\_id' })  
  room: Room;

  @Column({ type: 'uuid', nullable: true })  
  contractId?: string | null;

  @ManyToOne(() \=\> Contract, { nullable: true, onDelete: 'SET NULL' })  
  @JoinColumn({ name: 'contract\_id' })  
  contract?: Contract | null;

  @Column({ type: 'date' })  
  billingPeriodMonth: string; // Normalized first day of month: e.g., "2026-10-01"

  @Column({ type: 'date' })  
  readingDate: string; // Exact date guard captured the photo

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  prevPowerIndex: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  currPowerIndex: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  powerConsumptionKwh: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  prevWaterIndex: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  currWaterIndex: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  waterConsumptionM3: string;

  // Uploaded directly by Guard Mobile App via StorageModule 15-min Presigned PUT URL  
  @Column({ type: 'varchar', length: 255 })  
  powerPhotoS3Key: string;

  @Column({ type: 'varchar', length: 255 })  
  waterPhotoS3Key: string;

  @Column({ type: 'uuid' })  
  recordedByGuardId: string;

  @Column({ type: 'boolean', default: false })  
  isMeterReset: boolean; // True when physical meter rolls over (99999 \-\> 0\) or is replaced

  @Column({ type: 'boolean', default: false })  
  isFinalCheckoutReading: boolean; // True when captured for tenant clock-out settlement  
}

#### 15\. `Invoice` (`invoices`) & 16\. `InvoiceLineItem` (`invoice_line_items`)

Separates header totals (`invoices`) from normalized fee rows (`invoice_line_items`), explicitly segregating **taxable rental revenue** (Room \+ Appliances \+ Service markups) from **pass-through utilities** (*Thu hộ \- Chi hộ điện nước*) for 2026 Tax Form `01/BĐS` compliance.

// src/modules/billing/entities/invoice.entity.ts  
import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';  
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';  
import { Contract } from '../../contracts/entities/contract.entity';  
import { InvoiceLineItem } from './invoice-line-item.entity';  
import { PaymentTransaction } from './payment-transaction.entity';

export enum InvoiceStatus {  
  DRAFT \= 'DRAFT',  
  PENDING \= 'PENDING',  
  PARTIALLY\_PAID \= 'PARTIALLY\_PAID',  
  PAID \= 'PAID',  
  OVERDUE \= 'OVERDUE',  
  CANCELLED \= 'CANCELLED',  
}

@Entity('invoices')  
@Index('idx\_invoices\_contract\_period\_unique', \['contractId', 'billingPeriodMonth', 'isCheckoutSettlement'\], { unique: true })  
@Index('idx\_invoices\_bld\_status\_due', \['buildingId', 'status', 'dueDate'\])  
@Index('idx\_invoices\_bld\_period', \['buildingId', 'billingPeriodMonth'\])  
export class Invoice extends BuildingScopedEntity {  
  @Index('idx\_invoices\_code\_unique', { unique: true })  
  @Column({ type: 'varchar', length: 50 })  
  invoiceCode: string; // e.g., "INV-202610-P302"

  @Column({ type: 'uuid' })  
  contractId: string;

  @ManyToOne(() \=\> Contract, (c) \=\> c.invoices, { onDelete: 'RESTRICT' })  
  @JoinColumn({ name: 'contract\_id' })  
  contract: Contract;

  // Snapshot of the contract holder when the invoice was issued (e-invoice buyer). Invoices issued
  // before a holder transfer stay addressed to the previous holder; later invoices go to the new one.
  @Column({ type: 'uuid' })
  billedToTenantId: string;

  @Column({ type: 'date' })  
  billingPeriodMonth: string; // e.g., "2026-10-01"

  @Column({ type: 'date' })  
  dueDate: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  roomRentTotal: string; // Full month or prorated room rent

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  assetRentTotal: string; // Sum of rented furniture & appliances

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  fixedServiceTotal: string; // Sum of Wi-Fi, Parking, Sanitation

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  powerFeeTotal: string; // Pass-through EVN electricity fee

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  waterFeeTotal: string; // Pass-through water fee

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  latePenaltyTotal: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  damagePenaltyTotal: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  grossTotal: string;

  // Amount offset by 1-month security deposit during checkout settlement  
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  depositDeductedAmount: string;

  // Cumulative amount paid via VietQR / Bank Transfer / Cash  
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  paidAmount: string;

  // Remaining balance: grossTotal \- depositDeductedAmount \- paidAmount  
  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  netBalanceDue: string;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.PENDING })  
  status: InvoiceStatus;

  @Column({ type: 'boolean', default: false })  
  isCheckoutSettlement: boolean;

  // E-Invoice tracking key (Mandatory when household revenue \> 1B VND/year under Decree 68/2026)  
  @Column({ type: 'varchar', length: 100, nullable: true })  
  eInvoiceFkey?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })  
  invoicePdfS3Key?: string | null;

  @OneToMany(() \=\> InvoiceLineItem, (li) \=\> li.invoice, { cascade: true })  
  lineItems: InvoiceLineItem\[\];

  @OneToMany(() \=\> PaymentTransaction, (pt) \=\> pt.invoice)  
  payments: PaymentTransaction\[\];  
}

// src/modules/billing/entities/invoice-line-item.entity.ts  
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';  
import { EnterpriseBaseEntity } from '../../../core/database/base.entity';  
import { Invoice } from './invoice.entity';

export enum LineItemCategory {  
  ROOM\_RENT \= 'ROOM\_RENT',  
  APPLIANCE\_RENT \= 'APPLIANCE\_RENT',  
  WIFI\_FEE \= 'WIFI\_FEE',  
  PARKING\_FEE \= 'PARKING\_FEE',  
  SANITATION\_FEE \= 'SANITATION\_FEE',  
  ELECTRICITY\_TIERED \= 'ELECTRICITY\_TIERED',  
  WATER\_USAGE \= 'WATER\_USAGE',  
  DAMAGE\_COMPENSATION \= 'DAMAGE\_COMPENSATION',  
  LATE\_PENALTY \= 'LATE\_PENALTY',  
  DEPOSIT\_DEDUCTION \= 'DEPOSIT\_DEDUCTION',  
}

@Entity('invoice\_line\_items')  
@Index('idx\_invoice\_line\_items\_invoice\_id', \['invoiceId'\])  
export class InvoiceLineItem extends EnterpriseBaseEntity {  
  @Column({ type: 'uuid' })  
  invoiceId: string;

  @ManyToOne(() \=\> Invoice, (inv) \=\> inv.lineItems, { onDelete: 'CASCADE' })  
  @JoinColumn({ name: 'invoice\_id' })  
  invoice: Invoice;

  @Column({ type: 'enum', enum: LineItemCategory })  
  category: LineItemCategory;

  @Column({ type: 'varchar', length: 200 })  
  description: string; // e.g., "Tiền điện Bậc 1 (0-50 kWh) \- Định mức 2 người"

  @Column({ type: 'numeric', precision: 10, scale: 2 })  
  quantity: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  unitPrice: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  lineTotal: string;

  @Column({ type: 'boolean', default: true })  
  isTaxableLeasingRevenue: boolean; // True for Room/Assets/Services; False for pass-through EVN/Water  
}

#### 17\. `PaymentTransaction` (`payment_transactions`)

Records incoming bank transfers, VietQR webhook callbacks, and deposit refund disbursements, protected against replay and double-crediting via `IdempotencyModule` and `WebhookModule`.

// src/modules/billing/entities/payment-transaction.entity.ts  
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';  
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';  
import { Invoice } from './invoice.entity';

export enum PaymentMethod {  
  VIETQR\_WEBHOOK \= 'VIETQR\_WEBHOOK',  
  BANK\_TRANSFER\_MANUAL \= 'BANK\_TRANSFER\_MANUAL',  
  CASH \= 'CASH',  
  DEPOSIT\_REFUND\_TRANSFER \= 'DEPOSIT\_REFUND\_TRANSFER',  
}

@Entity('payment\_transactions')  
@Index('idx\_payments\_invoice\_id', \['invoiceId'\])  
@Index('idx\_payments\_bank\_ref\_unique', \['bankReferenceCode'\], { unique: true })  
export class PaymentTransaction extends BuildingScopedEntity {  
  @Column({ type: 'uuid' })  
  invoiceId: string;

  @ManyToOne(() \=\> Invoice, (inv) \=\> inv.payments, { onDelete: 'RESTRICT' })  
  @JoinColumn({ name: 'invoice\_id' })  
  invoice: Invoice;

  @Column({ type: 'enum', enum: PaymentMethod })  
  paymentMethod: PaymentMethod;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  amount: string;

  @Column({ type: 'varchar', length: 100 })  
  bankReferenceCode: string; // Unique FT / Napas transaction ID from bank webhook

  @Column({ type: 'timestamptz' })  
  paidAt: Date;  
}

#### 18\. `CheckoutSettlement` (`checkout_settlements`)

Stores the exact mid-month proration math (\$D / M\$) and **1-month security deposit deduction** when the room is handed back — i.e. when the **last** occupant leaves (a co-occupant or the holder moving out while others stay is not a checkout, see `contract_holder_transfers`).

// src/modules/billing/entities/checkout-settlement.entity.ts  
import { Entity, Column, OneToOne, JoinColumn, Index } from 'typeorm';  
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';  
import { Contract } from '../../contracts/entities/contract.entity';

@Entity('checkout\_settlements')  
@Index('idx\_checkout\_settlements\_contract\_unique', \['contractId'\], { unique: true })  
export class CheckoutSettlement extends BuildingScopedEntity {  
  @Column({ type: 'uuid' })  
  contractId: string;

  @OneToOne(() \=\> Contract, (c) \=\> c.checkoutSettlement, { onDelete: 'RESTRICT' })  
  @JoinColumn({ name: 'contract\_id' })  
  contract: Contract;

  @Column({ type: 'date' })  
  checkoutDate: string; // Exact clock-out date (e.g., "2026-10-18")

  // Settled with the contract holder on the checkout date. Every still-active occupant is moved out
  // (moved_out_at = checkoutDate, residency DEREGISTRATION_PENDING) in the same transaction.
  @Column({ type: 'uuid' })
  settledWithTenantId: string;

  @Column({ type: 'smallint' })  
  daysOccupied: number; // Inclusive days stayed in the checkout billing window

  @Column({ type: 'smallint' })  
  daysInMonth: number; // Calendar days in checkout month (28, 29, 30, or 31\)

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  proratedRoomRent: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  proratedAssetRent: string; // Prorated furniture & appliance rental fees

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  proratedServiceFee: string; // Prorated Wi-Fi, Parking, Sanitation fees

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  finalPowerFee: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  finalWaterFee: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  damagePenaltyFee: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })  
  unpaidPriorBalance: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  grossObligation: string; // Sum of all prorated charges, utilities, damages & arrears

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  depositHeld: string; // 1-month security deposit baseline

  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  depositApplied: string; // Amount deducted from the 1-month deposit

  // \> 0: Tenant must pay extra; \< 0: Landlord refunds surplus deposit to tenant  
  @Column({ type: 'numeric', precision: 12, scale: 2 })  
  netSettlementBalance: string;

  @Column({ type: 'text', nullable: true })  
  damageNotes?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })  
  settlementPdfS3Key?: string | null;  
}

---

### 3.4 Bounded Context 4: Statutory Compliance, WORM Audit & Transactional Outbox

#### 19\. `PcccComplianceLog` (`pccc_compliance_logs`)

Tracks compulsory fire and explosion insurance policies (*Bảo hiểm cháy nổ bắt buộc*), centralized fire alarm inspections (**QCVN 10:2025/BCA**), and fire extinguisher expiration dates required for an 80-room building under the **Fire Safety Law 2024, Decree 105/2025/NĐ-CP, and Decree 69/2026/NĐ-CP**.

// src/modules/compliance-vn/entities/pccc-compliance-log.entity.ts  
import { Entity, Column, Index } from 'typeorm';  
import { BuildingScopedEntity } from '../../../core/multitenancy/tenant-base.entity';

export enum PcccRecordType {  
  COMPULSORY\_FIRE\_INSURANCE \= 'COMPULSORY\_FIRE\_INSURANCE', // Mandatory annual policy  
  ALARM\_SYSTEM\_INSPECTION \= 'ALARM\_SYSTEM\_INSPECTION',     // QCVN 10:2025/BCA check  
  EXTINGUISHER\_MAINTENANCE \= 'EXTINGUISHER\_MAINTENANCE',   // 5-year replacement / refill  
  POLICE\_SAFETY\_AUDIT \= 'POLICE\_SAFETY\_AUDIT',             // Biên bản kiểm tra PCCC  
}

@Entity('pccc\_compliance\_logs')  
@Index('idx\_pccc\_bld\_expiry', \['buildingId', 'validUntilDate'\])  
export class PcccComplianceLog extends BuildingScopedEntity {  
  @Column({ type: 'enum', enum: PcccRecordType })  
  recordType: PcccRecordType;

  @Column({ type: 'varchar', length: 100 })  
  certificateOrPolicyCode: string;

  @Column({ type: 'varchar', length: 150 })  
  issuerOrganization: string;

  @Column({ type: 'date' })  
  issuedDate: string;

  @Column({ type: 'date' })  
  validUntilDate: string;

  @Column({ type: 'varchar', length: 255 })  
  documentScanS3Key: string;  
}

#### 20\. `AuditLog` (`audit_logs`) & 21\. `OutboxEvent` (`outbox_events`)

Owned by the supporting layer (document 01, sections 2.5 and 4.4); created by migrations `1791043417730-CreateInfrastructureTables` and `1792160000000-AlignRentalBuildingScope`. Both use a **nullable** `building_id` (system events) and are not policed by `TenancySubscriber`.

```ts
// src/infrastructure/audit/entities/audit-log.entity.ts — WORM: no updated_at / deleted_at
@Entity('audit_logs')
@Index('idx_audit_bld_created', ['buildingId', 'createdAt'])
@Index('idx_audit_bld_resource', ['buildingId', 'resource', 'resourceId'])
@Index('idx_audit_actor_created_desc', ['actorId', 'createdAt'])
@Index('idx_audit_department_created', ['departmentId', 'createdAt'])
@Index('idx_audit_created_tiering', ['createdAt'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', name: 'building_id', nullable: true }) buildingId?: string | null;
  @Column({ type: 'varchar', length: 100 }) actorId: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) actorLabel?: string | null; // masked phone (090****567)
  @Column({ type: 'varchar', length: 100, nullable: true }) departmentId?: string | null;
  @Column({ type: 'enum', enum: AuditAction }) action: AuditAction; // CREATE | UPDATE | DELETE | RESTORE | EXECUTE
  @Column({ type: 'varchar', length: 255 }) resource: string; // "contracts", "contract_occupants", …
  @Column({ type: 'varchar', length: 255 }) resourceId: string;
  @Column({ type: 'jsonb', nullable: true }) diffSnapshot?: Record<string, { from: unknown; to: unknown }> | null;
  @Column({ type: 'jsonb', nullable: true }) metadata?: Record<string, unknown> | null;
  @Column({ type: 'varchar', length: 128 }) traceId: string;
  @Column({ type: 'varchar', length: 45 }) clientIp: string;
  @Column({ type: 'text', nullable: true }) userAgent?: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

// src/infrastructure/outbox/entities/outbox-event.entity.ts
@Entity('outbox_events')
@Index('idx_outbox_poll_pending', ['status', 'nextRetryAt', 'createdAt'])
@Index('idx_outbox_bld_created', ['buildingId', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', name: 'building_id', nullable: true }) buildingId?: string | null;
  @Column({ type: 'varchar', length: 100 }) aggregateType: string; // CONTRACT, CONTRACT_OCCUPANT, INVOICE, …
  @Column({ type: 'varchar', length: 100 }) aggregateId: string;
  @Column({ type: 'varchar', length: 150 }) eventType: string; // e.g. contract.primary_holder_changed
  @Column({ type: 'jsonb' }) payload: Record<string, any>;
  @Column({ type: 'enum', enum: OutboxEventStatus, default: 'PENDING' }) status: OutboxEventStatus; // PENDING | PROCESSING | PUBLISHED | FAILED | DEAD_LETTER
  @Column({ type: 'int', default: 0 }) retryCount: number;
  @Column({ type: 'int', default: 5 }) maxRetries: number;
  @Column({ type: 'timestamptz', nullable: true }) nextRetryAt?: Date | null; // retry time or lease expiry
  @Column({ type: 'varchar', length: 128 }) traceId: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) traceparent?: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) actorId?: string | null;
  @Column({ type: 'text', nullable: true }) lastError?: string | null;
  @Column({ type: 'timestamptz', nullable: true }) processedAt?: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
```

### 3.5 Reference Data (global, seeded)

Created by `1792250000000-CreateReferenceDataTables`, filled by `npm run db:seed` from code constants (document 01, 4.5). Not building-scoped, no RLS.

| Table | Key columns | Content |
| :-- | :-- | :-- |
| `system_roles` | `code` PK, `name`, `description`, `is_system` | `LANDLORD`, `PROPERTY_MANAGER`, `ACCOUNTANT`, `GUARD`, `TENANT` (referenced by `user_roles.role_code`) |
| `role_permissions` | `role_code` FK, `resource`, `action`, `scope`, `effect` (unique together) | Default matrix, kept in sync with code (stale grants removed) |
| `evn_tariff_tiers` | `effective_from`, `tier` 1–6 (unique together), `width_kwh`, `price_vnd`, `legal_basis` | Residential tiers, one set per effective date |
| `statutory_tax_rules` | `code` PK, `effective_from/to`, `exempt_threshold_vnd`, `vat_rate_percent`, `pit_rate_percent`, `pit_base` (`TOTAL_REVENUE` \| `EXCESS_OVER_THRESHOLD`), `business_license_fee_vnd` | `RENTAL_PRE_2026`, `RENTAL_2026` |
| `statutory_forms` | `code` PK, `name`, `kind` (`TAX` \| `RESIDENCE`), `legal_basis`, `is_legacy` | `01/BĐS`, `01/BK-BĐS`, `01/TTS`, `CT01` |

---

## 4\. PostgreSQL Kernel-Level Guarantees (domain migrations in `src/core/database/migrations/`)

Constraints that hold even if application code is wrong or raw SQL is used:

```sql
-- ============================================================================
-- 1. PARTIAL UNIQUE INDEXES
-- ============================================================================
-- A room never has two ACTIVE contracts, even if two requests bypass the Redis lock
CREATE UNIQUE INDEX idx_unique_active_contract_per_room
  ON contracts (room_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL;

-- Exactly one ACTIVE contract holder (người đứng tên) per contract
CREATE UNIQUE INDEX idx_occupants_one_active_holder
  ON contract_occupants (contract_id)
  WHERE role = 'PRIMARY_HOLDER' AND status = 'ACTIVE' AND deleted_at IS NULL;

-- A person lives in one room at a time (one temporary residence)
CREATE UNIQUE INDEX idx_occupants_tenant_one_active
  ON contract_occupants (tenant_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL;

-- Only one final checkout meter reading per contract
CREATE UNIQUE INDEX idx_unique_final_meter_reading_per_contract
  ON meter_readings (contract_id) WHERE is_final_checkout_reading = TRUE AND deleted_at IS NULL;

-- Covering index for vacancy lookups
CREATE INDEX idx_rooms_available_covering
  ON rooms (building_id, room_type_id, floor) INCLUDE (room_number, price_override)
  WHERE status = 'AVAILABLE' AND deleted_at IS NULL;

-- Residence work queue (CT01 to declare / deregister), used by the daily compliance job
CREATE INDEX idx_occupants_residence_pending
  ON contract_occupants (building_id, residency_status)
  WHERE residency_status IN ('PENDING_DECLARATION', 'DEREGISTRATION_PENDING');

-- ============================================================================
-- 2. CHECK CONSTRAINTS
-- ============================================================================
ALTER TABLE contracts
  ADD CONSTRAINT chk_contracts_valid_dates CHECK (end_date > start_date),
  ADD CONSTRAINT chk_contracts_positive_rent CHECK (monthly_room_rent > 0 AND deposit_amount >= 0),
  ADD CONSTRAINT chk_contracts_quota_headcount CHECK (registered_evn_quota_headcount >= 0);

ALTER TABLE contract_occupants
  ADD CONSTRAINT chk_occupants_move_out_consistent CHECK ((status = 'MOVED_OUT') = (moved_out_at IS NOT NULL)),
  ADD CONSTRAINT chk_occupants_move_dates CHECK (moved_out_at IS NULL OR moved_out_at >= moved_in_at),
  -- Someone who moved out can no longer be the holder
  ADD CONSTRAINT chk_occupants_holder_active CHECK (role <> 'PRIMARY_HOLDER' OR status = 'ACTIVE');

ALTER TABLE contract_holder_transfers
  ADD CONSTRAINT chk_holder_transfer_distinct CHECK (from_tenant_id <> to_tenant_id);

ALTER TABLE meter_readings
  ADD CONSTRAINT chk_meter_positive_consumption CHECK (power_consumption_kwh >= 0 AND water_consumption_m3 >= 0);

-- ============================================================================
-- 3. CONTRACT HOLDER CONSISTENCY (deferred: checked at COMMIT, after both rows changed)
-- ============================================================================
CREATE OR REPLACE FUNCTION check_contract_primary_holder() RETURNS trigger AS $$
DECLARE
  v_contract_id uuid := COALESCE(NEW.contract_id, NEW.id);
  v_status text;
  v_primary uuid;
  v_holder uuid;
BEGIN
  SELECT status, primary_tenant_id INTO v_status, v_primary FROM contracts WHERE id = v_contract_id;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NULL; -- drafts and closed contracts are not checked
  END IF;
  SELECT tenant_id INTO v_holder FROM contract_occupants
   WHERE contract_id = v_contract_id AND role = 'PRIMARY_HOLDER' AND status = 'ACTIVE' AND deleted_at IS NULL;
  IF v_holder IS NULL OR v_holder <> v_primary THEN
    RAISE EXCEPTION 'Contract % must have exactly one active PRIMARY_HOLDER equal to primary_tenant_id', v_contract_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_contract_primary_holder_consistency
  AFTER INSERT OR UPDATE OF primary_tenant_id, status ON contracts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contract_primary_holder();

CREATE CONSTRAINT TRIGGER trg_occupant_primary_holder_consistency
  AFTER INSERT OR UPDATE OF role, status ON contract_occupants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contract_primary_holder();

-- ============================================================================
-- 4. WORM AUDIT LOG — already installed by 1791043417730 / 1792160000000:
--    trg_audit_logs_immutable (UPDATE / DELETE) and trg_audit_logs_immutable_truncate,
--    DELETE allowed only with SET LOCAL app.audit_tiering = 'on' (tiering job).
-- ============================================================================

-- ============================================================================
-- 5. ROW-LEVEL SECURITY — setup_building_rls() is installed by 1792160000000
-- ============================================================================
SELECT setup_building_rls(t) FROM unnest(ARRAY[
  'room_types', 'rooms', 'assets', 'room_assets', 'tenants',
  'contracts', 'contract_occupants', 'contract_holder_transfers', 'tenant_vehicles', 'deposit_ledgers',
  'meter_readings', 'invoices', 'payment_transactions', 'checkout_settlements', 'pccc_compliance_logs'
]) AS t;

-- ============================================================================
-- 6a. PROPERTY & ASSET TOPOLOGY (module 1)
-- ============================================================================
ALTER TABLE room_types ADD CONSTRAINT uq_room_types_bld_id UNIQUE (building_id, id);
ALTER TABLE rooms      ADD CONSTRAINT uq_rooms_bld_id UNIQUE (building_id, id);
ALTER TABLE assets     ADD CONSTRAINT uq_assets_bld_id UNIQUE (building_id, id);
ALTER TABLE rooms
  ADD CONSTRAINT fk_rooms_room_type_same_building FOREIGN KEY (building_id, room_type_id) REFERENCES room_types (building_id, id),
  ADD CONSTRAINT chk_rooms_floor CHECK (floor BETWEEN 1 AND 30),
  ADD CONSTRAINT chk_rooms_area CHECK (area_sqm > 0),
  ADD CONSTRAINT chk_rooms_max_occupants CHECK (max_occupants BETWEEN 1 AND 20),
  ADD CONSTRAINT chk_rooms_price_override CHECK (price_override IS NULL OR price_override > 0);
ALTER TABLE room_assets
  ADD CONSTRAINT fk_room_assets_room_same_building FOREIGN KEY (building_id, room_id) REFERENCES rooms (building_id, id),
  ADD CONSTRAINT fk_room_assets_asset_same_building FOREIGN KEY (building_id, asset_id) REFERENCES assets (building_id, id),
  ADD CONSTRAINT chk_room_assets_fee CHECK (custom_monthly_fee >= 0);
ALTER TABLE room_types ADD CONSTRAINT chk_room_types_values
  CHECK (base_monthly_rent > 0 AND standard_area_sqm > 0 AND default_max_occupants BETWEEN 1 AND 20);
ALTER TABLE assets ADD CONSTRAINT chk_assets_values CHECK (standard_monthly_rental_fee >= 0 AND replacement_value >= 0);
ALTER TABLE buildings ADD CONSTRAINT chk_buildings_values
  CHECK (total_rooms_capacity BETWEEN 1 AND 500 AND default_water_rate_per_m3 >= 0);

-- 6b. PUBLIC LISTING (module 1b): a building can only be listed with a well-formed, unique slug
ALTER TABLE buildings
  ADD COLUMN is_publicly_listed boolean NOT NULL DEFAULT false,
  ADD COLUMN public_slug varchar(80),
  ADD COLUMN public_description text,
  ADD CONSTRAINT chk_buildings_public_slug CHECK (public_slug IS NULL OR public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT chk_buildings_listed_has_slug CHECK (NOT is_publicly_listed OR public_slug IS NOT NULL);
CREATE UNIQUE INDEX idx_buildings_public_slug_unique ON buildings (public_slug) WHERE public_slug IS NOT NULL;
ALTER TABLE rooms ADD COLUMN is_publicly_listed boolean NOT NULL DEFAULT true;

-- ============================================================================
-- 6. IDENTITY (global tables — no RLS, see 3.0)
-- ============================================================================
-- One live account per phone number; a soft-deleted account frees the number
CREATE UNIQUE INDEX idx_users_phone_unique ON users (phone_e164) WHERE deleted_at IS NULL;

-- 6c. TENANTS (module 2)
ALTER TABLE tenants
  ADD CONSTRAINT uq_tenants_bld_id UNIQUE (building_id, id),
  ADD CONSTRAINT fk_tenants_guardian_same_building FOREIGN KEY (building_id, consent_guardian_tenant_id) REFERENCES tenants (building_id, id),
  ADD CONSTRAINT chk_tenants_guardian_not_self CHECK (consent_guardian_tenant_id IS NULL OR consent_guardian_tenant_id <> id),
  ADD CONSTRAINT chk_tenants_gender CHECK (gender IN ('MALE', 'FEMALE')),
  ADD CONSTRAINT chk_tenants_nationality CHECK (nationality ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT chk_tenants_id_hash CHECK (id_card_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_tenants_cccd_vietnamese CHECK (id_document_type <> 'CCCD' OR nationality = 'VN'),
  ADD CONSTRAINT chk_tenants_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
CREATE INDEX idx_tenants_bld_name_search ON tenants (building_id, full_name_search);

-- A person profile links to at most one login, and a login to at most one profile per building
CREATE UNIQUE INDEX idx_tenants_bld_user_unique
  ON tenants (building_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE users
  ADD CONSTRAINT chk_users_phone_e164 CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT chk_users_active_has_password CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL);

ALTER TABLE user_roles
  ADD CONSTRAINT fk_user_roles_role FOREIGN KEY (role_code) REFERENCES system_roles (code);

ALTER TABLE user_building_access
  ADD CONSTRAINT fk_user_building_access_building FOREIGN KEY (building_id) REFERENCES buildings (id);

ALTER TABLE auth_sessions
  ADD CONSTRAINT chk_sessions_expiry CHECK (absolute_expires_at > created_at AND idle_expires_at <= absolute_expires_at),
  ADD CONSTRAINT chk_sessions_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));
```

`23514` from the consistency trigger is translated to `400 DB_CHECK_CONSTRAINT_VIOLATION` by `AllExceptionsFilter`; RLS violations (`42501`) to `403`.

The identity tables are created by the Identity migration (module 0) — before `buildings` exists, so `fk_user_building_access_building` is added by the Properties migration (module 1). Vietnamese mobile prefixes are validated in the application (`PhoneNumber.normalize()`); the database only enforces the general E.164 shape so foreign tenants' numbers are accepted.

---

## 5\. Verification Against the 4 Enterprise Optimization Mandates

### Mandate 1: Index Optimization (Eliminating Sequential Scans & Disk I/O)

Every high-frequency query is backed by a tailored B-Tree composite or partial covering index so PostgreSQL executes **Index Scans**, **Index-Only Scans**, or **Index Backward Scans**:

| Business Query / Access Pattern | Supporting Index | PostgreSQL Execution Plan |
| :---- | :---- | :---- |
| Filter & paginate rooms by status and room type (`GET /properties/rooms?status=AVAILABLE&roomTypeId=...`) | `idx_rooms_available_covering` & `idx_rooms_bld_status_type` | **Index-Only Scan** (fetches `room_number` and `price_override` directly from index leaf pages with zero heap table fetches). |

| | Sort & filter rooms by floor (`GET /properties/rooms?floor=3&sortBy=roomNumber`) | `idx_rooms_bld_floor_status (building_id, floor, status)` | **Index Scan** scoped to the target building and floor.

| | Fetch previous month's meter reading for delta validation (`POST /metering/records`) | `idx_meter_room_date_desc (room_id, reading_date DESC, created_at DESC)` | **Index Backward Scan** (`LIMIT 1`), resolving the prior index in `< 0.2ms` regardless of how many years of history accumulate.

| | List current occupants of a contract / pending residence work (`GET /contracts/{id}/occupants`, daily compliance job) | `idx_occupants_contract_status`, `idx_occupants_residence_pending` (partial) | **Index Scan** on active rows only.

| | Lookup tenant by Citizen ID (CCCD) without decrypting rows | `idx_tenants_bld_id_hash_unique (building_id, id_card_hash)` | **Unique Index Scan** on deterministic `HMAC-SHA256` blind index. | | Poll pending domain events across 10 K8s pods (`OutboxPollerService`) | `idx_outbox_poll_pending (status, next_retry_at, created_at)` | **Index Scan** with `FOR UPDATE SKIP LOCKED`, skipping locked rows without table scans.

|

### Mandate 2: Query Optimization (Eliminating N+1 Queries via Joins & Batching)

* **Room Directory (`listRooms`):** Uses a single `INNER JOIN` between `rooms` and `room_types`, computing `COALESCE(r.price_override, rt.base_monthly_rent)` inside SQL rather than firing 20 separate queries for each room's tier rate.  
    
* **Room Profile (`getRoomDetail`):** Uses a single `SelectQueryBuilder` query joining `rooms` \$\\rightarrow\$ `room_types` \$\\rightarrow\$ `contracts` (`current_contract_id`) \$\\rightarrow\$ `tenants` \$\\rightarrow\$ `room_assets` \$\\rightarrow\$ `assets`.  
    
* **Monthly Billing Worker (`BillingCronService`):** Loads all active contracts, subscribed services (`contract_services`), rented appliances (`contract_assets`), and current-month `meter_readings` in **batched `WHERE contract_id IN (...)` queries**, completely eliminating per-room loop queries across the 80 rooms.

### Mandate 3: RESTful Payload Optimization (Explicit Column Projection)

* All TypeORM queries use explicit `.select([...])` projections rather than `find()` wildcard hydration.  
    
* List endpoints never load `id_card_encrypted`, `refund_bank_account_encrypted`, `diff_snapshot` JSONB blobs, or S3 key strings unless specifically requested on a detail or export route, minimizing network serialization and V8 memory overhead.

### Mandate 4: Multi-Tier Caching Strategy (`CacheModule` \+ XFetch)

Low-churn datasets are cached in Redis with **Probabilistic Early Expiration (XFetch)** and invalidated atomically via non-blocking Redis `UNLINK` tags:

| Cached Dataset | Redis Key Pattern | TTL & XFetch Policy | Invalidation Trigger (`CacheTagManager`) |
| :---- | :---- | :---- | :---- |
| **Vacancy Summary by Room Type** | `cache:{buildingId}:rooms:vacancies:summary` | `3600s` (XFetch \$\\beta \= 1.0\$) | Invalidated via `tag:{buildingId}:rooms` on Contract Activation, Room Status Update, or Checkout Settlement. |

**Room Types & Service Catalogs** | `cache:{buildingId}:catalogs:pricing` | `86400s` (24 hours) | Invalidated via `tag:{buildingId}:catalogs` when Landlord updates base prices or extra service rates. | | **User Flattened CASL Permissions** | `permissions:user:{userId}` | `1800s` (30 minutes) | Invalidated via `PermissionCacheService` whenever a user's RBAC role assignment changes.
