# Smart Profiles retirement — read-only production data audit

**Date:** 2026-08-05  
**Action:** Inspect only. No database rows or tables were deleted or modified.

## Record counts

| Table | Count |
| --- | ---: |
| `smart_profile_groups` | 5 |
| `smart_profiles` | 28 |
| `smart_profile_members` | 18 |
| `packing_item_profiles` | 176 |

Distinct packing items linked through `packing_item_profiles`: **56**.

Mapping rows by profile type: climate 73, destination 53, traveller 20, cruise_type 24, dress 6.

## Runtime note

Customer Packing Assistant filters only via direct `packing_items` fields. Legacy Smart Profile mappings are **not** applied at runtime today. Retiring the Admin UI therefore does not change currently generated packing lists.

## Intended Smart Profile restrictions absent from direct fields

Comparing each linked item’s Smart Profile **names** with the matching direct field:

- **43** items have at least one Smart Profile name absent from the corresponding direct field.
- **36** of those have all five direct rule fields empty (so they currently apply broadly in the planner).
- Most empty-field links are a single `climate:Tropical` mapping on everyday items (documents, toiletries, medication, chargers, etc.).
- Notable broader mappings with empty directs: `Portable battery pack / power bank` (many climate/traveller/destination/cruise_type profiles), `Track Pants and Sweater` (`climate:Polar`).
- Partial mismatches where some directs exist but Smart Profile names are broader or unmapped: e.g. Tank tops (destination profiles not in `destination_tags`), Day shorts / Light jacket / Swimwear / Loafers (traveller/dress/cruise_type profiles; cruise_type has no direct field), Dress shorts (missing Temperate), Water shoes (Mediterranean destination profile).

These intended restrictions were **not** migrated into direct fields in this change, because live customer behaviour (empty = broad apply) is the source of truth. Legacy tables remain for rollback and any future curated migration.
