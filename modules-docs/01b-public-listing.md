# Module 1b — Public listing (portfolio website): completion report

Module 1b is built and tested, and its migration is applied to the local database. Prospective tenants and students can browse published buildings on the portfolio website without signing in; the site's management area keeps using the authenticated endpoints of modules 0 and 1.

## Endpoints (no sign-in, no `X-Building-ID`)

| Endpoint | Shows |
|---|---|
| `GET /public/buildings` | Published buildings: name, district, total and free rooms, rent range |
| `GET /public/buildings/{slug}` | Address, description, floors, room types, utility terms, 1-month deposit |
| `GET /public/buildings/{slug}/room-types` | Base rent, area, capacity, total and free rooms per type |
| `GET /public/buildings/{slug}/floors` | Each floor with its room numbers and free rooms |
| `GET /public/buildings/{slug}/rooms` | Search by type, floor, availability, price range, area, number of people; sort by rent, floor, number or area; pages of up to 50 |
| `GET /public/buildings/{slug}/rooms/{roomNumber}` | One room (number is case-insensitive) with its equipment and monthly fees |
| `GET /public/buildings/{slug}/vacancies` | Free rooms per room type |
| `GET /public/buildings/{slug}/assets` | Equipment & furniture offered, standard monthly fees, rooms equipped |

Publishing (management side): the landlord sets `isPubliclyListed`, `publicSlug` and `publicDescription` with `PATCH /properties/buildings/{id}`; a manager hides or shows one room with `PATCH /properties/rooms/{id}` (`isPubliclyListed`).

## Rules

- **Opt-in:** only listed buildings with a slug, and only their listed rooms (rooms are listed by default). An unknown slug and an unpublished building give the same `404`, so unpublished buildings can't be discovered.
- **Nothing private:** availability is only `AVAILABLE` / `UNAVAILABLE` (reserved, occupied and maintenance all look the same); no occupants, contracts, serial numbers, replacement values, landlord name, tax code, bank details or internal ids — buildings by slug, rooms by number, types by code.
- **Isolation:** the slug is resolved on the global `buildings` table, then every query runs in that building's own RLS transaction with explicit `building_id` filters.
- **Fresh and cheap:** responses are cached per building for up to 5 minutes and refreshed the moment staff change the building, a room, a room type, the catalogue or an installed unit. Browsers and CDNs get `Cache-Control: public, max-age=60, stale-while-revalidate=300` and an ETag; an unchanged page answers `304` with no body. Errors are never marked cacheable.
- **Abuse protection:** per-IP rate limits (60 / min, 100 / min for search), page size at most 50, malformed slugs and room numbers treated as not found.
- **Kill switch:** feature flag `public_listing`, on by default; switching it off (env `FEATURE_FLAGS` or Redis, no deploy) answers `404 RES_FEATURE_DISABLED` on every public route while the management API keeps working.

## Database

- Migration `src/core/database/migrations/1792520000000-AddPublicListing.ts`: `buildings.is_publicly_listed`, `public_slug` (unique, lower-case words with dashes), `public_description`; `rooms.is_publicly_listed` (default `true`). PostgreSQL itself refuses a malformed slug and listing a building without a slug.
- Applied, reverted and re-applied locally; zero schema drift.
- Dev seed: building A is published as `sunrise-quan-7`; building B stays unpublished.

## Testing

| Check | Result |
|---|---|
| Unit tests | 558 pass (20 new) |
| End-to-end, real PostgreSQL and Redis | 146 pass (11 new public-site tests, run as `app_user` with RLS enforced, plus a public-site isolation check in the superuser suite) |
| Deliberately broken rules | 13 of 13 caught (after strengthening one test, below) |
| Postman, all three folders, run twice after reseeding | 109 requests, 129 assertions, 0 failures |

The e2e tests also scan every public response for private data (building and room ids, serial numbers, tax code, landlord name, the words `MAINTENANCE` / `RESERVED`, the hidden room) and check that a direct database edit stays invisible (served from cache) while every staff change through the API shows up immediately.

**Caught by the mutation check:** the first run let three broken evictions survive, because the test read each public page for the first time only after the staff change. The test now loads the page into the cache before each change and also removes an installed unit; all three are caught.

## Supporting-layer additions

- `PublicCacheControlInterceptor` + `@PublicCacheControl()` (cache module): ETag over the handler data, so the per-request envelope (trace id, timestamp) doesn't defeat it.
- Feature flags can now have code defaults (`FEATURE_FLAG_CODE_DEFAULTS`) for kill switches; every other flag still stays off until configured.
- Swagger: a fourth portal, `/api/docs/public`.
- `runInBuildingScope()`: runs anonymous public reads, and the landlord's eviction of another building's public cache, in the right building's namespace without marking the request as a background job.
- Assets: catalogue and installed-unit changes now evict the `assets` cache tag, because the public site caches equipment.

## Choices to review

- The kill switch answers `404` (what the existing flag guard does), not the `503` first written in the docs; docs corrected.
- The public room detail shows each appliance's condition grade and monthly fee.
- The deposit is shown as "1 month" rather than an amount.
- Remember to add the portfolio website's origin to `ALLOWED_ORIGINS`.
