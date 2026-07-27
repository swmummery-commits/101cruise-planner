# Client Portal experience upgrade

## Maps remain retired

Geographic itinerary maps, port geocoding, canonical port matching, itinerary approval queues, exception notifications, and Resend itinerary emails remain retired.

## Text-only cruise itinerary

Customers receive a lightweight text itinerary extracted from the Booking Confirmation:

- Stored in `booking_text_itineraries`
- Fields: day, date, port wording from the confirmation, optional arrival/departure times, overnight and embark/disembark flags
- No coordinates, no port catalogue matching, no Admin approval
- OpenAI may run once when a Booking Confirmation is newly synced or its fingerprint changes
- Never on dashboard/document refresh when a valid ready itinerary already matches the fingerprint
- Failures show a calm fallback and keep the Open Documents CTA

## Shared loading feedback

`js/portal-loading.js` provides one portal-wide overlay (accent `#8DD9BF`) with delayed show (~250 ms), reference counting, button busy state, slow/fail copy, and `aria-live` / reduced-motion support.

## Ship gallery

`Explore your ship` uses existing Supabase Media Library ship assets for the resolved canonical ship. Logos and the current hero duplicate are excluded. The section hides when fewer than two additional images exist.

## Page-level scrolling

My Cruise modules expand to natural height. Nested vertical scrollers inside dashboard cards/lists are removed. The footer follows content. The Squarespace iframe continues to resize via `101cruise-my-cruise-height`.

## Countdown lifecycle

Date-only calendar semantics (`js/cruise-date-state.js`):

- Before embarkation: live countdown
- Embarkation day: “TODAY IS SAIL DAY / BON VOYAGE!”
- During cruise: “HOPE YOU ARE ENJOYING YOUR CRUISE”
- Disembarkation day onward: panel hidden
- Missing `arriving_date` with valid duration derives a display return date (not written back to Base44)

## Full-bleed hero

The dashboard hero is the approved full-bleed exception to the centred max-width content rule. Content beneath remains in the centred container. If the Squarespace host section is narrower than the page, widen that section to full browser width in Squarespace.
