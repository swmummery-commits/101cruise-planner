# Living Bible Update — Technical: Social Pack Generator

**Status:** Weekly production ready  
**Date:** 2026-07-29  
**Note:** Master Living Edition Technical Bible was not found on this machine. Paste this section into the current Technical Living Edition.

---

## Netlify function

- `POST /.netlify/functions/social-pack-generate` (admin auth via `requireAdmin`)
- Actions: `readiness`, `preview`, `download_cruise`, `download_issue`
- **Never writes** Featured Cruise, Media Library, booking, or customer records

## Server rendering

| Module | Role |
|--------|------|
| `lib/social-pack-data.js` | Load cruise model, readiness, hydrate media |
| `lib/social-pack-destination.js` | Destination resolution + rotation |
| `lib/social-pack-pricing.js` | Public pricing select/sanitize/filter |
| `lib/social-pack-master-slide.js` | Approved Main card (Concept A) |
| `lib/social-pack-offer-cta.js` | Approved Pricing + CTA cards |
| `lib/social-pack-render.js` | Slide plan, background prep, PNG via resvg |
| `lib/social-pack-zip.js` | ZIP + public-safe manifest |
| `lib/social-pack-caption.js` | caption.txt |
| `lib/social-pack-fonts.js` | Bundled fonts for resvg |

## Fonts

Bundled under `assets/fonts/social-pack/`:

- Montserrat (body / pricing) — SIL OFL
- League Spartan (CTA headline) — SIL OFL
- Great Vibes (script fallback) — SIL OFL  
Feeling Passionate artwork: `assets/social-pack/get-your-cruise-on.png` (not redistributed as a font)

`resvgFontOptions()` uses `loadSystemFonts: false`.

## Destination resolution / rotation

See `resolveSocialBackground` / `rotationIndex` in `social-pack-destination.js`. Rotation is deterministic from cruise id + newsletter index; preview regeneration stays stable unless Previous/Next or manual media id is applied.

## PNG / ZIP

- Portrait **1080 × 1350**
- Plan: `01-main-cruise.png` → `02-offer-[slug].png`… → `final-call-to-action.png` + `caption.txt`
- No Journey slide by default
- ZIP: `newsletter-[N]-social-pack.zip`

## Security exclusions

`PUBLIC_PRICING_SELECT` omits `airline_price` and `category`. Sanitize strips confidential keys. Render rejects airline/airfare wording in SVG output.

## Tests

`scripts/test-social-pack-generator.mjs` — templates, no journey, unlimited rooms, include/exclude, long labels, missing brochure/inclusions/prices, rotation guards, PNG size, ZIP, captions, admin auth, airline exclusion.

Full issue fixture: `scripts/generate-social-pack-newsletter-77.mjs`

## Admin UI

`js/admin-social-pack.js` + `css/admin.css` — room checkboxes, loading copy via AdminLoading/BrandLoading, Download This Cruise / Newsletter pack.
