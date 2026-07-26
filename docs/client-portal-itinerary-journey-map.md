# Client Portal — Itinerary Extraction & Journey Map

**Status:** Production path live · valid Booking Confirmations auto-approve; exceptions go to Needs Attention  
**Last updated:** 2026-07-26  
**Migrations applied (Original):** `20260726_itinerary_auto_processing.sql`, `20260726_itinerary_exceptions_notifications.sql`

---

## Summary

The Client Portal dashboard journey map is **data-driven**. It renders from an
**approved** `cruise_itineraries` row for the customer’s booking, with port
coordinates enriched from the canonical `ports` catalogue (including
`ports.aliases`).

The Celebrity Millennium Tokyo–Seoul map that appeared for booking reference
`SWM123456` was a **hardcoded demo fixture** in the planner (not a live
extraction). Live bookings must not depend on that fixture.

---

## End-to-end flow

```text
Booking Confirmation (Base44 sync via Admin get-booking, or Admin upload)
  → fingerprint document (idempotent)
  → extract once via shared OpenAI helper (lib/itinerary-extract.js)
  → validate (lib/itinerary-validation.js)
  → if all rules pass: status = approved, approval_method = automated
  → if any rule fails: status = review_required + structured failures
  → customer-itinerary.js serves approved journeys only
  → Client Portal dashboard renders geographic route map + ship animation
```

Exception path (Admin → Customer Experience → Booking Documents):

- Review required reasons are listed explicitly
- Manual Extract / Save draft / Approve / Revalidate remain as recovery tools
- Revalidate re-runs validation on stored JSON — **no OpenAI call**

### Rules

- Extraction is **one-shot per unchanged document** (hash fingerprint).
- Fully validated extractions **auto-approve**; uncertain cases stay `review_required`.
- Only documents classified as **Booking Confirmation** may be extracted.
- Customer login syncs document metadata only — **never extracts**.
- CRM Sync as a main Admin tab is **not** restored.
- Do not fabricate ports, dates, times, or coordinates.
- DEV Supabase URLs are refused by the auto-processor.

---

## Ship & cruise-line resolution

| Booking / extracted value | Canonical resolution |
|---------------------------|----------------------|
| `Explora 1` | `EXPLORA I` (terminal Arabic ↔ Roman numeral matching) |
| `Explora Cruises` (historical) | `Explora Journeys` (deliberate line alias / display canonicalisation) |
| `Explora Journeys` | unchanged |

Ship lookup uses `netlify/functions/lib/resolve-cruise-ship.js` (also used by
`get-ship`). Canonical catalogue names are preserved after match.

---

## Port catalogue additions (booking 10175811 gap)

Inserted into the Original (production) `ports` catalogue to complete Mediterranean
resolution for Explora booking **10175811**:

| Canonical port | Aliases | Notes |
|----------------|---------|--------|
| La Goulette | `Tunis/La Goulette`, `Tunis (La Goulette)` | Cruise harbour at La Goulette — not central Tunis |
| Valletta | `La Valletta` | Valletta Waterfront / Pinto Wharf area |
| Giardini Naxos | `Giardini-Naxos` | Own port identity — not Messina or Catania |
| Sorrento | — | Own port identity — not Naples |

Coordinates were verified via OpenStreetMap Nominatim harbour / marina features.
Seed script (ops reference): `scripts/seed-ports-booking-10175811.mjs`.

`customer-itinerary` indexes `canonical_name`, `display_name`, `city`, and
`aliases` through `netlify/functions/lib/customer-port-match.js`.

---

## Booking 10175811 status

- Itinerary is **manually approved** in production (do not re-extract / reapprove
  during automation work).
- Validation fixture for this voyage yields **seven** unique plotted ports after
  Ibiza overnight collapse and **passes** auto-approval rules offline:

  Barcelona → Ibiza → La Goulette → Valletta → Giardini Naxos → Sorrento → Civitavecchia

- Adding a missing port alias can move a `review_required` row to `approved` via
  **Revalidate** (stored JSON only — no new OpenAI call).

---

## Related Admin UI

- **Customer Experience → Booking Documents** — load booking, document library,
  Extract itinerary, review JSON, Save draft, Approve itinerary.
- Import Data → Emergency CRM recovery — Base44 sync only; not the itinerary workflow.

---

## Geographic land layer

The dashboard map is an **SVG** with:

1. Pale blue water fill  
2. Bundled **Natural Earth** land polygons (TopoJSON → SVG paths)  
3. Dashed route, port markers/labels, animated ship (`animateMotion` on the same projected path)

| Item | Detail |
|------|--------|
| Projection | Aspect-corrected equirectangular (Plate Carrée); bounds from itinerary coords + padding |
| Dataset | `assets/geo/land-50m.json` (fallback `land-110m.json`) — Natural Earth via `world-atlas` |
| Licence | Natural Earth **public domain**; `world-atlas` / `topojson-client` **ISC** |
| Cost | **None** — no Mapbox, Google Maps, tile APIs, API keys, or subscriptions |
| Fallback | If land fails to load, the route-only map remains; customer sees no technical error |

See also `assets/geo/README.md` and `docs/route-map-coastline.md`.

---

## Tests

- `scripts/test-itinerary-auto-process.mjs`
- `scripts/test-admin-itinerary-ui.mjs`
- `scripts/test-dashboard-journey.mjs`
- `scripts/test-dashboard-journey-map-land.mjs`
- `scripts/test-client-portal-ui-fixes.mjs`
- `scripts/test-resolve-cruise-ship.mjs`
- `scripts/test-ports-booking-10175811.mjs`

## Migration

Apply `supabase/migrations/20260726_itinerary_auto_processing.sql` before enabling
auto-processing in production (adds fingerprint/lock columns, validation audit
fields, and `cruise_itinerary_versions`).
