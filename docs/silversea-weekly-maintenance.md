# Silversea weekly maintenance

Silversea production inventory is maintained weekly against the official catalogue using the M1–M6 orchestration engine.

## Supported actions (bounded per run)

| Action | Ceiling | Semantics |
|--------|---------|-----------|
| INSERT | 1 | M2-proven classic insert eligibility |
| UPDATE | 1 | M3-proven deterministic field updates |
| Observation advance/insert | 1 | Atomic RPC + `ABSENCE_ADVANCED` event |
| Source-return resolve | 1 | Atomic RPC + `SOURCE_RETURN_RESOLVED` event |
| Quarantine/hide | 0 | Review alert only at count ≥3 with forensic chain |
| Delete | 0 | Not authorised |

## Source absence policy

- Healthy weekly absence counts toward threshold N=3
- Counts 1–2: observe only
- Count ≥3 with complete forensic chain: `QUARANTINE_REVIEW_REQUIRED` alert (no automatic hide)
- Append-only events in `cruise_source_observation_events` provide forensic evidence
- 21-day cutoff lifecycle remains separate from source absence

## Schedule

Netlify cron: `silversea-weekly-maintenance-cron` — Monday 04:00 UTC (Monday 12:00 Perth)

Background worker: `silversea-weekly-maintenance-background`

## Manual invocation

```bash
# Dry-run plan only
npm run silversea:weekly-maintenance:plan

# Bounded apply (requires confirmation token)
npm run silversea:weekly-maintenance:apply
```

Scheduled/manual HTTP calls require `DISCOVERY_CRON_SECRET` via `x-discovery-cron-secret`.

## Safety controls

- Source health hard-stop
- Official ID identity reconciliation
- Global cruise write lock for INSERT/UPDATE
- Weekly line lock prevents overlapping runs
- UPDATE_UNSAFE never executed
- Grand/World/special new products deferred
- Fail-closed on forensic chain mismatch after observation mutations

## Troubleshooting

- Reports: `reports/silversea-weekly-maintenance-*.json` (not committed)
- Observation state: `cruise_source_observation_state`
- Forensic events: `cruise_source_observation_events`
- If PostgREST schema cache stale after DDL, retry after cache refresh
