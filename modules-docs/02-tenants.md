# Module 2 — Tenants: completion report

Module 2 (Tenants) is built and tested, and its migration is applied to the local database. All tests and the live Postman run pass, lint and build are clean.

## Scope

Doc 04 had only `POST /tenants` and `GET /tenants/lookup`. As agreed (decision D7 in doc 06), profile management was added to docs 02–06 first, then built:

| Endpoint | Who | What |
|---|---|---|
| `POST /tenants` | Landlord, manager | Register one person (holder, roommate or child); idempotent |
| `GET /tenants?q=&minor=` | Landlord, manager, accountant | Search by name without diacritics ("nguyen" finds "Nguyễn") or by phone in any format; children / adults filter; paged |
| `GET /tenants/lookup?idCardNumber=` | Landlord, manager, accountant | Exact match by CCCD / personal ID / passport through the blind index; every lookup audited |
| `GET /tenants/{id}` | Landlord, manager, accountant | Profile detail, ID and bank account masked |
| `PATCH /tenants/{id}` | Landlord, manager | Corrections, re-validated as a whole; optimistic version |
| `GET /tenants/me` | Tenant | Their own profile (linked to their login at move-in, module 3) |

ID-scan upload, revealing a full number, and consent withdrawal / data-subject requests stay out of scope, as chosen.

## Rules

- **One profile per person per building**, including children (12-digit personal identification number) and foreigners (passport). A duplicate number, however it's typed, returns `409` with the existing profile's id, to reuse when the person changes rooms. The same person in another building is a separate profile.
- **CCCD checked against the person:** 12 digits, Vietnamese nationality only. Digit 4 encodes gender and century of birth and digits 5–6 the birth year; both must match the profile, which catches typos and swapped people. Passports: 6–12 letters or digits with at least one digit, so international formats work.
- **Dates:** birth not in the future and at most 120 years ago; ID issue date not in the future and not before birth.
- **Consent and children:** consent is mandatory for everyone. A child (under 18 today, Vietnam time; 29 February birthdays count on 1 March) needs a guardian: an adult, consented profile of the same building, never the child itself or another child. Adults need a phone number and have no guardian. A guardian can't be turned into a minor while they guard someone.
- **Contact:** phone normalised to E.164 exactly like the login phone, so module 3 can find the person's account at move-in; e-mail lower-cased; a refund bank account needs a bank name.
- **Privacy:** ID numbers and refund bank accounts are encrypted (AES-256-GCM) and never loaded for reads. Responses and lookups use the last four digits (`********1234`). A correction loads the stored number in memory only to re-check it, and never returns it. Audit diffs and lookup records never contain the number or its hash.

Supporting modules used: per-building RLS transactions, field encryption and blind index, audit log (diffs plus explicit lookup records), idempotency on create, permissions (`tenants:*`, `tenants:read:own`), search throttling, i18n for the new `BIZ_TENANT_GUARDIAN_INVALID` code, and the identity module's phone normaliser.

## Database

- Migration `src/core/database/migrations/1792610000000-CreateTenantsTable.ts`, applied, reverted and re-applied locally; zero drift.
- **Guaranteed by PostgreSQL itself:** unique blind index per building; the guardian must be in the same building (composite FK) and can't be oneself; CCCD only for nationality `VN`; E.164 phone; valid hash format; `user_id → users` (cleared if the account is deleted); RLS on the table.
- **Dev seed:** the dev tenant (CCCD `079099001234`, linked to the `0901000005` login), their 11-year-old daughter (guardian = the dev tenant), and a Korean resident with a passport.

## Testing

| Check | Result |
|---|---|
| Unit tests | 594 pass (36 new) |
| End-to-end, real PostgreSQL and Redis | 163 pass (16 new tenant tests as `app_user` with RLS enforced, plus a tenant-isolation test in the superuser suite) |
| Deliberately broken rules | 16 of 16 caught (one only after adding the superuser test, below) |
| Postman, all four folders, run twice after reseeding | 131 requests, 158 assertions, 0 failures |

The e2e tests read the raw rows to prove the number is encrypted at rest, scan responses and audit rows for the number, race two identical registrations (exactly one wins), and insert raw SQL to prove every database constraint.

## Problems the testing caught (fixed)

- **Every phone number would have been rejected:** my migration generator escaped the `\+` in the phone CHECK twice. TypeORM's drift check doesn't compare CHECK expressions, so only the seed (inserting a real row) caught it. Fixed; doc 06's checklist now requires a valid-row insert test for every CHECK with a regex.
- **`?minor=false` returned children:** with implicit type conversion on, the string `"false"` became boolean `true` before the DTO transform ran. The transform now reads the raw query value; a regression test pins it.
- **A misleading error:** turning a guardian into a minor reported "this minor needs a guardian" instead of the real cause. The specific check now runs first.
- **A guardian from another building** was blocked only by RLS in the main suite. The superuser suite now proves the app's own same-building check, and the mutation is caught.

## Choices to review

- Adults must have a phone number (contact and account matching at move-in); children don't.
- The CCCD checks cover gender, century and birth year, but the province code is only range-checked (001–096), so the 2025 provincial merger can't cause false rejections.
- The dev seed links the dev tenant's profile to its login directly; in real use this happens at move-in (module 3).
