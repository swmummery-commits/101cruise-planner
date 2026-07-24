# Cruise Intelligence Engine — Cruise DNA Foundation (Sprint 16B)

**Status:** FOUNDATION MODULE · NOT customer-wired · HOLD DEPLOY · DO NOT COMMIT · DO NOT PUSH  
**Date:** 2026-07-24

## Purpose

The Cruise Intelligence Layer sits between **canonical inventory** and the **future Cruise Finder**.

It produces deterministic **Cruise DNA** scores (0–100) and matches them to a **customer preference vector** derived from the existing questionnaire — without changing that questionnaire or activating Finder V2.

No AI. No LLM. No randomness. Provider-independent.

---

## Cruise DNA model

Fifteen categories (see `dna-model.js`):

| ID | Label | Meaning |
|----|-------|---------|
| adventure | Adventure | Active / rugged / discovery-forward voyages |
| relaxation | Relaxation | Sea days, spa, warm leisure, private islands |
| luxury | Luxury | Premium lines, smaller ships, exclusive areas |
| wildlife | Wildlife | Alaska, polar, Galápagos, nature corridors |
| culture_history | Culture & History | Heritage ports / Med / Japan / landmark cues |
| food_wine | Food & Wine | Culinary regions + specialty dining signals |
| nightlife | Nightlife | Bars, casino, theater, large-ship entertainment |
| family | Family | Kids club, warm family destinations, mid-length trips |
| romance | Romance | Scenic evenings, spa, premium intimacy cues |
| scenic_cruising | Scenic Cruising | Glacier / fjord / canal / scenic-passage days |
| expedition | Expedition | Polar / remote / expedition brands |
| value_for_money | Value for Money | Mainstream positioning (not a fare) |
| accessibility | Accessibility | Round-trip / shorter / simpler proxies (not a certified audit) |
| first_time_friendly | First-Time Cruiser Friendly | Approachable durations & mainstream product |
| experienced_appeal | Experienced Cruiser Appeal | Longer / uncommon / complex voyages |

---

## Scoring inputs (available today)

From **canonical sailings**:

- `nights`, `destinations[]`, `title`
- itinerary stop `type` counts (`sea`, `scenic_cruising`, `port` / embark / disembark)
- round-trip detection
- cruise line + ship names
- provider port / scenic text (Glacier Bay, private islands, etc.)

From **optional ship enrichment** (`ci_cruise_ships` / CSV `facilities`):

- `passenger_capacity`, `year_built`
- `kids_club`, `spa`, `casino`, `theater`, `bars`, `specialty_dining`, `restaurants`, `exclusive_areas`

From **optional line enrichment**:

- name-based luxury / mainstream / expedition brand lists
- `line_type` when present (`expedition`, etc.)

**Not used (unavailable / forbidden):** provider prices, invented amenities, LLM text.

---

## Weighting rules (examples)

Rules live in `score-cruise-dna.js` as integer deltas + reason strings.

| Category | Example contributions |
|----------|------------------------|
| Wildlife | +30 Alaska · +35 Antarctica · +40 Galápagos · +15 glacier text · scenic days |
| Scenic cruising | +25 Alaska · +20 glacier · +12 per scenic day (capped) · +30 Norway fjords |
| Culture & History | +30 Mediterranean · +12 heritage port cues · +25 Japan |
| Luxury | +40 luxury line · +15 small ship · +10 exclusive areas · −10 mega-ship |
| Family | +25 kids club · +20 Caribbean · +8 week-length |
| Value | +25 mainstream line · +10 large ship · −15/ −20 when luxury-leaning |
| First-time | +20 short voyage · +15 mainstream · +10 round-trip |

Scores are summed then **clamped to 0–100**.

---

## Explanation model

Every non-zero category keeps an ordered, de-duplicated list of reason strings, e.g.:

```
wildlife: 88
  - Alaska itinerary
  - Glacier / ice scenery on itinerary
  - 1 scenic-cruising day(s)
```

Stored on the DNA result as `explanations[categoryId]: string[]` and summarised in `topCategories`.

---

## Customer profile model

`buildCustomerProfile(answers)` maps **existing** Finder answer IDs only:

- `styles[]` → `STYLE_TO_DNA`
- `durationId` → duration bands
- `budgetId` → value vs luxury lean
- `departure` → accessibility / fly-anywhere adventure
- `destinationId(s)` → region boosts (Alaska, Caribbean, Med, …)

Outputs:

- `scores` (0–100 per DNA category)
- `weights` (normalised so **Σ weights = 1**)
- `explanations`

Questionnaire UI is **not** modified.

---

## Matching algorithm

`matchCruisesToCustomer(answers, sailings)`:

1. Build customer DNA + weights  
2. Score each sailing’s Cruise DNA  
3. Weighted vector similarity → `matchScore` (0–100)  
4. Bucket (design labels, not UI):

| Bucket | Rule (v1) |
|--------|-----------|
| Best Match | `matchScore ≥ 70` (else top 3 overall) |
| Also Worth Considering | `55 ≤ score < 70` |
| Hidden Gems | Strong on customer’s #1 category (≥60) but mid overall (40–69) |
| Alternative Style | Cruise ≥70 on a category where customer <30 |

Not wired to customer pages.

---

## Module layout

```
netlify/functions/lib/cruise-intelligence/
  index.js
  dna-model.js
  extract-features.js
  score-cruise-dna.js
  customer-profile.js
  match-engine.js
```

Tests: `scripts/test-cruise-intelligence.mjs`  
NPM: `npm run test:cruise-intelligence`

---

## Future AI extension points (optional later)

- Suggest new rule candidates from unmatched port text (human approval still required)
- Natural-language explanation polishing (must not change numeric scores)
- Learning weights from booking outcomes (offline, versioned)

Deterministic DNA v1 remains the source of truth until a versioned successor is approved.

---

## Limitations

- Region detection uses substring flags — can miss obscure ports until catalogue/text improves  
- Accessibility is a **proxy**, not ADA / mobility certification  
- Value for money is **positioning**, not live fares  
- Ship facility enrichment is optional; without it, onboard scores are thinner  
- Not yet persisted on `cruise_sailings` rows  

---

## Recommended next sprint

1. Persist Cruise DNA JSON on canonical sailings (DEV DB) via a read-only scorer job  
2. Expand region dictionaries from unmatched port list (16A)  
3. Wire Engine V2 **behind a flag** to rank inventory by DNA match (still no customer UI change until approved)  
4. Admin preview: show DNA + explanations for one sailing  

---

## Git

Local foundation only. **HOLD DEPLOY. DO NOT COMMIT. DO NOT PUSH.**
