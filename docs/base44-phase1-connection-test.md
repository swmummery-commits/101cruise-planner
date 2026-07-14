# Base44 Phase 2 — The Ship page

The customer Ship page loads live `CruiseShip` data from the **101Cruise Finder** Base44 app.

## Endpoint

```
GET /.netlify/functions/get-ship?name=<ship name>
```

Example:

```
curl -s "https://<your-netlify-site>/.netlify/functions/get-ship?name=Adventure%20of%20the%20Seas"
```

## Required Netlify environment variables

| Variable | Scope |
|---|---|
| `BASE44_FINDER_APP_ID` | Server / Functions only |
| `BASE44_FINDER_API_KEY` | Server / Functions only |

CRM booking variables are separate and must not be used here.

## Lookup behaviour

1. The Ship page reads the booking ship name (`cruise_ship` / `ship_name`).
2. It calls `get-ship` with that name.
3. The function matches a `CruiseShip` with case-insensitive, whitespace-normalised exact equality.
4. If no exact match exists, it returns `SHIP_NOT_FOUND` — never another ship.

## Notes

- Read-only: no Base44 writes, no Supabase writes.
- `/.netlify/functions/base44-test` is disabled (HTTP 410). Use `get-ship` instead.
