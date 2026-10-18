# Module 0 — Identity: completion report

Module 0 (Identity) is built and tested, and the migration is applied to the local database. All tests and the live Postman run pass, lint and build are clean.

## What it does

- **Sign-in by phone number:** every way of typing a number maps to the same account. Wrong password, unknown number and not-yet-activated account get the identical 401, and unknown numbers cost the same time to check, so nobody can probe which numbers are registered.
- **Login lock:** 5 wrong passwords on a number lock it for 15 minutes, doubling up to 24 hours. Unknown numbers lock the same way.
- **OTP second step** on every login for landlord and accountant, bound to the device and IP that passed the password step. OTPs are also used for account activation and password reset.
- **Sessions:** 15-minute access tokens and refresh tokens that change on every use. Replaying an old refresh token logs that device out and alerts the owner. Logout, logout-all, password reset and account disable all kill access tokens immediately.
- **Staff accounts:** the landlord can grant access only to their own buildings, can't lock themselves out, and can't leave a building without a landlord. Role changes apply without re-login, and removing access ends the person's sessions.
- **Ready for later modules:** automatic tenant accounts at move-in (Contracts will call it), and the "my room" check, which denies tenants every room until module 3 adds the real lookup.

Supporting modules used, as doc 06 requires: encryption (phone keys in Redis), the JWT service, permissions and their cache, Redis, notifications (OTP and security-alert SMS), the audit log (masked phones only), throttling, idempotency on account creation, and i18n for the new error messages.

## Database

- Migration `src/core/database/migrations/1792340000000-CreateIdentityTables.ts` creates the four identity tables.
- Applied, reverted and re-applied locally; TypeORM reports zero drift.
- The seed creates one dev account per role, password `RentalDev@2026` (phone numbers are in doc 06).

## Testing

| Check | Result |
|---|---|
| Unit tests | 508 pass (141 new) |
| End-to-end, real PostgreSQL and Redis | 102 pass (49 new for Identity) |
| Deliberately broken rules | 21 of 21 caught |
| Postman collection against the live server | 47 requests, 58 assertions, 0 failures |

## Problems the testing caught (fixed)

- **Lock decay bug:** the escalation timer started when a lock began, so a 24-hour lock erased its own history and the attacker dropped back to 15 minutes. It now resets 24 hours after the lock ends.
- **Missing test:** removing the timing protection for unknown numbers went unnoticed; a test now catches it.
- **Old phone check:** it accepted `05|1234567`; fixed.
- **Test settings leaked** from one end-to-end file into the next; each file now starts from the same baseline.
- **Permission tests:** five older end-to-end tests relied on the role claim inside the token. Roles now come from the database, so they were rewritten, including a check that a forged role claim is refused.

## Choices to review

- **Zalo or SMS:** the existing Zalo channel can only message a linked Zalo user, not a phone number. So OTPs go by SMS, with Zalo tried first only when an account is linked; docs updated to say so.
- **Audit column renamed:** `audit_logs.actor_email` is now `actor_label` and holds the masked phone, since there is no email any more.
- **Refresh tokens** are stored as an HMAC keyed with `JWT_REFRESH_SECRET`, not a plain SHA-256, so the table alone can't be used to forge tokens.
- **Local `.env.local`:** `AUTH_OTP_DEBUG_ECHO=true` (returns the OTP in the response for Postman; the app refuses to start with it in production) and `THROTTLE_SENSITIVE_LIMIT=100` (the collection signs in about 15 times a minute from one IP).
- **Docs:** docs 01–06 updated to match these details; doc 06 has a section on running module 0 locally.

## Re-running the Postman check

Import the two files in `postman/`, or run `npx newman run postman/room-management.postman_collection.json -e postman/local.postman_environment.json`. Run `npm run db:seed` and wait 60 seconds between runs, because of the landlord's OTP cooldown.
