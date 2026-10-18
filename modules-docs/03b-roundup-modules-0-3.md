# Round-up of modules 0–3 before metering

Modules 0 (Identity), 1 (Properties & Assets), 1b (Public listing), 2 (Tenants) and 3 (Contracts) were cross-checked end to end: how they call each other, whether they use the supporting modules of doc 01, and which endpoints a frontend still lacked. The findings were fixed, tested and documented (decision D9 in doc 06).

## Cross-module problems found and fixed

| # | Problem | Fix |
|---|---|---|
| 1 | **Audit rows that name no record.** `repository.update()` gives the audit subscriber neither the old row nor the primary key, so it wrote rows with `resource_id = 'unknown'` and no diff — 240 locally, in an append-only table. The `exclude` option (`users.lastLoginAt`) was also ignored on that path | The subscriber never writes an unattributable row and skips updates of technical / excluded columns only. Business changes are saved as entities, so every row names its record with a diff: vehicle deactivation, profile ↔ login link, EVN quota recompute, service quantities, handover condition |
| 2 | **New tenant accounts were never announced.** Accounts are created at move-in (`PENDING_ACTIVATION`) but no message told the tenant to activate | `occupant.moved_in` (after commit) → `ACCOUNT_INVITATION` SMS to newly created accounts only |
| 3 | **Holder changes were silent.** The `PRIMARY_HOLDER_CHANGED` template existed but nothing sent it | `contract.primary_holder_changed` → SMS to the new holder, the remaining occupants and the outgoing holder |
| 4 | **Profile corrections bypassed the contract.** A date-of-birth correction could make the active contract holder a minor; changing nationality left the stay on the wrong residence channel | `PATCH /tenants/{id}` refuses an underage active holder (`422 BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE`, before the guardian rule) and moves the current stay to the matching channel |
| 5 | **Vietnamese citizens identified by passport were routed to the foreigner declaration.** The channel followed the document type | The residence channel follows the **nationality** (Residence Law 2020 vs Law 47/2014/QH13) |
| 6 | **Permission cache race.** The cache was evicted before the move-in transaction committed; a staff member who also rents could keep stale permissions for the cache TTL | Evicted again after commit, together with the room scope |

## Endpoints added for the frontend

| Endpoint | Why |
|---|---|
| `GET /users/{id}` | Account detail screen (staff and tenant accounts of the landlord's buildings; others → `404`) |
| `GET /assets/room-assignments` | Equipment inventory: filter by room, item, serial (QR / label scan) and condition, paged; `rentedUnderContractId` tells the UI which units cannot be moved or removed |
| `PATCH /contracts/{id}/vehicles/{vehicleId}` | Correct a plate, model or parking card without deactivating and re-registering |
| `GET /contracts?q=` | Search box: part of the contract code or the room number |
| `currentOccupancy` on `GET /tenants/{id}` and `/tenants/me` | A profile shows where the person lives now (room, contract, role, residence) |

## Supporting modules in use

| Supporting module (doc 01) | 0 Identity | 1 / 1b Properties, Assets, Public | 2 Tenants | 3 Contracts |
|---|---|---|---|---|
| Building isolation (RLS, building filter) | global tables by design | ✅ (+ `runInBuildingScope` for the public site) | ✅ | ✅ 9 tables, composite same-building FKs |
| Field encryption, blind index | — | — | ✅ ID, bank account | masked IDs only |
| Permissions, `OCCUPANCY_SELF_SCOPE` | ✅ DB roles | ✅ `RoomAccessGuard` | ✅ `tenants:read:own` | ✅ provides the real resolver |
| Cache (XFetch, tags) | permissions | ✅ vacancy, public, ETag | — | ✅ `rooms` tag, scope + permission eviction |
| Distributed locks | — | ✅ room | — | ✅ room, contract occupancy |
| Outbox → events | security events | ✅ `room.status_changed` → WebSocket | — | ✅ contract / occupant / residence / deposit events → notifications |
| Idempotency | ✅ | ✅ | ✅ | ✅ every money / occupancy POST |
| Audit (CDC + explicit) | ✅ explicit security events | ✅ | ✅ + audited lookups | ✅ all entities, ledger immutable |
| Notifications | ✅ OTP, invitation, security alerts | — | — | ✅ invitation, holder change |
| Throttling, feature flags, i18n | ✅ | ✅ public tier, `public_listing` flag | ✅ search tier | ✅ codes in vi / en / ja / ko |

Not used yet, on purpose: object storage and presigned URLs (module 4 meter photos), queues and resilience (module 5 billing, VietQR, e-invoice), PDF generation (module 6). `CONTRACT_ACTIVATED` is waiting for the lease PDF link (module 6).

## Testing

| Check | Result |
|---|---|
| Unit tests | 628 pass |
| End-to-end, real PostgreSQL and Redis | 214 pass, including the new `test/cross-module.e2e-spec.ts` (12 tests, run twice) |
| Deliberately broken fixes | 15 of 16 caught; the 16th (vehicle plate pre-check) is covered by the unique index with the same `409` |
| Postman, all five folders, run twice after reseeding | 175 requests, 207 assertions, 0 failures |

## Documentation

- **Doc 04:** the new paths, the `q` parameter, `currentOccupancy`, `rentedUnderContractId`, `UpdateVehicleDto`, nationality-based channel, invitation SMS (73 paths, 92 operations, no missing references).
- **Doc 05:**
  - New **§6 Frontend map:** client conventions (headers, envelopes, sign-in and refresh, optimistic locking, rate limits, value formats); every screen of the admin web, guard app, tenant app and public site with its endpoints and build status; the values to render; the error codes to handle.
  - Feature rows updated.
- **Doc 01:** audit rule. **Doc 02:** §5.5.6, how the modules work together. **Doc 03:** residence channel. **Doc 06:** decision D9.
