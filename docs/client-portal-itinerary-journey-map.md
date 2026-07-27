# Client Portal — Journey map (retired)

**Status:** Retired — 2026-07-26  
**Decision:** Automatic Booking Confirmation itinerary extraction and the Client Portal
animated journey map are no longer operated.

## Why it was retired

The journey map was successfully prototyped: approved `cruise_itineraries` rows drove a
geographic route with land underlay, port sequence, and ship animation.

Reliable port resolution for every booking created excessive ongoing administration
(catalogue gaps, aliases, exception review, stalled processing). That operational
burden outweighed the customer value for 101cruise’s current workflow.

## What customers see now

**Your Journey** on the My Cruise dashboard shows:

- embarkation port → disembarkation port
- embarkation / disembarkation dates
- cruise duration
- a **text-only** day-by-day itinerary when extraction has succeeded
- calm Booking Confirmation fallback when extraction is unavailable
- **Open Documents →** (scrolls Documents to the top)

No geographic map, no geocoding, no Admin approval queue, and no
`customer-itinerary` map endpoint on page load. Text itinerary reads use
`customer-text-itinerary` only. See `docs/client-portal-experience-upgrade.md`.

## Source of truth

The **Booking Confirmation** PDF remains the detailed day-by-day itinerary.

## Historical data

Tables and approved rows (including booking **10175811**) are retained inactive for
audit history. They are not shown in the Client Portal and are not updated by sync.

Migrations remain in the repo so the feature can be reconsidered later without
losing history.

## Operating cost

- Itinerary OpenAI extraction: **0**
- Itinerary notification email: **0**
- Mapping API charges: **0** (bundled Natural Earth assets unused by the active dashboard)
- Manual itinerary approvals: **0**

See also `docs/itinerary-auto-processing.md` and `docs/itinerary-exception-notifications.md`.
