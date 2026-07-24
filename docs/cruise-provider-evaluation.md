# Cruise Provider Evaluation — Sprint 14B

**Status:** RESEARCH ONLY — no Engine V2 / Finder V1 code changes · HOLD DEPLOY · do not commit  
**Date:** 2026-07-24  
**Context:** Engine V2 contracts and provider framework already exist. Vacationstogo rejected in Phase 1A. Goal: choose a long-term **licensed** discovery foundation, especially commercial inventory used by agencies/OTAs.

---

## Executive Summary

Public cruise websites (CruiseMapper, Cruise Critic, Seascanner, iCruise, Logitravel, CruiseTimetables, CruiseDig) are **poor long-term providers** for Engine V2. Most prohibit automated collection in Terms of Use, lack public APIs, and/or require fragile HTML scraping.

**Official cruise-line websites** can supply sailings, but each line has different HTML/JS stacks, robots rules, and anti-bot posture. 101cruise already runs a Brave + official-page Discovery pipeline with **high maintenance** and incomplete coverage — that path is a weak primary foundation for Engine V2.

**Commercial cruise inventory platforms** (Traveltek, Travelport, Amadeus, Sabre, Odysseus Data Cache, Cruqo, and self-serve track.cruises) are the only category that offers:

- normalised itineraries across many lines  
- stable sailing identifiers  
- contractual permission to consume data  
- Netlify-friendly JSON/XML/file feeds  

Published list prices are rare (most are quote-only). The only **transparent self-serve** schedule-capable API found is **track.cruises** (RapidAPI: $0–$1,499/mo) with only **9 cruise lines**. Agency-grade coverage (Traveltek ~27+ lines / 30k+ itineraries; Amadeus 30+ bookable / 100+ searchable) requires sales engagement.

**Business recommendation:** treat a **licensed commercial inventory API** as the primary Engine V2 source. Issue RFQs to Traveltek and Odysseus (Data Cache), run a low-cost track.cruises sandbox for schema fit, and keep official-line adapters only as optional verification — not as the catalogue builder.

---

## Preferred architecture (Option C, commercial-led)

```
Finder questionnaire (unchanged)
        ↓
Engine V2 normalised search request
        ↓
Primary: Licensed commercial inventory provider
        ↓  (optional secondary)
Official cruise-line detail fetch for confirmation / enrichment
        ↓
Engine V2 candidate cruises (no prices stored/displayed in Finder)
        ↓
Existing result renderer contract
```

Ignore prices even if the commercial feed includes them (Engine V2 contract forbids price fields in candidates).

---

## Provider rankings (best → worst for Engine V2)

| Rank | Provider | Category | Verdict |
|------|----------|----------|---------|
| 1 | **Traveltek Cruise API** | Commercial agency/OTA | **Best long-term candidate** — broad coverage, JSON/XML, Market Cache, itineraries; quote required |
| 2 | **Odysseus Cruise Data Cache** | Commercial file feed | **Excellent schedule-cache fit** — standardised sailing files, multi-day updates; quote required |
| 3 | **Travelport Cruise Web Services** | GDS | Strong if agency credentials exist; XML cruise shopping; commercial agreement |
| 4 | **Amadeus Cruise / Cruise Portal** | GDS / seller portal | Strong search/book content; more portal/white-label than raw schedule-only API |
| 5 | **Sabre Cruises API** | GDS | Viable via Sabre/integrator; itinerary + book flow; commercial |
| 6 | **Cruqo Universal API** | Commercial (Asia-strong) | Modern OTA API; 25+ brands; Asia-centric; quote required |
| 7 | **track.cruises (RapidAPI)** | Self-serve commercial | **Cheapest sandbox**; ports_list + cruise_id; only 9 lines; price-oriented |
| 8 | **Official cruise-line sites** (aggregate) | Official | Feasible but **HIGH maintenance**; inconsistent; already strained in Discovery V1 |
| 9 | CruiseMapper | Public aggregator | Rich data, but ToS bans automated collection |
| 10 | CruiseDig | Public aggregator | Useful human schedules; no licensed API found |
| 11 | CruiseTimetables | Public aggregator | Disclaimer-heavy; not a licensed inventory source |
| 12 | iCruise / Logitravel / Seascanner | OTA websites | Retail sites; no public inventory API; robots/ToS scraping risk |
| 13 | Cruise Critic | Media / reviews | ToS bans scrapers; home probe returned **403** + bot markers |
| — | Vacationstogo | Public OTA | Already rejected (Phase 1A) |

---

## Provider comparison matrix

Scores: 1–10 (higher is better). Maintenance / Legal risk inverted so **higher = better** (lower burden / lower risk).

| Provider | Reliability | Coverage | Structured | ID stability | Ease | Maint.↑ | Legal↑ | Scale | Overall |
|----------|-------------|----------|------------|--------------|------|---------|--------|-------|---------|
| Traveltek | 9 | 9 | 9 | 9 | 7 | 8 | 9 | 9 | **9.0** |
| Odysseus Cache | 8 | 8 | 8 | 8 | 7 | 8 | 9 | 8 | **8.1** |
| Travelport Cruise | 8 | 8 | 8 | 8 | 5 | 7 | 9 | 8 | **7.6** |
| Amadeus Cruise | 8 | 8 | 7 | 8 | 5 | 7 | 9 | 8 | **7.5** |
| Sabre Cruises | 7 | 7 | 7 | 8 | 5 | 6 | 9 | 7 | **7.0** |
| Cruqo | 7 | 7 | 8 | 8 | 7 | 8 | 8 | 7 | **7.5** |
| track.cruises | 6 | 4 | 8 | 7 | 9 | 9 | 8 | 5 | **7.0** |
| Official lines | 5 | 7 | 4 | 5 | 3 | 2 | 5 | 6 | **4.6** |
| CruiseMapper | 6 | 8 | 6 | 6 | 4 | 3 | 2 | 5 | **5.0** |
| CruiseDig | 5 | 6 | 4 | 4 | 3 | 3 | 3 | 4 | **4.0** |
| CruiseTimetables | 4 | 5 | 3 | 3 | 3 | 3 | 3 | 3 | **3.4** |
| iCruise / Logitravel / Seascanner | 4 | 5 | 3 | 3 | 2 | 2 | 2 | 4 | **3.1** |
| Cruise Critic | 3 | 5 | 4 | 4 | 2 | 2 | 1 | 3 | **3.0** |

---

## Commercial inventory providers (deep dive)

### 1. Traveltek Cruise API — Rank #1

| Topic | Finding |
|-------|---------|
| Available fields | Itineraries, ship/line content, cabin types, live pricing & availability, deck plans/images (product marketing). Engine V2 can map sailings and **discard fares**. |
| Exposure | JSON & XML API; Market Cache; webhooks for content updates |
| Stable IDs | Yes (supplier sailing / product identifiers via unified API) |
| Auth / session | Licensed credentials; agency/OTA commercial agreement |
| Anti-bot | N/A (contractual API) |
| Netlify fit | **Yes** — server-side HTTPS to Traveltek endpoints |
| Change cadence | Real-time / continuous supplier sync |
| Consistency | Normalised across 27+ suppliers |
| Maintenance | **LOW–MEDIUM** (vendor absorbs line API churn) |
| Legal | Licensed commercial use |
| Cost | **Quote only.** Public pages do not list fees. Industry chatter / secondary sources mention legacy patterns like setup + monthly + per-booking; **treat as unverified**. Contact Traveltek sales. |
| Coverage claim | 27+ cruise suppliers, 30,000+ itineraries (vendor marketing) |

**Fit for “schedules without pricing”:** Strong — request whether Market Cache / search can return itinerary-only payloads or whether fares can be ignored under licence.

### 2. Odysseus Cruise Data Cache — Rank #2

| Topic | Finding |
|-------|---------|
| Available fields | Sailing availability + pricing in **standardised file format**; multi-currency; cabin categories; agency negotiated fares optional |
| Exposure | File-based cache (customer-specific format), updates several times/day |
| Stable IDs | File keys / sailing identifiers (confirm in RFQ) |
| Auth | Commercial customer |
| Netlify fit | **Yes** — pull files to object storage / process in Functions or scheduled job |
| Maintenance | **LOW–MEDIUM** |
| Cost | **Quote only** |
| Note | Booking engine is separate; **Data Cache** is the schedule-oriented product most aligned with Finder discovery |

### 3. Travelport Cruise Web Services

| Topic | Finding |
|-------|---------|
| Available fields | Shop / book / modify / cancel; normalised multi-vendor cruise XML |
| Exposure | Cruise Web Services (XML); docs describe sessionless cruise transactions with client-held state |
| Auth | Travelport agency agreement + API certification |
| Cost | Quote. Broader Travelport API literature cites **~US$5,000/year** access patterns for API programs (AltexSoft / integrator blogs) — **may not equal cruise-only pricing**; confirm with Travelport. |
| Fit | Excellent if 101cruise already (or will) hold Travelport credentials; heavier than Traveltek for a schedule-only Finder |

### 4. Amadeus Cruise Portal / cruise content

| Topic | Finding |
|-------|---------|
| Available fields | Search/compare 100+ lines; book 30+; itineraries; pricing synced with lines |
| Exposure | Seller portal + white-label engines; API access via Amadeus commercial channels |
| Cost | Quote / seller contract |
| Fit | Strong for agencies selling cruises; less ideal if only need anonymous schedule discovery without booking |

### 5. Sabre Cruises API

| Topic | Finding |
|-------|---------|
| Available fields | Itinerary search, cabins, pricing, packages |
| Exposure | Sabre cruise APIs via Sabre or integrators (e.g. Travelopro-style wrappers) |
| Cost | Quote; typically tied to Sabre agency relationship |
| Fit | Viable if Sabre stack already planned; otherwise secondary to Traveltek/Odysseus |

### 6. Cruqo Universal API

| Topic | Finding |
|-------|---------|
| Available fields | Live inventory, booking, reporting; 25+ brands, 25,000+ voyages (vendor claim) |
| Exposure | Modern serverless Universal API; 4–12 week typical integration |
| Geography | **Asia-strong** distribution (Klook, KKday, Fliggy cited) |
| Cost | Quote by volume/market |
| Fit | Consider if AU/Asia inventory priority; otherwise Traveltek first for global ocean majors |

### 7. track.cruises — only transparent self-serve pricing found

| Tier | Approx. price | Limits (vendor docs) |
|------|---------------|----------------------|
| BASIC | **$0** | Stale 7–30 day data, 10 rows/req, no price history |
| PRO | **$49/mo** | Real-time, 10k req/mo, 100 rows/req |
| ULTRA | **$299/mo** | 100k req/mo, 500 rows/req |
| MEGA | **$1,499/mo** | Unlimited quota class, 1000 rows/req |

| Topic | Finding |
|-------|---------|
| Schema | `cruise_id`, company, ship_name, departure_date, duration, `ports_list[]`, itinerary_url |
| Coverage | **9 lines only** (Princess, NCL, Celebrity, RCL, Costa, Carnival, HAL, MSC, Disney) |
| Prices | Included — Engine V2 must strip them |
| Legal | Commercial RapidAPI product (licensed consumption) |
| Fit | **Best cheap POC** to validate Engine V2 mapping; **not** full Finder coverage |

### 8. Ensemble / Revelex benchmark (agency retail tech)

Published Ensemble ClientSites fees (USD, annual billing context):

- Cruise Search: **$99/mo**  
- Cruise Search + Booking Engine: **$1,250/mo**  

Useful as a **market price anchor** for “cruise search product,” not a direct Engine V2 recommendation.

### 9. Softvoyage

Canadian booking-engine focus; Ensemble lists ~**CAD $200/mo** + **CAD $1,250** one-time licence for Softvoyage booking engine. Not AU-primary.

---

## Public / third-party websites (summary)

### CruiseMapper

- Home/robots probe: HTTP 200; robots mostly open (`Disallow: /admin/`); JSON-LD present.  
- **Terms explicitly prohibit** systematic/automated data collection without written consent.  
- Third-party Apify scrapers exist — **do not use** for 101cruise.  
- **Reject as provider.**

### Cruise Critic

- Terms prohibit robots/scrapers without permission.  
- Home probe: **HTTP 403** + bot markers.  
- Review/itinerary content is media, not licensed inventory.  
- **Reject.**

### CruiseTimetables / CruiseDig

- Human-oriented schedules; no licensed API found.  
- CruiseTimetables disclaimer: verify with cruise lines; prices not timely.  
- CruiseDig robots: many Disallows.  
- **Reject as automated providers.**

### Seascanner / iCruise / Logitravel

- Retail OTAs. Dense robots (Seascanner ~331 Disallow rules).  
- No public inventory API identified.  
- **Reject scraping; pursue affiliate only if product needs booking referrals (out of Engine V2 scope).**

### Official cruise lines (RCL, Celebrity, Princess, HAL, NCL, MSC, Carnival, Cunard, Silversea, Oceania, Regent, Azamara, Virgin)

- Already partially handled via Discovery adapters (Celebrity, RCL, Princess, Virgin, Windstar + generic).  
- Robots probes: all returned 200 with varying Disallow density (HAL 105, NCL 84, Celebrity 11, etc.).  
- Typically **server + client-rendered**, cookies, WAF.  
- Fields exist on itinerary pages but **not consistently structured**.  
- Maintenance: **HIGH**. Prefer as **verification**, not primary catalogue.

---

## Data normalisation vs Engine V2 contract

| Field | Traveltek / Odysseus / GDS | track.cruises | Official HTML | Public aggregators |
|-------|----------------------------|---------------|---------------|--------------------|
| cruise line | Excellent | Good (enum) | Good | Good |
| ship | Excellent | Good | Medium | Good |
| departure / return / nights | Excellent | Good | Medium | Medium–Good |
| ports / itinerary | Excellent | Good (`ports_list`) | Variable | Good (CruiseMapper) |
| sea days | Often inferable | Inferable | Variable | Variable |
| stable ID / URL | Excellent | `cruise_id` | Weak–Medium | Medium |
| prices | Present (ignore) | Present (ignore) | Often present | Often present |

**Likely match rates into 101cruise catalogues** (after commercial feed; estimates):

| Entity | Commercial API | Official scrape | Public scrape |
|--------|----------------|-----------------|---------------|
| Cruise lines | 90–98% | 80–95% | 85–95% |
| Ships | 85–95% | 70–90% | 75–90% |
| Ports | 75–90% (alias work) | 70–85% | 70–85% |
| Dates / itineraries | 90–99% | 60–85% | 70–90% |

(Port rates depend on continuing ports-catalogue growth — Phase 1 fixture POC already showed ~75% on Mediterranean fixtures.)

---

## Legal / licensing summary

| Source type | Automated use | Recommendation |
|-------------|---------------|----------------|
| Licensed commercial API / data cache | Allowed under contract | **Pursue** |
| Official sites without written permission | Grey / ToS-dependent; fragile | Verification only |
| CruiseMapper / Cruise Critic / similar | Explicitly restricted | **Do not scrape** |
| OTA retail sites | Restricted / robots-heavy | **Do not scrape** |

Do not bypass CAPTCHA, auth, or robots. Do not subscribe in this sprint.

---

## Cost review (known vs unknown)

| Provider | Setup | Monthly | Usage | Notes |
|----------|-------|---------|-------|-------|
| track.cruises | $0 | $0–$1,499 | Included in tier | Self-serve RapidAPI |
| Revelex (Ensemble list) | — | $99 / $1,250 | — | Search vs search+book |
| Softvoyage (Ensemble CA) | CAD $1,250 | CAD $200 | — | Booking engine |
| Traveltek | Quote | Quote | Often booking-linked | **RFQ required** |
| Odysseus Data Cache | Quote | Quote | File pull | **RFQ required** |
| Travelport / Amadeus / Sabre | Quote (+ possible certification) | Quote | Transactional possible | Agency relationship |
| Cruqo | Quote | Quote | Volume-based | Asia focus |
| Travelport API literature | — | ~US$5k/yr cited | — | Unverified for cruise-only |

**No “schedules-only free commercial API” with broad coverage was found.** Closest cheap path: track.cruises BASIC/PRO for schema proof; then upgrade to Traveltek/Odysseus for production coverage.

---

## Strengths / weaknesses / risks

### Strengths of commercial path

- Contractual right to use data  
- Stable IDs and normalised itineraries  
- One integration vs N cruise-line scrapers  
- Aligns with how real agencies/OTAs source inventory  

### Weaknesses

- Most pricing is opaque until sales calls  
- Feeds usually include fares/availability (must strip for Engine V2)  
- May require travel-agency / ARC–IATA-style credentials for full GDS products  
- Vendor lock-in unless multi-provider architecture is designed early  

### Technical risks

- Quote delays; sandbox access gated  
- AU market content gaps on Asia-centric vendors  
- track.cruises coverage too thin for production Finder  

### Legal risks

- Low for licensed APIs; **high** for scraping ToS-restricted sites  

### Maintenance risks

- Commercial: LOW–MEDIUM  
- Official scrape-primary: HIGH (already evidenced by Discovery V1)  

---

## Recommendation

### Strategic choice

**OPTION 4 — Purchase / licence commercial cruise inventory access** as the Engine V2 foundation (after RFQ), using a multi-provider-capable architecture so a second feed can be added later.

### Phase 3 (recommended next sprint)

1. **RFQ pack** (no code): Traveltek Cruise API + Odysseus Cruise Data Cache — ask explicitly:  
   - itinerary/schedule access **without** mandatory fare display  
   - AU market content  
   - sandbox timeline & fees  
   - sailing ID schema samples  
2. **Sandbox:** track.cruises PRO ($49) for 2–4 weeks to prove Engine V2 mapping end-to-end (still HOLD production activation).  
3. **Decision gate:** choose Traveltek vs Odysseus (or dual) based on quotes + sample payloads.  
4. Only then implement a production `CruiseDiscoveryProvider` — still behind `CRUISE_FINDER_ENGINE=v1` until ready.

### Do not

- Scrape CruiseMapper / Cruise Critic / OTAs  
- Revisit Vacationstogo  
- Bet Engine V2 solely on official-site HTML scraping  

---

## Probe notes (minimal GETs, 2026-07-24)

Artifacts: `tmp/cruise-provider-eval-14b/summary.json`

- Cruise Critic home: **403** + bot markers  
- CruiseMapper: 200, JSON-LD, open robots except `/admin/`  
- Seascanner robots: very restrictive (~331 Disallows)  
- Official line robots: all reachable; cookies common  

---

## Final recommendation line

**PROCEED WITH COMMERCIAL API**
