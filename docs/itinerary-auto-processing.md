# Itinerary auto-processing (exception-only)

**Status:** Production — Original-project migration applied  
**Validation version:** `1.0.0`  
**Migration:** `supabase/migrations/20260726_itinerary_auto_processing.sql`  
**Applied to Original:** yes (2026-07-26)

## Admin identity

| Use | Column |
|-----|--------|
| Authentication / RLS (`auth.uid()`) | `admin_users.auth_user_id` |
| Assignment relationships | `admin_users.id` |
| Active flag | `admin_users.active` |

## Automated system actor

`cruise_itineraries.approved_by` and `extracted_by` are **uuid** columns that store
human `auth.users` ids for manual work. Automation does **not** invent a fake
admin or auth user. Automated approvals set:

- `approval_method = 'automated'`
- `approved_by = NULL`
- `extracted_by = NULL` (unless a human actor uuid is supplied)

The text label `system:itinerary-auto-approve` is used only in free-text audit
fields (for example exception `resolved_by`), never forced into uuid columns.

## Trigger points

| Source | Triggers extraction? |
|--------|----------------------|
| Admin `get-booking` after Base44 document sync | **Yes** — new/changed Booking Confirmations |
| Admin `booking-documents` `complete_upload` (confirmation) | **Yes** |
| Customer `customer-access` login sync | **No** (metadata sync only) |
| Client Portal page load | **No** |
| Manual Extract in Booking Documents | **Yes** (recovery; still one-shot per hash) |
| Revalidate | Validation only — **no OpenAI** |

## Auto-approval rules (all must pass)

- Booking reference consistent (when present on extract)
- Cruise line resolves / matches booking after alias canonicalisation
- Ship resolves unambiguously in `ci_cruise_ships`
- Embarkation / disembarkation dates match booking
- Stops chronological and within cruise dates
- Embarkation + disembarkation stops present
- ≥ 2 unique geocoded ports
- Every non-sea-day port matches exactly one canonical port with coordinates
- No ambiguous port matches
- Overall confidence ≥ 0.90
- Embark/disembark stop confidence ≥ 0.90
- Ordinary port confidence ≥ 0.80

## Exception summaries

- `N unresolved ports`
- `ship match ambiguous`
- `dates conflict with booking`
- `extraction confidence below threshold`
- `confirmation changed after approval`

## Cost control

- Unchanged document fingerprint → skip OpenAI
- Store `extraction_call_count`, `extraction_model`, token usage, estimated USD
- Revalidate never increments extraction calls

## Safety

- DEV project URL hard-refused
- Concurrent processing lock on `booking_documents`
- Upsert + single-row return + re-read verification
- Replacement confirmations archive prior row to `cruise_itinerary_versions` before swapping approved data

## Needs Attention + alerts

See `docs/itinerary-exception-notifications.md`.

Exceptions open a persistent Admin queue item and optional email (Resend free tier
only if configured). Email failure never clears the queue. The in-app queue
requires no paid service.
