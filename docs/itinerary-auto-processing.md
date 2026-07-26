# Itinerary auto-processing (retired)

**Status:** Retired — 2026-07-26  
**Migrations retained:** `20260726_itinerary_auto_processing.sql` (schema kept for history)

## Decision

101cruise no longer automatically extracts itineraries from Booking Confirmations,
geocodes ports, or publishes animated journey maps. The Booking Confirmation remains
the source of truth for the detailed itinerary.

## Disabled paths

| Source | Behaviour after retirement |
|--------|----------------------------|
| Admin `get-booking` | Document sync only — no OpenAI, no `cruise_itineraries` writes |
| Admin `booking-documents` upload | Stores document only |
| Document sync | No `confirmation_candidates` enqueue for extraction |
| Customer `customer-access` | Metadata sync only (unchanged — never extracted) |
| Client Portal page load | No `customer-itinerary` call; simple journey summary only |
| `processBookingConfirmation` | Returns `itinerary_map_feature_retired` and writes nothing |
| Admin extract / retry / revalidate / approve | HTTP 410 from `admin-itinerary` |

## Historical data

Existing `cruise_itineraries` and `cruise_itinerary_versions` rows are left in place
(including approved booking **10175811**). They are inactive in the product UI.

## Cost

Itinerary OpenAI extraction calls: **0**. No itinerary email operating cost.
