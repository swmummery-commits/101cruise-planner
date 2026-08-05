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
