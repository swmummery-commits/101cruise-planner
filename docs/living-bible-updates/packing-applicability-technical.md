# Living Bible Update — Technical: Packing applicability

**Status:** Active architecture (legacy Smart Profiles retired from Admin)  
**Date:** 2026-08-05  
**Note:** Master Living Edition Technical Bible was not found on this machine. Paste this section into the current Technical Living Edition.

---

## Customer filtering source of truth

`js/planner.js` filters catalogue items with `packingItemApplies(item, context)` using only direct `packing_items` fields:

- `destination_tags`
- `climate_tags`
- `traveller_types`
- `dress_codes`
- `cruise_line_tags`

Empty tags for a dimension mean “matches any”. The planner does **not** read `smart_profiles`, `smart_profile_members`, `packing_item_profiles`, or `smart_profile_groups`.

If the item has tags for a dimension but the context value is empty/unknown, the item does **not** apply for that dimension (no guessed Mediterranean destination or climate).

## Recommendation context resolution

`resolvePackingRecommendationContext(cruise, preferences)`:

- `travellerType` — always `getDefaultTravellerType(cruise)` (booking-derived)
- `destination` — saved override if present, else `getDefaultPackingDestination(cruise)` (null when unrecognised; never silently Mediterranean)
- `dressCode` — saved override if present, else `getDefaultDressCode(cruise)`
- `climate` — from effective destination, or empty when destination unknown
- `cruiseLine` — from cruise record

Cruise-level prefs save via `savePackingRecommendationPreferences`. Traveller baggage saves via `savePackingBaggageAllowances` only.

## Admin

Admin Packing edits and saves the five direct rule fields on `packing_items`. The retired Smart Profiles Admin tab, CRUD UI, and writes to `packing_item_profiles` have been removed from application code.

## Database rollback note

The four legacy tables remain in Supabase for safe code rollback:

- `smart_profile_groups`
- `smart_profiles`
- `smart_profile_members`
- `packing_item_profiles`

Do not drop them in this change. Future table retirement is a separate migration.

## Active customer packing profile tables (unchanged)

Do not confuse with Smart Profiles:

- `user_packing_v2_profiles` — traveller + Cabin tabs per cruise
- `user_packing_v2_state` — quantities, packed flags, packing locations per `profile_key`

Runtime symbols: `packingV2Profiles`, `activePackingProfileKey`.

Preference tables remain for rollback compatibility (`user_packing_preferences` / `customer_packing_preferences`). Do not delete columns or rows in this change. Unknown destinations must never silently default to Mediterranean.
