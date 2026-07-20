# Sprint 10D — Research Content Engine setup

## One-time setup

1. Apply migration in Supabase SQL editor:

   `supabase/migrations/20260722_research_content.sql`

2. Netlify environment variables:

   - `BRAVE_SEARCH_API_KEY` — already used by Cruise Finder (confirm it is set)
   - **`OPENAI_API_KEY` — required for research generation. Not currently set on Netlify; add it before using Research Content.**
   - Optional: `OPENAI_RESEARCH_MODEL` (defaults to `gpt-4.1-mini`, or `OPENAI_ITINERARY_MODEL` if that is set)
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — existing

   Without `OPENAI_API_KEY`, Admin can still open the Research Content tab, but **Begin Research** / generation will return a clear 503 until the key is added. The same key is also what Admin itinerary extraction expects.

3. Deploy Netlify functions when ready.

4. In Admin → **Research Content**:
   - Choose entity (ship / cruise line from CI, or destination / port by name)
   - Confirm the provider note shows AI as configured
   - Review estimated API activity
   - Begin research → edit draft → Publish explicitly

## Cost notes

- Brave: a few web search queries per research run (max 4)
- OpenAI: typically 1 JSON generation request (+1 repair if needed)
- Public cruise pages **do not** call Brave or OpenAI

## Security

- All research APIs require Admin JWT via `requireAdmin`
- Public API returns only published teaser fields
- Sources, research notes, and diagnostics stay admin-side
