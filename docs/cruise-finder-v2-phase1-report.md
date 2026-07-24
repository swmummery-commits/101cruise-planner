# Sprint 14A — Cruise Finder Engine V2 Phase 1 Report

**Status:** HOLD DEPLOY  
**Date:** 2026-07-24  
**Scope:** Audit + contracts + provider architecture + Vacationstogo feasibility + offline POC

---

## 1. Current Finder V1 dependency map

```
Questionnaire (public-tools/cruise-finder/finder.js)
  → prefs + Explore Destination navigation
Destination page (destination.js)
  → [Find Current Cruises] runSearch()
  → POST /.netlify/functions/search-current-cruises
  → normaliseRequest + cache + rate limit
  → runDiscoveryCatalogue()   ★ CUSTOMER LOOKUP ENGINE V1
  → discovered_cruises (Supabase)
  → result JSON { results[] }
  → destination.js renderResults / resultCardHtml
```

**Background ingestion (not on customer click):**

```
Admin / cron
  → cruise-discovery*.js + lib/cruise-discovery*.js
  → Brave Search + official-page scrape
  → upsert discovered_cruises
```

Customer “Find Current Cruises” does **not** call Brave live today. Stale Brave helpers remain in `search-current-cruises.js` but are unused by `handler`.

---

## 2. Exact replacement boundary

**Replace later (Engine V2 target):** the body of `runDiscoveryCatalogue` inside  
`netlify/functions/search-current-cruises.js` — after request normalisation / cache / rate-limit, before the response payload is returned.

**Do not touch:**

- Questionnaire UI (`finder.js` / `finder.html` / `finder.css`)
- Destination presentation (`destination.js` renderers, CSS, copy)
- Living Destinations pages / `formatPublicSailing` consumers (unless separately planned)
- Route-map renderer, deck-plan module

**Stable presentation contract to preserve:** request fields from `destination.js` `runSearch` payload; response `results[]` with `cruiseLine`, `ship`, `itineraryTitle`, `departureDate`, `durationNights` / `durationLabel`, `departurePort`, `sourceUrl`, `confidence`, etc.

---

## 3. Vacationstogo feasibility outcome

**Recommendation: DO NOT PROCEED WITH THIS PROVIDER.**

Probe method: minimal GETs only (robots, home, custom.cfm, guessed region URLs, cruise_lines, ticker, fastdeal, terms, one line page). No auth bypass, no CAPTCHA bypass, no aggressive crawl.

| Check | Result |
|-------|--------|
| Accessible without auth | Public HTML pages return HTTP 200 |
| Session cookies | Yes (`Set-Cookie` observed) |
| Server-side fetch from Netlify | Technically possible for allowed pages |
| Stable cruise URLs / ids | **Not found** on allowed pages |
| Itinerary in HTML / JSON-LD / API | **No JSON-LD**; no structured itinerary endpoint observed |
| robots.txt | Disallows `/ticker.cfm`, `/fastdeal.cfm`, `/pinfo.cfm`, `/pinfo/`, `/cfc/`, `/secure/`, `/deck_plans/` |
| Custom Search | Form posts toward **ticker.cfm** (robots-disallowed) |
| CAPTCHA / Cloudflare challenge | Not observed on probe GETs |
| Anti-bot / rate risk | Session + deal endpoints suggest operational fragility |

---

## 4. Data fields reliably available (VTG)

None for automated structured discovery under the constraints above.

## 5. Data fields unavailable or inconsistent (VTG)

cruise line, ship, departure date, nights, departure/arrival ports, ordered itinerary, stable source URL / cruise id.

---

## 6. Access / legal / maintenance risks

- robots.txt blocks primary deal/product paths used by search.
- Form/session dependency → brittle Netlify Function scraping.
- Terms likely prohibit automated harvesting of listings (not a paid API).
- Ongoing maintenance would be high (markup changes, anti-bot, no SLA).
- Risk of IP blocks if scaled.

---

## 7. Proof-of-concept results

Because VTG is unsuitable, Phase 1E used a **development-only `fixture` provider** (max 10 Mediterranean sailings, no network, no prices, no DB writes).

```bash
npm run poc:cruise-finder-v2
# or
node scripts/run-cruise-finder-v2-poc.mjs --provider=fixture
node scripts/run-cruise-finder-v2-poc.mjs --provider=vacationstogo
```

Fixture POC (2026-07-24):

- Candidates returned: **9** (10 fixtures − 1 duplicate collapsed)
- Duplicates collapsed: **1**
- Output: `tmp/cruise-finder-v2-poc/poc-fixture.json`

Vacationstogo POC:

- `ok: false`, `provider_unsuitable`
- Output: `tmp/cruise-finder-v2-poc/poc-vacationstogo.json`

---

## 8. Ship and port matching rates (fixture POC vs local snapshots)

Catalogues used (no production writes):

- Ports: `data/ports/ports-catalogue.csv` (220 ports)
- Lines/ships: `data/cruise-finder-v2/ci-*-snapshot.csv` (dev snapshots, not live Supabase)

| Entity | MATCHED | AMBIGUOUS | NOT_FOUND | Rate |
|--------|---------|-----------|-----------|------|
| Cruise line | 8 | 0 | 1 | **88.9%** (8/9) |
| Ship | 8 | 0 | 1 | **88.9%** (8/9) |
| Ports (unique names across itineraries) | 43 | 0 | 14 | **75.4%** (43/57) |

The intentional unmatched sailing (`Imaginary Seas Line` / `Phantom Voyager` / `Atlantis Bay`) accounts for the line/ship miss. Unmatched ports are mostly Greek islands / Adriatic / niche ports absent from the current catalogue (e.g. Dubrovnik, Mykonos, Santorini, Kusadasi, Portofino, Vigo).

---

## 9. Recommended next provider to test

1. **Official cruise-line structured sources** (already partially used by Discovery adapters) — prefer licensed/official search pages with stable sailing URLs.  
2. **Paid cruise content APIs** (report cost before adopting) — e.g. industry itinerary feeds.  
3. Do **not** invest further in Vacationstogo automation.

---

## 10. Overall recommendation

**PROCEED WITH LIMITATIONS** for Engine V2 architecture and next-provider work.  
**DO NOT PROCEED WITH VACATIONSTOGO** as a provider.

---

## 11. Files that would later be removed from Finder V1 (customer lookup)

Only after V2 is proven and presentation contract adapted:

- Dead Brave helpers inside `search-current-cruises.js` (`braveSearch`, `structureResult`, `runSearch`, …)
- Possibly `runDiscoveryCatalogue` once V2 supplies the same response shape

**Not automatic removals:** background Discovery engine packages — still feed Living Destinations / Admin.

## 12. Shared files that must remain

- `netlify/functions/lib/brave-search.js`, `source-fetch.js`
- `ci_cruise_lines` / `ci_cruise_ships` / `ports`
- `discovered_cruises` while Living Destinations / Admin depend on it
- Entire questionnaire + destination presentation tree
- Route-map + deck-plan modules

---

## 13. Estimated ongoing maintenance burden

| Path | Burden |
|------|--------|
| Vacationstogo scraping | High / not recommended |
| Fixture-only V2 | Low (dev only) |
| Official-line adapters / licensed API | Medium (per-line HTML drift or API versioning) |
| Matching enrichment vs ports/ships | Medium (catalogue growth + aliases) |

---

## 14. Costs

| Item | Cost |
|------|------|
| Vacationstogo | No public API; scraping not viable → **n/a** |
| Brave Search | Existing key used by Discovery ingestion (not required for customer V1 lookup) |
| Engine V2 Phase 1 | **$0** (offline fixture POC) |
| Future paid itinerary API | **Unknown — report before purchase** |

---

## Environment variables

| Variable | Default | Phase 1 behaviour |
|----------|---------|-------------------|
| `CRUISE_FINDER_ENGINE` | `v1` | `v2` logs intent but **does not activate** V2 |

Documented in `.env.example`.

---

## Tests

```bash
npm run test:cruise-finder-v2
```

Covers: search-request normalisation, candidate validation, itinerary normalisation, ship/port alias matching, candidate keys, dedupe, provider failure, empty results, malformed data, timeout/unknown provider, access blocked, feature flag.
