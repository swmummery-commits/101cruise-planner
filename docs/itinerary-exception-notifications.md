# Itinerary exception notifications

**Status:** Production — Original-project migration applied  
**Migration:** `supabase/migrations/20260726_itinerary_exceptions_notifications.sql`  
**Applied to Original:** yes (2026-07-26)

## Admin identity

| Use | Column |
|-----|--------|
| Authentication / RLS (`auth.uid()`) | `admin_users.auth_user_id` |
| Assignment (`assigned_admin_user_id`) | `admin_users.id` |
| Active flag | `admin_users.active` |
| Email / queue recipients | `admin_users.notify_itinerary_exceptions = true` |

No hardcoded Steve/Paul emails in application source. Reviewers are selected via
existing `admin_users` rows and optional assignment to `admin_users.id`.

## In-app Needs Attention queue

- Location: **Customer Experience → Booking Documents**
- Nav badge: unresolved count beside Booking Documents
- Persists until approved, superseded, or dismissed with a recorded reason
- Viewing / opening a booking **does not** clear the item
- **Requires no paid service** — works with email fully disabled

## Email capability (optional)

| Capability in repo today | Result |
|--------------------------|--------|
| Transactional email SDK (Resend / SendGrid / Postmark / SMTP) | Optional Resend only |
| Mailchimp integration | Newsletter HTML **export only** — not an API mailer |
| Netlify Forms / Identity mail | Not used for Admin alerts |

Email remains **optional and disabled** unless Resend is configured. Leaving
`RESEND_API_KEY` unset keeps the Admin queue as the only alert surface.

### Optional provider (not required for queue)

| Item | Detail |
|------|--------|
| Setup fee | **$0** |
| Free tier | **$0/mo** — 3,000 emails/month, **100/day** hard cap |
| Paid Pro | from **~$20/mo** (50k emails) — only if free tier is exceeded |
| Per-email on free | **$0** within free limits |
| Ongoing cost if unused | **$0** (leave `RESEND_API_KEY` unset) |

**Recommendation:** keep the Admin queue as the primary alert surface. Enable Resend only when inbox alerts are wanted; free tier is enough for exception volume.

### Configuration (no personal emails in source)

1. Migration `20260726_itinerary_exceptions_notifications.sql` applied on Original
2. In Supabase, set `admin_users.notify_itinerary_exceptions = true` for reviewers (by their existing admin rows)
3. Optional email:
   - `RESEND_API_KEY`
   - `ITINERARY_ALERT_FROM_EMAIL` (verified Resend from-address)

## Deduplication

- One immediate email when an exception is first created
- Unchanged retries → no email
- Materially changed reason fingerprint → new immediate email
- Daily digest (`itinerary-exceptions-digest`, 07:00 UTC) of open items only
- Resolved / dismissed / superseded stop appearing in digests

## Failsafe

Email skip/failure is recorded on the exception and in `itinerary_exception_notifications`. The Needs Attention queue and badge always remain available for manual review.
