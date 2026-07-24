# Cruise Port Gap Analysis — Sprint 15C

**Status:** RESEARCH + CATALOGUE EXPANSION · HOLD DEPLOY · DO NOT COMMIT  
**Sample:** 10 Princess Track.cruises sailings (offline fixtures)  
**Before catalogue size:** 220 · **After:** 240

---

## Summary classifications

| Classification | Count (unique provider values) |
|----------------|--------------------------------|
| Genuine cruise port missing | 10 |
| Private island / private destination | 1 (+ future private islands documented) |
| Alias for existing / new canonical port | 5 |
| Region rather than port | 1 (Crete → Heraklion) |
| Duplicate / cross-country collision | 2 (Sydney AU vs NS; Cartagena CO vs ES) |
| Scenic-cruising / transit (not ordinary port) | several (already classified by importer) |
| Non-port event (sea / date line) | several |
| Requires manual review (coords) | Hanga Roa / Easter Island tender |

---

## Unmatched / ambiguous values (pre-expansion)

### Roatan, Honduras
- **Context:** Princess G630A · day 5 · port  
- **Proposed:** Roatan · Roatán · Honduras · HN · Caribbean  
- **Aliases:** Roatán\|Mahogany Bay\|Coxen Hole\|Roatan Honduras  
- **Coords:** 16.329, -86.446 · APPROXIMATE (Mahogany Bay)  
- **Classification:** genuine cruise port missing  
- **Confidence:** HIGH · **Action:** ADDED

### Belize City, Belize
- **Context:** Princess G630A · day 6  
- **Proposed:** Belize City · BZ · Caribbean · 17.494, -88.182 APPROXIMATE  
- **Classification:** genuine cruise port · **Action:** ADDED

### Cozumel, Mexico
- **Context:** G630A / Caribbean sailings · day 7  
- **Proposed:** Cozumel · MX · 20.508, -86.948 APPROXIMATE (International Pier area)  
- **Classification:** genuine cruise port · **Action:** ADDED

### Princess Cays, Bahamas
- **Context:** G630A · day 9  
- **Proposed:** Princess Cays · BS · Bahamas · 24.577, -76.18 APPROXIMATE  
- **Classification:** private island · **Action:** ADDED

### Crete, Greece
- **Context:** Sun Princess U629 · day 4  
- **Proposed canonical:** Heraklion (not “Crete” as a port row)  
- **Aliases on Heraklion:** Crete\|Crete Greece  
- **Coords:** 35.343, 25.141 APPROXIMATE  
- **Classification:** region → primary cruise port  
- **Confidence:** MEDIUM · **Action:** ADDED (alias PENDING_REVIEW in review CSV)

### Kusadasi (Ephesus), Turkey
- **Context:** U629 · day 5  
- **Proposed:** Kusadasi · TR · 37.862, 27.256 · aliases Ephesus  
- **Classification:** genuine cruise port · **Action:** ADDED

### Mykonos, Greece
- **Context:** U629 · day 6 · Tourlos  
- **Proposed:** Mykonos · 37.465, 25.324 APPROXIMATE  
- **Action:** ADDED

### Athens (Piraeus), Greece
- **Context:** U629 · disembarkation  
- **Proposed:** Piraeus · aliases Athens\|Athens (Piraeus) · 37.943, 23.646 VERIFIED  
- **Classification:** alias for cruise port · **Action:** ADDED

### Manta, Ecuador
- **Context:** Crown Princess 3616 · day 17  
- **Proposed:** Manta · EC · -0.942, -80.728 · **Action:** ADDED

### Lima (Callao), Peru
- **Context:** 3616 · day 19  
- **Proposed:** Callao · aliases Lima\|Lima (Callao) · -12.047, -77.143 · **Action:** ADDED

### Pisco (general San Martin), Peru
- **Context:** 3616 · day 20  
- **Proposed:** Pisco · General San Martín terminal · -13.708, -76.219 APPROXIMATE  
- **Classification:** tender/harbour · **Action:** ADDED

### Easter Island, Chile
- **Context:** 3616 · day 21  
- **Proposed:** Hanga Roa · aliases Easter Island\|Rapa Nui · -27.15, -109.432 **REVIEW_REQUIRED** (tender)  
- **Classification:** tender destination / island label · **Action:** ADDED with review flag

### Sydney, Australia
- **Context:** 3616 · disembarkation · was **AMBIGUOUS** vs Sydney Nova Scotia  
- **Classification:** duplicate canonical location (cross-country)  
- **Action:** matcher country-disambiguation fix (no new row; Australia Sydney already existed)

### Cartagena, Colombia
- **Context:** 3616 · remained unmatched after first expansion (Spain Cartagena exists)  
- **Proposed:** Cartagena Colombia · CO · 10.406, -75.539 APPROXIMATE  
- **Classification:** duplicate name / missing country variant · **Action:** ADDED

### Grand Turk, Turks and Caicos
- **Context:** B624A · day 11  
- **Proposed:** Grand Turk · TC · 21.434, -71.137 · **Action:** ADDED

---

## Non-port / scenic (correctly excluded from ordinary port matching)

| Provider value | Classification | Action |
|----------------|----------------|--------|
| At Sea / Fun Day At Sea | non-port sea day | classifier only |
| Glacier Bay … scenic Cruising | scenic_cruising | not ordinary port |
| Panama Canal Full Transit… | scenic/transit | not ordinary port |
| Cross International Date Line | non-port event | classifier only |

---

## Proactive additions (sample-adjacent / high value)

Half Moon Cay, Ocean Cay, Key West, Whittier, Santorini, Istanbul — added for Caribbean/Med/Alaska coverage beyond the strict unmatched list.

---

## After-expansion sample result

- Ordinary port match: **100%**
- Route Object eligibility: **100%**
- Unmatched ordinary ports: **none**
- Embark+disembark matched: **10/10**
- All ordinary ports matched: **10/10**

See `docs/cruise-inventory-storage-design.md` for storage design and next steps.
