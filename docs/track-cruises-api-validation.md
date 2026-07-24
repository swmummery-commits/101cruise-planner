# Track.cruises API Validation — Sprint 15A

**Status:** LOCAL POC ONLY · HOLD DEPLOY · DO NOT COMMIT · DO NOT PUSH  
**Date:** 2026-07-24  
**Scope:** Live RapidAPI free-tier validation against Engine V2 contracts (read-only). No Finder UI changes. No Engine V2 activation. No Supabase writes.

---

## STEP 1 — Credentials

```
TRACK_CRUISES_RAPIDAPI_KEY: configured
✓ RapidAPI key detected
```

- Host: `cruise-pricing-api1.p.rapidapi.com` (from `TRACK_CRUISES_RAPIDAPI_HOST`)
- Key is loaded from local `.env` only (gitignored)
- Key is not present in source, fixtures, logs, or this report

---

## API requests used

| # | Call | Result |
|---|------|--------|
| 1 | `GET /coverage` (auth, via `--live`) | **403** — You are not subscribed to this API. |
| 2 | `GET /coverage` (no auth probe) | **401** — Invalid API key (RapidAPI requires a key even for this path) |
| 3 | `GET /coverage` (auth probe) | **403** — not subscribed |
| 4 | `GET /cruises?limit=1` | **429** — Too many requests (free burst) |
| 5 | `GET /v1/coverage` | **429** — Too many requests |
| 6 | `GET /cruises?limit=1` (after cooldown) | **403** — not subscribed |

**Total RapidAPI requests consumed this session: 6** (under the ≤20 cap).  
**Successful inventory payloads captured: 0.**

Interpretation: the key is **accepted as a RapidAPI key** (not “invalid key”), but the app is **not subscribed** to Cruise Pricing API (`cruise-pricing-api1`). Until Basic ($0) is subscribed on RapidAPI, live field inspection cannot proceed.

---

## Endpoints tested

- `GET /coverage` — blocked (403)
- `GET /cruises` — blocked (403 / 429)
- `GET /cruises/{id}` — **not reached** (no list row to select)
- Price-history / price-drop endpoints — **not called** (by design)

---

## Coverage returned

**Not available.** Live `/coverage` never returned 200.

Vendor marketing (prior research, not live): 9 lines — Princess, NCL, Royal Caribbean, Celebrity, Costa, Carnival, Holland America, MSC, Disney.

---

## Real field-population findings

| Field | List | Detail |
|-------|------|--------|
| cruise_id | **Cannot determine** (no 200 body) | **Cannot determine** |
| itinerary_id | Cannot determine | Cannot determine |
| title | Cannot determine | Cannot determine |
| company | Cannot determine | Cannot determine |
| ship_name | Cannot determine | Cannot determine |
| departure_date | Cannot determine | Cannot determine |
| duration | Cannot determine | Cannot determine |
| locale | Cannot determine | Cannot determine |
| ports_list | Cannot determine | Cannot determine |
| destinations | Cannot determine | Cannot determine |
| currency | Cannot determine | Cannot determine |
| price | Cannot determine | Cannot determine |
| cabin_prices_per_person | Cannot determine | Cannot determine |

OpenAPI documents a `ports_list[]` of `{ port, day, arrival, departure }` — **this was not verified live**. Offline tests use a clearly marked **SYNTHETIC** fixture only for mapper/guard unit tests.

---

## Exact `ports_list` structure (live)

**Unknown — no live cruise payload.**

What we can say from the blocked validation:

- Schema docs claim: ordered array of objects with `port`, `day`, `arrival`, `departure`
- Live confirmation of embark/disembark, sea days, lat/lon, port IDs: **not obtained**

---

## Engine V2 compatibility (based on mapper design + synthetic offline test)

| Category | Fields |
|----------|--------|
| Available immediately (when payload exists) | `cruise_id` → providerCruiseId; `ship_name`; optional `title`; optional `itinerary_url` |
| Needs transformation | `company` enum → display name; `departure_date` → YYYY-MM-DD; `duration` → nights; `ports_list` → itinerary / dep / arr ports; `returnDate` derived |
| Unavailable from provider alone | lat/lon; port IDs; explicit sea-day rows; deck plans |
| Intentionally discarded | `price`, `cabin_prices_per_person`, `currency` (Engine V2 forbids prices) |
| Returned null (synthetic sample) | `itinerary_id`, `title` often null in schema examples |

**Itinerary reconstruction:** Possible **if** live `ports_list` matches docs (ordered ports + day numbers). **Not proven live.**  
**Route Object:** **No** from Track.cruises alone — needs catalogue-resolved coordinates. Provider does not supply lat/lon/port IDs in the documented schema.

---

## Catalogue matching (synthetic offline sample only)

Using local snapshots (`ci-cruise-lines-snapshot.csv`, `ci-cruise-ships-snapshot.csv`, `ports-catalogue.csv`) against a synthetic Princess / Barcelona itinerary:

| Entity | Result |
|--------|--------|
| Cruise line (`princess` → Princess Cruises) | MATCHED (exact/soft) |
| Ship (`Sun Princess`) | Depends on snapshot — tiny ship CSV; often NOT_FOUND |
| Ports | Barcelona likely MATCHED; other Med ports depend on catalogue seed |

**Live match %: N/A** (no live cruise).

---

## Product suitability (YES / NO) — provisional

| Product surface | Supportable with Track.cruises alone? | Notes |
|-----------------|----------------------------------------|-------|
| Cruise Finder | **NO** (today) | Live access blocked; even when open, only 9 lines |
| Destination pages | **NO** | Not a destination CMS; thin destination strings only |
| Ship pages | **NO** | Ship name only; no fleet/enrichment content |
| Route Maps | **NO** | No coordinates / port IDs in feed |
| Deck Plans | **NO** | Out of scope for this API |
| Packing Planner | **NO** | Needs climate/region enrichment beyond sailing list |
| Budget module | **YES*** | *API is price-centric — but Finder V2 must not store/display fares |

---

## Free-plan limitations

- **100 requests / month**, hard limit
- **10 rows / response**
- Evaluation data may be **7–30 days stale**
- **No price-history**
- **10 req/min** burst (we hit 429 during probes)
- Must be **subscribed** on RapidAPI even for Basic $0

## Expected production tier / cost

| Tier | Monthly | Notes |
|------|---------|-------|
| BASIC | **$0** | Eval only — insufficient for production Finder |
| PRO | **$49** | 10k req/mo, 100 rows — minimum serious POC |
| ULTRA | **$299** | 100k req/mo |
| MEGA | **$1,499** | High volume |

Likely operating cost if this were chosen later: **$49–$299/mo**, plus engineering to strip prices and enrich ports — still limited to **9 cruise lines**.

---

## Technical risks

1. **Subscription gate** — key present ≠ API access (this sprint’s blocker)
2. **Coverage ceiling** — 9 lines vs 101cruise’s broader catalogue ambitions
3. **Stale free-tier data** — dangerous for “current cruises”
4. **Price-first product** — licence/usage oriented to pricing; schedule-only use needs care
5. **No geodata** — Route Maps require separate port resolution
6. **Quota burn** — easy to exhaust 100/mo during development without a hard guard (guard now exists in validation script)

## Licensing / usage concerns

- Aggregates publicly available pricing (vendor FAQ); not a cruise-line licensed inventory feed
- RapidAPI ToS + Track.cruises plan terms apply
- Engine V2 must discard fares even when returned

---

## Professional opinion (data quality only)

Live data quality **could not be assessed**.

Ignoring price and quotas: even the documented schema is a **thin sailing index** (ids, company, ship, dates, duration, port name list). It is **not** a robust itinerary/geodata foundation for Route Maps or a multi-line Finder comparable to Traveltek/Odysseus.

**Would I build Engine V2 on Track.cruises alone?**

**NO**

Why: incomplete live proof this session; structural coverage capped at 9 lines; no coordinates for Route Objects; price-tracker DNA rather than licensed inventory. Acceptable only as a **temporary sandbox** after RapidAPI subscription is fixed — not as the production Engine V2 backbone.

---

## Files created

- `scripts/lib/track-cruises/env.js`
- `scripts/lib/track-cruises/request-guard.js`
- `scripts/lib/track-cruises/client.js`
- `scripts/lib/track-cruises/map-to-candidate.js`
- `scripts/validate-track-cruises-api.mjs`
- `scripts/test-track-cruises-validation.mjs`
- `docs/track-cruises-api-validation.md` (this file)
- `tmp/track-cruises-validation/*` (gitignored) — includes `live-access-error.json` and **synthetic** redacted fixtures marked `_fixture_note`

## Files modified

- `package.json` — added `validate:track-cruises` and `test:track-cruises` scripts

## Engine V2 / Finder

**Unchanged** (per sprint rules).

---

## Recommendation

1. On RapidAPI, **Subscribe** the same app key to [Cruise Pricing API](https://rapidapi.com/trackcruises/api/cruise-pricing-api1) Basic ($0).
2. Re-run: `node scripts/validate-track-cruises-api.mjs --live` (max 5 calls).
3. Replace synthetic fixtures with true redacted live captures.
4. Do **not** wire Track.cruises into production Engine V2; keep RFQ path to Traveltek / Odysseus for real inventory.

---

## Final recommendation line

**TRACK.CRUISES IS NOT SUITABLE FOR ENGINE V2**
