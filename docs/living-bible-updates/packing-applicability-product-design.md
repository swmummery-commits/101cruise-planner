# Living Bible Update — Product Design: Packing applicability

**Status:** Active architecture (legacy Smart Profiles retired from Admin)  
**Date:** 2026-08-05  
**Note:** Master Living Edition Product Design Bible was not found on this machine. Paste this section into the current Product Design Living Edition.

---

## Packing item applicability

Packing applicability is controlled **directly on each packing item** in Admin Packing:

- Applies to destinations → `destination_tags`
- Applies to climates → `climate_tags`
- Applies to traveller types → `traveller_types`
- Applies to dress codes → `dress_codes`
- Applies to cruise lines → `cruise_line_tags`

Empty rule fields mean the item applies broadly for that dimension. Essential items are included on every cruise.

## Smart Profiles (retired)

Admin **Smart Profiles** (profile groups, reusable climate/traveller/dress/destination profiles, and packing-item ↔ profile mappings) are **retired**. They must not be described as an active product system. Packing lists are not filtered through those legacy mappings.

## Per-traveller and Cabin packing lists (active, separate)

Customer Packing Assistant still uses per-traveller and Cabin packing lists:

- Individual traveller tabs
- Shared Cabin tab
- Per-traveller baggage allowances
- Separate packing progress, quantities, packing locations, and packed states

This customer profile system (`user_packing_v2_profiles` / `user_packing_v2_state`) is **not** the retired Smart Profiles feature and must not be renamed or conflated with it.
