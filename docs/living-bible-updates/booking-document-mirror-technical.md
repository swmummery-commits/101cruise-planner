# Base44 booking document mirror — technical notes

Paste into the Living Edition Technical Bible under **My Cruise → Documents**.

## Authoritative sources

- **Base44** remains the authoritative source for agency-uploaded booking documents (`documents[]` on the CruiseBooking payload).
- **`booking_documents`** is the local mirror table for Base44 (and admin-origin) CRM documents.
- **`customer_documents`** stores documents uploaded directly by customers in My Cruise.
- Base44 documents are **never** copied into `customer_documents`.

## Storage and privacy

| Bucket | Purpose | Access |
|--------|---------|--------|
| `booking-documents` | Mirrored CRM documents + admin uploads | Private; short-lived signed URLs via Netlify functions |
| `customer-documents` | Customer self-uploads | Private; short-lived signed URLs via Netlify functions |

Customers never receive Base44 URLs, permanent Storage paths, or service credentials.

## Synchronisation

Shared module: `netlify/functions/lib/booking-document-sync.js`

**Triggers**

1. Customer access / refresh / switch-booking / claim-invitation (after successful Base44 fetch)
2. Admin `get-booking`
3. Daily scheduled function `reconcile-booking-documents` (04:00 UTC, batch 20)
4. Manual backfill: invoke reconcile with `{ "cursor": N, "batch_size": 20 }` or `scripts/sync-base44-documents.mjs`

**Algorithm (per booking, complete fetch only)**

1. Map every valid Base44 `documents[]` entry (filename + file_url required).
2. Compute stable identity: `source_fingerprint` (Base44 id, else deterministic hash).
3. Deduplicate via unique `sync_key` / `(base44_booking_id, source_fingerprint)`.
4. Download new/changed files server-side → `booking-documents/{base44_booking_id}/{source_fingerprint}/{filename}`.
5. Upsert metadata; skip redownload when `content_hash` + URL hash unchanged.
6. After a **complete** successful document list, soft-archive rows missing from Base44 (`is_active=false`, `source_deleted_at`).
7. Individual document failures are logged; customer login is not blocked.

## Booking Confirmation itinerary rule

- **Only** documents whose normalised type is Booking Confirmation invoke `processTextItinerary`.
- Travel Insurance, visas, tickets, and other types never trigger extraction.
- Unchanged confirmation fingerprints are not reprocessed.

## Customer portal

- Unified library via `customer-documents` action `list_all` (CRM + customer sources).
- Source badges: **From 101cruise** (CRM) / **Uploaded by you** (customer).
- CRM documents are not deletable by customers.
- Download/open/print use authenticated `get_download_url` (fresh signed URL per action).

## Reconciliation / backfill

```
POST /.netlify/functions/reconcile-booking-documents
{ "cursor": 0, "batch_size": 20, "dry_run": false }
```

Repeat with `next_cursor` until `has_more` is false. Idempotent.

## Soft deletion

Removed Base44 documents are archived in metadata only; Storage objects are retained for audit unless a separate retention job is introduced later.
