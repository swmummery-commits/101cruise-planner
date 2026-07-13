# Base44 Phase 1 — connection test

Read-only proof that the Netlify-hosted planner can retrieve one `CruiseShip` from Base44.

## Endpoint

```
GET /.netlify/functions/base44-test
```

Deployed example:

```
https://<your-netlify-site>/.netlify/functions/base44-test
```

## Required Netlify environment variables

Set these in the Netlify UI (Site settings → Environment variables), or locally without committing them:

| Variable | Scope |
|---|---|
| `BASE44_APP_ID` | Server / Functions only |
| `BASE44_API_KEY` | Server / Functions only |

Never put these in frontend JS, HTML, or committed files.

## Local testing (Netlify Dev)

1. From the repo root, ensure dependencies are installed:

   ```bash
   npm install
   ```

2. Create a local `.env` file (gitignored):

   ```bash
   BASE44_APP_ID=your_app_id
   BASE44_API_KEY=your_api_key
   ```

3. Start Netlify Dev (loads `.env` into function `process.env`):

   ```bash
   npx netlify dev
   ```

4. Call the function:

   ```bash
   curl -s http://localhost:8888/.netlify/functions/base44-test | jq .
   ```

Expected success shape:

```json
{
  "success": true,
  "ship_count_returned": 1,
  "ship": { "...genuine CruiseShip fields..." },
  "field_count": 12
}
```

## Security notes

- Credentials exist only in Netlify env / local `.env` (gitignored).
- Function is GET + read-only (`CruiseShip.list`); no Supabase writes.
- No permanent customer UI entry point in this phase.
