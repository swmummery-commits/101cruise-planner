# Itinerary exception notifications (retired)

**Status:** Retired — 2026-07-26  
**Migration retained:** `20260726_itinerary_exceptions_notifications.sql`

## Decision

The Needs Attention queue, navigation badge, Steve/Paul assignment UI, Resend alerts,
and daily digest were removed from the active Admin product because journey-map
extraction was retired.

## Disabled behaviour

- `itinerary-exceptions` list/count/scan return empty / retired (no UI invocation)
- `itinerary-exceptions-digest` schedule removed from `netlify.toml`; handler is a no-op
- No Resend calls for itinerary exceptions
- Admin Booking Documents describes document management only

## Historical rows

Open or closed `itinerary_exceptions` / `itinerary_exception_notifications` rows may
remain in the database for audit. They are not shown or acted on by the active UI.

Stale processing for booking **4118719** was cleaned up at retirement with reason
“Itinerary map feature retired”. Other historical exceptions (if any) were reported
separately and not broadly bulk-closed.
