# Module 1 — Properties & Assets: completion report

Module 1 (Properties & Assets) is built and tested, and the migration is applied to the local database. All tests and the live Postman run pass, lint and build are clean.

## Scope

Doc 04 had only five endpoints for this module, while docs 03/05 also described managing buildings, prices, statuses and the appliance catalogue. As agreed, I added the management endpoints to docs 04/05/06 first (decision D5 in doc 06), then built all 18 operations:

| Area | Endpoints |
|---|---|
| Buildings (landlord) | list own, register, update |
| Room types | list (cached), create, update |
| Rooms | directory, vacancy summary, my room, detail, create, update |
| Appliance catalogue | list, add, update |
| Installed units | install, re-grade / re-price / move, remove |

## What it does

- **Buildings:** a landlord registers a building and gets access to it in the same transaction. They see and edit only buildings they have access to. Capacity (default 80) can't drop below the rooms already created.
- **Rooms:** the directory returns 6 fields, paginated, with filters (status, type, floor) and sorting by price, floor or number. Room numbers are normalised, so `p.302` and `P.302` are the same room. A building never gets more rooms than its capacity, even when two requests race for the last slot.
- **Status and price:** `AVAILABLE`, `RESERVED` and `MAINTENANCE` can be set by hand. `OCCUPIED` is reserved to contracts, and an occupied room's status can't be changed by hand. Changes run under the same lock contract activation will use, with version checks. A status change publishes `room.status_changed` through the outbox to the building's realtime dashboard.
- **Prices:** a room type's new base rent applies to rooms without an override. Active contracts will keep their agreed rent.
- **Vacancy summary:** one grouped query, cached per building (XFetch), refreshed the moment a room or room type changes.
- **Appliances:** catalogue per building. Installing a unit defaults its fee to the catalogue fee and its date to today (Vietnam time), and refuses future dates. Serial numbers are unique among installed units; a removed unit is soft-deleted, so its serial can be installed again and its history is kept. Units can be moved to another room.
- **Tenants:** see only the room they live in, through `/rooms/mine` or the room's id. Until module 3 provides occupancy, every tenant is refused (fail-closed).
- `/auth/me` now shows real building names.

Supporting modules used: per-building RLS transactions, cache with tags (vacancy, room-type pricing), distributed lock, outbox and domain events, realtime WebSocket, idempotency on every create, audit log with diffs on every table, permissions, throttling on the directory, i18n for the two new error codes.

## Database

- Migration `src/core/database/migrations/1792430000000-CreatePropertyAndAssetTables.ts` creates the five tables. It was applied, reverted and re-applied locally; TypeORM reports zero drift.
- **Guarantees in PostgreSQL itself:** composite foreign keys mean a room can't use another building's room type and an appliance can't sit in another building's room, even with raw SQL. CHECKs cover floor 1–30, area, capacity, prices and fees. RLS is enabled on the four building-scoped tables, and a covering index serves the free-room lookups.
- **Access foreign key:** module 0 granted building access before a buildings table existed. The new `user_building_access → buildings` foreign key was added without deleting those rows, and validated once they all point to real buildings. It is validated locally now.
- **Dev seed:** building A has 80 rooms (P.101–P.810, 3 room types, 10 air conditioners installed); building B, another landlord's, has 5 rooms.

## Testing

| Check | Result |
|---|---|
| Unit tests | 538 pass (30 new) |
| End-to-end, real PostgreSQL and Redis | 135 pass (33 new) |
| Deliberately broken rules | all caught |
| Postman (both folders, run twice after reseeding) | 87 requests, 100 assertions, 0 failures |

- **Isolation proven twice:** the main e2e suite runs the app as the non-superuser `app_user`, so PostgreSQL RLS is really enforced. A second suite runs it as superuser (RLS bypassed, as in local dev) to prove the application's own building filter separately.
- **Mutation check:** of 20 deliberate mutations, 17 were caught at first. Two survived only because RLS hid the bug; the superuser suite now catches them, plus two more filter mutations. One was dead code (removed, see below).

## Problems the testing caught (fixed)

- **Lock error code:** a busy lock returned the generic `RES_CONFLICT`, and its message exposed the internal lock key. It now returns `RES_LOCKED` (safe to retry) and the key is only logged. This affects every caller of the lock module.
- **Useless cache evictions** on appliance changes: nothing cached contains appliances. Removed, and the doc 04 text corrected.
- **Flaky test fixtures:** random 7-digit phone numbers collided because the test database keeps data between runs. Fixtures now use unique numbers.
- **Unstable ordering:** rooms with equal prices were ordered by UUID; ties are now broken by room number.

## Choices to review

- Rooms, room types, buildings and catalogue items are never deleted (financial and residence history); a room is taken out of service with `MAINTENANCE`.
- `currentContractId` exists on rooms now; its foreign key to contracts comes with module 3.
- Room detail returns no contract and no occupant counts until module 3, as agreed.
- Money is whole VND; areas allow 2 decimals.

## Follow-up: public listing for the portfolio website (module 1b — built, see `01b-public-listing.md`)

A public portfolio website will let prospective tenants and students browse rooms without signing in; its management area keeps using the authenticated endpoints of this module. Specified in docs 01–06 (decision D6) and built as module 1b.

| Endpoint (no sign-in) | Shows |
|---|---|
| `GET /public/buildings` | Published buildings: name, district, free rooms, rent range |
| `GET /public/buildings/{slug}` | Address, description, floors, room types, utility terms, 1-month deposit |
| `GET /public/buildings/{slug}/room-types` | Base rent, area, capacity, total and free rooms per type |
| `GET /public/buildings/{slug}/floors` | Each floor (level) with its room numbers and free rooms |
| `GET /public/buildings/{slug}/rooms` | Search by type, floor, price range, area, capacity, availability; sort by rent, floor, number, area |
| `GET /public/buildings/{slug}/rooms/{roomNumber}` | Room by number: type, floor, area, capacity, rent, availability, equipment with monthly fees |
| `GET /public/buildings/{slug}/vacancies` | Free rooms per room type |
| `GET /public/buildings/{slug}/assets` | Equipment & furniture offered, standard monthly fees |

- **Publishing:** the landlord sets `isPubliclyListed`, `publicSlug` and `publicDescription` on the building; a manager can hide one room (`isPubliclyListed: false`). Unknown and unpublished buildings both answer `404`.
- **Privacy:** availability is only `AVAILABLE` / `UNAVAILABLE` (never why); no occupants, contracts, serial numbers, replacement values, landlord, tax or bank data; no internal ids (slug, room number and type code instead).
- **Safety and cost:** each request runs in the building's own RLS context with explicit building filters; responses are cached per building and refreshed by the same staff changes as the dashboards; browsers and CDNs get `Cache-Control` + `ETag`; per-IP throttling; feature flag `public_listing` switches the whole public site off.
- **Database:** `buildings` gains `is_publicly_listed`, `public_slug` (unique, lower-case-with-dashes, required to list) and `public_description`; `rooms` gains `is_publicly_listed` (default `true`).

## Re-running the Postman check

`npm run db:seed`, wait 60 seconds (landlord OTP cooldown), then `npx newman run postman/room-management.postman_collection.json -e postman/local.postman_environment.json`. Folder 01 registers a fresh building each run.
