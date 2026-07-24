# Track.cruises Canonical Inventory Importer POC — Sprint 15B

**Status:** LOCAL POC ONLY · HOLD DEPLOY · DO NOT COMMIT · DO NOT PUSH  
**Date:** 2026-07-24  
**Scope:** Controlled importer from validated Track.cruises sailings → provider-independent 101cruise canonical inventory. Engine V2 not activated. Finder UI untouched. No Supabase writes. No provider prices retained.

---

## 1. Canonical inventory contract

Defined in `netlify/functions/lib/cruise-finder-v2/inventory/canonical-inventory.js` as **CanonicalSailing** (separate from Engine V2 `CandidateCruise`, which remains the discovery-search shape).

Core shape:

- Identity: `provider`, `providerCruiseId`, `providerItineraryId`, `sourceUrl`, `sailingKey`
- Entities: `cruiseLine` / `ship` with `{ id, canonicalName, providerName, matchStatus }`
- Schedule: `title`, `departureDate`, `returnDate`, `nights`, `destinations`
- Ports: `departurePort` / `arrivalPort` `{ portId, canonicalName }`
- `itinerary[]` with types `embarkation | port | scenic_cruising | sea | disembarkation`
- `matchSummary`, `routeObjectEligible`, `dateConsistency`, timestamps

**Forbidden in contract:** all provider price / fare fields (`price`, `price_euro`, `currency`, `cabin_prices_per_person`, history, drops).

---

## 2. Files created and modified

### Created

| Path | Role |
|------|------|
| `netlify/functions/lib/cruise-finder-v2/inventory/canonical-inventory.js` | Contract + forbidden price list |
| `netlify/functions/lib/cruise-finder-v2/inventory/strip-prices.js` | Price scrub + assert |
| `netlify/functions/lib/cruise-finder-v2/inventory/classify-itinerary.js` | Sea / scenic / embark / disembark |
| `netlify/functions/lib/cruise-finder-v2/inventory/itinerary-dates.js` | Day→date + duration consistency |
| `netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js` | Read-only Base44 exports + ports CSV |
| `netlify/functions/lib/cruise-finder-v2/inventory/match-entities-app.js` | Line/ship match vs real catalogues |
| `netlify/functions/lib/cruise-finder-v2/inventory/match-provider-port.js` | Enhanced port normalisation |
| `netlify/functions/lib/cruise-finder-v2/inventory/build-canonical-sailing.js` | Full pipeline |
| `netlify/functions/lib/cruise-finder-v2/inventory/dedupe-canonical.js` | Locale/currency-safe sailing key |
| `netlify/functions/lib/cruise-finder-v2/inventory/route-eligibility.js` | Eligibility + in-memory preview |
| `netlify/functions/lib/cruise-finder-v2/providers/track-cruises-provider.js` | Provider adapter (POC) |
| `scripts/run-track-cruises-importer-poc.mjs` | Controlled live/fixture importer |
| `scripts/test-track-cruises-importer.mjs` | Offline tests |
| `docs/track-cruises-importer-poc.md` | This report |
| `tmp/track-cruises-importer/*` | Local outputs (gitignored) |

### Modified

| Path | Change |
|------|--------|
| `netlify/functions/lib/cruise-finder-v2/providers/provider-registry.js` | Register Track.cruises for POC (not customer-activated) |
| `package.json` | `poc:track-cruises-importer`, `test:track-cruises-importer` |

**Not modified:** Cruise Finder questionnaire, result UI, Finder V1, Engine activation flag, route renderer, deck-plan discovery, Supabase schemas.

---

## 3. Live API requests consumed (this importer sprint)

| Call | Purpose | Result |
|------|---------|--------|
| 1 | `GET /cruises?company=princess&locale=en_US&limit=10` | **200**, 10 Princess rows |

**Total importer live calls: 1** (≤10 budget).  
Subsequent stats regenerated from saved `tmp/track-cruises-importer/live-princess-list-redacted.json` with **0** additional live calls.

---

## 4. Sample size

- **10** unique Princess sailings (after import)
- Ships: Royal, Grand, Sun, Crown, Star, Caribbean (×2), Emerald, Coral (×2)
- Catalogues used (read-only): **42** lines, **461** ships, **220** ports

---

## 5–11. Match / classification rates (Princess live sample)

| Metric | Result |
|--------|--------|
| Cruise-line match rate | **100%** (10/10) |
| Ship match rate | **100%** (10/10) — using real `import-data` ships, not tiny POC snapshot |
| Ordinary port match rate | **76.7%** |
| Alias match count (sample) | low (city/state normalisation often lands as MATCHED) |
| Scenic-cruising stops | **11** classified (Glacier Bay, Panama Canal transit, etc.) |
| Sea days | **47** classified (`At Sea`, `Fun Day At Sea`, date line, etc.) |
| Route Object eligibility rate | **50%** (5/10) |
| Duplicates collapsed (Princess-only re-import) | **0** (single locale); locale/currency dedupe proven in tests |

Validated Alaska example (`1632` Royal Princess): **6/6** ordinary ports matched, scenic + sea classified, **routeObjectEligible: true**.

---

## 12. Duplicate-collapse results

- Tests: same `cruise_id` across `ja_JP` / `en_US` / differing prices → **one** sailing key
- Title change alone does not fork key
- Live Princess list (`en_US` only): 10 distinct `cruise_id`s → 10 sailings

---

## 13. Fields discarded

Always stripped before canonicalisation:

`price`, `price_euro`, `currency`, `cabin_prices_per_person`, and any `price*` / `*fare*` / nested fare keys.

Tests assert canonical JSON contains none of these.

---

## 14. Proposed port aliases (review only — not written to production)

See `tmp/track-cruises-importer/proposed-port-aliases.json`:

| Provider example | Proposed target | Notes |
|------------------|-----------------|-------|
| Victoria, Canada | Victoria BC | Unambiguous |
| Seattle / Juneau / Skagway / Ketchikan + state | Matching city rows | Document provider form |
| Ft. Lauderdale, Florida | Fort Lauderdale | Abbreviation |
| Athens (Piraeus), Greece | Piraeus? | Needs catalogue confirmation |
| Glacier Bay scenic… | — | Keep `scenic_cruising`; do not force pier alias |

---

## 15. Unmatched ships

Princess sample: **none**.  
(Earlier polluted multi-line merge briefly showed Carnival Dream missing from fleet export — excluded from final Princess-only sample.)

---

## 16. Unmatched ordinary ports (sample)

Catalogue gaps (not matcher bugs):

- Roatan, Belize City, Cozumel, Princess Cays, Grand Turk  
- Crete, Kusadasi (Ephesus), Mykonos, Athens (Piraeus)  
- Manta, Lima (Callao), Pisco, Easter Island  

Private islands / trademark names need curated aliases or new port rows.

---

## 17. Data-quality risks

1. Free-tier staleness (7–30 days) for evaluation data  
2. `ports_list` lacks times/coords — dates derived; geodata from our catalogue only  
3. Scenic vs port heuristics may mis-label edge cases  
4. Duration vs final day mismatches reported, not auto-fixed  
5. Provider `cruise_id` stability across locales is good; itinerary_id useful but secondary  

---

## 18. Provider coverage limitation

Track.cruises currently covers **nine** lines only.  
**Not suitable as the sole permanent global inventory provider** without broader coverage or a second commercial feed (Traveltek / Odysseus / GDS).

---

## 19. Tier constraints / costs

| Tier | Monthly | Notes |
|------|---------|-------|
| BASIC | $0 | 100 req/mo, 10 rows — POC only |
| PRO | $49 | 10k req/mo — minimum serious sync |
| ULTRA | $299 | 100k req/mo |

Importer must keep hard request guards; never paginate blindly.

---

## 20. Recommendation — next phase

1. Grow ports catalogue for Caribbean / Med / private islands (review proposed aliases).  
2. Design persistent **canonical inventory** storage (still no customer activation).  
3. Keep Track.cruises as a **bounded POC feed** (Princess/majors) while RFQ’ing Traveltek/Odysseus for global coverage.  
4. Optional: paid RapidAPI tier only after inventory schema + sync job design.  
5. Do **not** turn on Engine V2 for customers yet.

---

## Commands run

```bash
node scripts/test-track-cruises-importer.mjs
node scripts/run-track-cruises-importer-poc.mjs --live      # 1 API call
node scripts/run-track-cruises-importer-poc.mjs --fixtures # 0 API calls
```

## Test results

**23/23 passed** (offline; zero live requests in the test suite).

## Git summary

Local uncommitted POC files only. `.env` and `tmp/` remain gitignored.  
**HOLD DEPLOY. DO NOT COMMIT. DO NOT PUSH.**

---

## Final recommendation line

**TRACK.CRUISES IMPORTER POC PARTIALLY SUCCESSFUL — REVIEW MATCHING GAPS.**
