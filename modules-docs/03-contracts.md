# Module 3 — Contracts: completion report

Module 3 (Contracts) is built and tested, and its migration is applied to the local database. All tests and the live Postman run pass, lint and build are clean.

## Scope

Doc 04 had `POST /contracts` (create and activate in one step), the deposit ledger, occupants and holder transfer. As agreed (decision D8 in doc 06), the lease lifecycle and full management of the extras were added to docs 02–06 first, then built:

| Area | Endpoints |
|---|---|
| Lifecycle | `POST /contracts` (draft), `GET /contracts`, `GET /contracts/{id}`, `PATCH /contracts/{id}` (draft only), `POST …/activate`, `POST …/cancel`, `POST …/renew`, `GET …/renewals` |
| Tenant | `GET /contracts/mine`; `GET /properties/rooms/mine`, `GET /tenants/me` and `residence` in `GET /auth/me` now work for real |
| Deposit | `GET …/deposit-ledger` |
| Occupants & residence | `GET`/`POST …/occupants`, `POST …/occupants/{id}/move-out`, `PATCH …/occupants/{id}/residency` |
| Holder | `POST …/primary-holder/transfer`, `GET …/primary-holder/history` |
| Vehicles | `GET`/`POST …/vehicles`, `POST …/vehicles/{id}/deactivate` |
| Services | `GET`/`POST …/services`, `PATCH`/`DELETE …/services/{id}`; `GET`/`POST /service-catalog`, `PATCH`/`DELETE /service-catalog/{id}` |

26 operations in total. Checkout settlement (module 5) and the PDFs (lease, addendum, CT01 — module 6) are out of scope.

## Rules

- **Draft:** the room must be `AVAILABLE` or manually `RESERVED`, with no active or draft contract; it becomes `RESERVED`, and its status can't be changed by hand while the draft exists. The holder must be an adult on the start date with an ID document and consent. Holder plus planned roommates must fit `maxOccupants` (exactly full is allowed). Planned people must belong to the same building, appear once and move in within the term. Rented appliances must be installed in that room and not `BROKEN`; their fee is snapshotted. Defaults: rent = the room's effective rent, deposit = one month, due day 5 (1–28). Codes run `HD-{YYYY}/{NNN}-{room}` per building and year, taken under a row lock so simultaneous drafts get distinct numbers.
- **Activation:** requires the signed fire-safety (PCCC) commitment and a term that hasn't ended. Nobody may still live in another room (`409` naming the person). Everybody moves in with residence `PENDING_DECLARATION` (foreigners on the foreigner channel). The deposit becomes `HELD` with an `INITIAL_COLLECTION` row naming the holder (no row for a zero deposit). The appliance handover condition is recorded at that moment. The room becomes `OCCUPIED`. Adults with a phone get a tenant account (pending OTP activation) linked to their profile; children don't.
- **Renewal:** active contracts only; a new rent applies from the day after the old end date. The optional top-up brings the deposit to one month of the new rent. Renewals and holder transfers share one addendum counter (`PL-…-01`, `-02` …).
- **Occupants:** move-in dates fall between the start date and today, and capacity is checked under the contract lock. The holder can't simply move out (`BIZ_PRIMARY_HOLDER_USE_TRANSFER`). Moving out deactivates that person's vehicles and recomputes per-person services, parking and the EVN quota. Someone never declared goes straight to `DEREGISTERED`; anyone else needs deregistration.
- **Residence:** only `PENDING_DECLARATION → SUBMITTED → REGISTERED` while living there, and `DEREGISTRATION_PENDING → DEREGISTERED` after moving out. `REGISTERED` needs a stay end date after today and at most 2 years away. Only `REGISTERED` people count toward the EVN quota.
- **Holder transfer:** follows the doc 02 policy (designated, then agreed order, then earliest move-in; children skipped; last occupant → checkout). The outgoing holder steps down before the successor steps up. The deposit is either carried over (a 0 VND row for the successor) or refunded and collected again, each ledger row naming the person.
- **Vehicles & services:** plates are normalised; plates and parking cards are unique among the building's active vehicles; bicycles need no plate. Per-person quantity = occupants; per-vehicle quantity = active vehicles of that type (created and removed automatically); only per-room quantities are typed. A catalogue item used by an open contract can't change its charging unit or be deleted. Changing the catalogue price leaves agreed prices alone.
- **Access:** the real `OCCUPANCY_SELF_SCOPE` resolver links profile → active occupancy → active contract → room. The cached scope is evicted after commit on every move-in, move-out and transfer, so access starts and ends at once.
- **Room detail (D3)** now carries the active contract, holder name and phone, occupant count and deposit held, from the same single query.

## Database

- Migration `src/core/database/migrations/1792700000000-CreateContractsTables.ts`: nine tables, all with RLS. It was applied, reverted and re-applied locally with zero drift.
- **Guaranteed by PostgreSQL itself:**
  - one active and one draft contract per room; one active holder per contract; one room per person;
  - the holder pointer always matches the active holder row (deferred trigger, checked at commit);
  - every child row references its parent in the same building (composite FKs), including `rooms.current_contract_id`;
  - the deposit ledger is append-only (UPDATE / DELETE / TRUNCATE rejected), with signed amounts per type, a non-negative balance and a unique entry number;
  - CHECKs on dates, due day, draft-only fields, cancelled / activated consistency, vehicle plate and active flag, catalogue code format and vehicle type, quantities, and renewal values.
- **Dev seed:** service catalogue for buildings A and B; active contract `HD-2026/001-P101` for the dev tenant and their daughter, with an air conditioner, Wi-Fi, sanitation, a motorbike and the deposit.

## Testing

| Check | Result |
|---|---|
| Unit tests | 625 pass (31 new) |
| End-to-end, real PostgreSQL and Redis | 202 pass (38 new as `app_user` with RLS enforced, plus a contracts block in the superuser suite) |
| Deliberately broken rules | 32 of 32 caught (29 under RLS, 3 in the superuser suite for the app's own building filters) |
| Postman, all five folders, run twice after reseeding | 169 requests, 201 assertions, 0 failures |

The e2e tests:
- race two drafts on one room, three drafts across rooms, and one person moving into two rooms;
- read the outbox and the ledger;
- check access appearing and disappearing for real tenant tokens (including over a cached "no room");
- insert raw SQL to prove every constraint, with valid rows passing.

## Problems found and fixed

- **Doc 03's holder-consistency trigger would have failed on every contract change:** `COALESCE(NEW.contract_id, NEW.id)` reads a column the `contracts` table doesn't have. The migration picks the key by table instead, and doc 03 is corrected.
- **Three rules had no test that would catch breaking them** (found while planning the mutations): access granted immediately at move-in after a cached "no room", moving a rented unit to another room, and distinct contract codes for simultaneous drafts. Tests were added before running the mutations.
- **Reverting the migration left rooms marked OCCUPIED with no contract**, so the dev seed skipped P.101 on the next run. `down()` now frees the rooms of active and draft contracts first.
- **The properties e2e's fake room resolver would have raced the new real one;** it now uses `overrideProvider`.
- **Postman:** folders 00 and 01 expected the dev tenant to have no room; they now expect P.101. Two module 0 checks used a fixed unknown phone number, which hits the daily OTP limit and the lockout after a few runs; they now use a random one each run.

## Choices to review

- The deposit defaults to one month but can be set lower (including 0) on the draft.
- Renewal keeps one contract (same id) and records each term in `contract_renewals`; billing (module 5) must price each period with the rent of its term.
- The outstanding balance in a holder transfer is 0 until invoices exist (module 5).
- Tenants see their current contract (`/contracts/mine`) but not the transfer history; doc 05 is updated to say so.
- Each Postman run leases one free 1BR Deluxe (contracts only end at checkout), so the local database needs re-creating after about 20 runs.
