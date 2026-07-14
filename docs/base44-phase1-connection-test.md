# Base44 Phase 2 — The Ship page

The customer Ship page loads live `CruiseShip` data from the **101Cruise Finder** Base44 app.

## Endpoint

```
GET /.netlify/functions/get-ship?name=<ship name>&cruise_line=<cruise line>
```

Example:

```
curl -s "https://<your-netlify-site>/.netlify/functions/get-ship?name=Millennium&cruise_line=Celebrity"
```

## Required Netlify environment variables

| Variable | Scope |
|---|---|
| `BASE44_FINDER_APP_ID` | Server / Functions only |
| `BASE44_FINDER_API_KEY` | Server / Functions only |

CRM booking variables are separate and must not be used here.

## Lookup behaviour

1. The Ship page sends booking `cruise_ship` as `name` and `cruise_line` as `cruise_line`.
2. Matching is case-insensitive and whitespace-normalised, in order:
   - exact ship-name match
   - exact composed match: `cruise_line + " " + ship name`
   - unique line-aware suffix match
3. More than one candidate at any step → `SHIP_AMBIGUOUS` (HTTP 409).
4. No safe match → `SHIP_NOT_FOUND` (HTTP 404).
5. Never returns another ship as a fallback.

## Notes

- Read-only: no Base44 writes, no Supabase writes.
- `/.netlify/functions/base44-test` is disabled (HTTP 410). Use `get-ship` instead.
