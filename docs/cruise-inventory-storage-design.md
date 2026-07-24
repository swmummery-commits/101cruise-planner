# Canonical Cruise Inventory Storage Design — Sprint 15C

**Status:** DESIGN ONLY · migrations UNAPPLIED · HOLD DEPLOY · DO NOT COMMIT  
**Date:** 2026-07-24

---

## 1. Executive summary

Track.cruises importer POC proved line/ship matching and canonical sailing conversion. The main gap was port coverage (76.7% → **100%** on the 10-cruise sample after catalogue expansion; Route Object eligibility 50% → **100%**).

This document designs persistent, provider-independent inventory storage so Engine V2 can eventually query **101cruise** data — not Track.cruises live. Migrations are drafted but **not applied**. Finder V1 / customer UI remain unchanged.

---

## 2–3. Catalogue sizes

| Catalogue | Count |
|-----------|------:|
| Existing ports (before 15C) | 220 |
| Proposed / expanded ports (after 15C) | **240** |
| Net new rows | **20** |

---

## 4–7. Gaps, ports, aliases, coordinates

Full gap table: `docs/cruise-port-gap-analysis.md`  
Alias review queue: `data/cruise-ports/port-alias-review.csv` (all `PENDING_REVIEW`)  
Coordinate review: `data/cruise-ports/port-coordinate-review.csv`

**Coordinate review highlights**

| Port | Status |
|------|--------|
| Piraeus | VERIFIED |
| Most Caribbean/Med additions | APPROXIMATE (terminal-area) |
| Hanga Roa / Easter Island | REVIEW_REQUIRED (tender) |
| Private islands (Princess Cays, Half Moon Cay, Ocean Cay) | APPROXIMATE + flagged private |

---

## 8–9. Before / after (10-cruise Princess sample, offline)

| Metric | Before | After |
|--------|-------:|------:|
| Ordinary port match rate | 76.7% | **100%** |
| Route Object eligibility | 50% | **100%** |
| Cruises with embark+disembark matched | 10 | **10** |
| Cruises with all ordinary ports matched | 5 | **10** |
| Unmatched ordinary port values | 13+ | **0** |

Exact vs alias: country-aware matching fixed Sydney AU ambiguity; many city+country forms resolve as MATCHED/ALIAS_MATCH without fuzzy guessing.

---

## 10. Proposed schema

### Entities

1. **`cruise_sailings`** — canonical sailing head  
2. **`cruise_sailing_itinerary`** — ordered stops (incl. sea / scenic)  
3. **`cruise_sailing_sources`** — provider lineage (multi-provider)  
4. **`cruise_import_runs`** — sync audit / request counts  

**No fare/price columns anywhere.**

Draft SQL: `supabase/migrations/20260735_cruise_canonical_inventory.sql`  
Ports expansion draft: `supabase/migrations/20260736_ports_catalogue_expansion_draft.sql`

---

## 11. Entity relationships

```
ci_cruise_lines ──┐
                  ├── cruise_sailings ──┬── cruise_sailing_itinerary → ports
ci_cruise_ships ──┘                    └── cruise_sailing_sources (provider, provider_cruise_id)
ports ───────────────────────────────────── departure_port_id / arrival_port_id
cruise_import_runs (audit only)
```

---

## 12. Canonical key rules

```
canonical_key = cruise_line_id|ship_id|YYYY-MM-DD|nights|departure_port_id
```

Fallbacks when IDs missing (import-time only, should be rare after matching):

- normalised provider line / ship names
- `p?` if departure port unmatched (sailing should usually be `needs_review`)

**Not part of key:** title, locale, currency, provider cruise id, price.

---

## 13. Merge rules

| Situation | Rule |
|-----------|------|
| Same sailing, multiple locales | One `cruise_sailings` row; multiple `sources` or same source upsert `last_seen_at` |
| Multiple currencies | Ignored (prices discarded before import) |
| Different provider IDs, same key | Multiple `cruise_sailing_sources` rows → one sailing |
| Title change | Update `title`; key unchanged |
| Itinerary correction | Replace itinerary rows when fingerprint changes; keep sailing id |
| Ship change | **New** canonical_key / sailing (old retired if provider stops sending) |
| Departure date change | New sailing |
| Missing itinerary_id | Allowed; identity uses sailing key + provider_cruise_id in sources |
| Provider duplicates | Unique `(provider, provider_cruise_id)` on sources |
| Disappearance | `sources.active=false`; if no active sources, sailing `status=retired` |

---

## 14. Source-lineage strategy

- Every imported provider row upserts `cruise_sailing_sources`.
- `raw_fingerprint` = hash of **price-stripped** payload.
- Fingerprint change → itinerary/title refresh + `records_updated`.
- Provider switch: new source row; Finder still reads `cruise_sailings`.

---

## 15. Data-retention recommendation

| Data | Recommendation |
|------|----------------|
| Canonical sailings + itinerary | Persist in Supabase |
| Provider source IDs + URLs + fingerprint | Persist |
| Full raw provider JSON | **Do not retain** in DB by default |
| Redacted fixtures | Keep under `tmp/` / test fixtures only (gitignored tmp) |
| Prices | **Never** store |

**Rationale:** Track.cruises is price-oriented; storing raw bodies risks fare leakage and licensing issues. Fingerprints give change detection without payload retention. Diagnostics can use short-lived redacted fixtures.

Security: admin RLS only until a deliberate public-read path is designed for Finder.

---

## 16. Finder V2 query strategy (design only)

Questionnaire → existing `NormalisedSearchRequest` → query **canonical inventory** (not live Track.cruises).

1. **Eligibility filter:** `active`, `departure_date` in window (or month/year), `nights` in min/max (or flexible bands), optional `departure_port_id` preference.  
2. **Destination matching:** sailing `destinations` jsonb and/or itinerary `port_id` ∈ destination port sets (future mapping table).  
3. **Holiday-style ranking:** soft rank using line segment / itinerary tags (no fares).  
4. **Presentation:** map inventory rows → existing result renderer contract (unchanged UI).

Budget input: keep as soft preference / messaging only until a licensed fare source exists — **no Track.cruises prices**.

---

## 17. Migration files

| File | Purpose | Applied? |
|------|---------|----------|
| `supabase/migrations/20260735_cruise_canonical_inventory.sql` | Inventory tables | **NO** |
| `supabase/migrations/20260736_ports_catalogue_expansion_draft.sql` | Ports upsert from expanded CSV | **NO** |

---

## 18. Migration risks

- `cruise_sailings.cruise_line_id` / `ship_id` are **UUIDs** FK → `ci_cruise_*`. Importer POC currently matches against Base44 export IDs — persistence layer must resolve `legacy_base44_id` → Supabase UUID before insert.  
- Applying ports seed with `provisional` status may differ from existing `verified` rows — review generator `--status`.  
- RLS admin-only means Finder cannot read via anon key until a service path exists.  
- Cartagena naming (`Cartagena Colombia` vs Spain `Cartagena`) must stay distinct in `match_key`.

---

## 19. Estimated cost

| Item | Estimate |
|------|----------|
| Schema storage | Negligible (<10 MB empty) |
| 10k sailings × ~15 itinerary rows | On the order of tens of MB |
| Supabase free/pro tier | Well within typical Pro plan DB |
| Track.cruises API | Separate ($0–$299/mo); not DB cost |
| Operating | Cron import + Netlify function time; keep request guards |

---

## 20. Recommendation — next phase (Phase 4)

1. Manual review of `port-alias-review.csv` + `port-coordinate-review.csv` (especially Easter Island, Crete→Heraklion).  
2. Apply **ports expansion** migration after review (or re-seed with `verified` where coords approved).  
3. Apply **inventory** migration in a non-prod project first.  
4. Build idempotent importer writer (still no customer Engine V2 activation).  
5. Continue broader commercial provider RFQ (Traveltek/Odysseus) — Track.cruises remains a bounded feed.

---

## Tests

See `scripts/test-cruise-inventory-15c.mjs` — offline, zero live API calls.
