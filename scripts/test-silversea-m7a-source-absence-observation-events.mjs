#!/usr/bin/env node
/**
 * Silversea M7A append-only observation event history tests.
 * Offline migration/forensic tests + optional live schema verify when DATABASE_URL set.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const eventsLib = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation-events"));
const forensic = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation-forensic"));
const obs = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));
const { hashFixtureContent } = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));

const M7A_MIG = fs.readFileSync(
  path.join(root, "supabase/migrations/20260824_cruise_source_observation_events.sql"),
  "utf8"
);
const M4_MIG = fs.readFileSync(
  path.join(root, "supabase/migrations/20260823_cruise_source_observation_state.sql"),
  "utf8"
);
const M7B_FIX = JSON.parse(
  fs.readFileSync(
    path.join(root, "scripts/fixtures/silversea/m7b-m4b-historical-event-backfill-SN280222C25.json"),
    "utf8"
  )
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed += 1;
  }
}

const SN_STATE = {
  id: "c5abc742-fe7e-4846-94d2-973813de2478",
  cruise_line_id: "3fd46f63-8291-4090-8edf-8d1c79bf2846",
  official_sailing_id: "SN280222C25",
  observation_type: "SOURCE_ABSENT",
  status: "OBSERVING",
  consecutive_healthy_absence_count: 1,
  last_observation_period_key: "2026-W34",
  last_counted_snapshot_hash: "9550e5128173d201211609428dae83790482c055037a7853a493090d444d39df"
};

function advanceEvent({ previous_count, new_count, period, hash, at = "2026-08-23T08:14:47.923Z" }) {
  return {
    id: `evt-${previous_count}-${new_count}`,
    state_id: SN_STATE.id,
    cruise_line_id: SN_STATE.cruise_line_id,
    official_sailing_id: SN_STATE.official_sailing_id,
    observation_type: "SOURCE_ABSENT",
    event_type: eventsLib.EVENT_TYPE_ABSENCE_ADVANCED,
    record_origin: eventsLib.RECORD_ORIGIN_LIVE,
    observed_at: at,
    observation_period_key: period,
    source_snapshot_hash: hash,
    source_health: "healthy",
    source_present: false,
    previous_count,
    new_count
  };
}

test("1 event table schema in migration", () => {
  if (!/CREATE TABLE IF NOT EXISTS public\.cruise_source_observation_events/.test(M7A_MIG)) throw new Error("table");
});

test("2 state FK ON DELETE RESTRICT", () => {
  if (!/REFERENCES public\.cruise_source_observation_state\(id\) ON DELETE RESTRICT/.test(M7A_MIG)) throw new Error("fk");
});

test("3 append-only trigger", () => {
  if (!/cruise_source_observation_events_immutable/.test(M7A_MIG)) throw new Error("trigger");
  if (!/BEFORE UPDATE OR DELETE/.test(M7A_MIG)) throw new Error("trigger op");
});

test("4 RLS enabled", () => {
  if (!/ENABLE ROW LEVEL SECURITY/.test(M7A_MIG)) throw new Error("rls");
  if (!/Admins can read cruise source observation events/.test(M7A_MIG)) throw new Error("policy");
});

test("5 unique weekly advance index", () => {
  if (!/cruise_source_observation_events_unique_week_advance_idx/.test(M7A_MIG)) throw new Error("week idx");
});

test("6 unique snapshot advance index", () => {
  if (!/cruise_source_observation_events_unique_snapshot_advance_idx/.test(M7A_MIG)) throw new Error("snap idx");
});

test("7 advance event constraints", () => {
  if (!/cruise_source_observation_events_absence_advanced_check/.test(M7A_MIG)) throw new Error("adv check");
});

test("8 invalid count transition rejected in SQL", () => {
  if (!/new_count = previous_count \+ 1/.test(M7A_MIG)) throw new Error("transition");
});

test("9 unhealthy advance blocked in RPC", () => {
  if (!/unhealthy_source/.test(M7A_MIG)) throw new Error("unhealthy");
});

test("10 identity copied from state in RPC insert", () => {
  if (!/v_row\.official_sailing_id/.test(M7A_MIG)) throw new Error("identity");
});

test("11 M4 migration file separate from M7A", () => {
  if (/DROP TABLE public\.cruise_source_observation_state/.test(M7A_MIG)) throw new Error("drop state");
  if (M4_MIG.includes("cruise_source_observation_events")) throw new Error("m4 should not create events");
});

test("12 advance RPC inserts event on initial state", () => {
  if (!/ON CONFLICT ON CONSTRAINT cruise_source_observation_state_unique_identity DO NOTHING/.test(M7A_MIG)) {
    throw new Error("race");
  }
  if (!/'ABSENCE_ADVANCED'/.test(M7A_MIG)) throw new Error("event type");
});

test("13 same snapshot returns advanced false without event path", () => {
  if (!/snapshot_already_counted/.test(M7A_MIG)) throw new Error("snapshot noop");
});

test("14 same period returns advanced false", () => {
  if (!/observation_period_already_counted/.test(M7A_MIG)) throw new Error("period noop");
});

test("15 resolve RPC idempotent already_resolved", () => {
  if (!/already_resolved/.test(M7A_MIG)) throw new Error("resolve noop");
});

test("16 resolve inserts SOURCE_RETURN_RESOLVED event", () => {
  if (!/'SOURCE_RETURN_RESOLVED'/.test(M7A_MIG)) throw new Error("resolve event");
});

test("17 record_origin LIVE and HISTORICAL_BACKFILL", () => {
  if (!/HISTORICAL_BACKFILL/.test(M7A_MIG)) throw new Error("origin");
});

test("18 REVOKE public mutation on events", () => {
  if (!/REVOKE INSERT, UPDATE, DELETE ON public\.cruise_source_observation_events/.test(M7A_MIG)) throw new Error("revoke");
});

test("19 count1 no events => missing", () => {
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [] });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_MISSING_EVENTS) throw new Error(r.result);
});

test("20 count1 + correct event => complete", () => {
  const ev = advanceEvent({
    previous_count: 0,
    new_count: 1,
    period: "2026-W34",
    hash: SN_STATE.last_counted_snapshot_hash
  });
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [ev] });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE) throw new Error(JSON.stringify(r));
});

test("21 count2 chain complete", () => {
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 2 };
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    advanceEvent({ previous_count: 1, new_count: 2, period: "2026-W35", hash: "h2", at: "2026-08-30T08:00:00Z" })
  ];
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE) throw new Error(r.result);
});

test("22 count3 three weeks complete", () => {
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 3 };
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    advanceEvent({ previous_count: 1, new_count: 2, period: "2026-W35", hash: "h2", at: "2026-08-30T08:00:00Z" }),
    advanceEvent({ previous_count: 2, new_count: 3, period: "2026-W36", hash: "h3", at: "2026-09-06T08:00:00Z" })
  ];
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events });
  if (!r.three_week_forensic_ready) throw new Error("not ready");
  if (r.quarantine_action_ready !== false) throw new Error("must stay blocked in M7A");
});

test("23 count3 missing week2 event fails", () => {
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 3 };
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    advanceEvent({ previous_count: 2, new_count: 3, period: "2026-W36", hash: "h3", at: "2026-09-06T08:00:00Z" })
  ];
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events });
  if (r.pass) throw new Error("should fail");
});

test("24 duplicate period fails", () => {
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    advanceEvent({ previous_count: 1, new_count: 2, period: "2026-W34", hash: "h2", at: "2026-08-24T08:00:00Z" })
  ];
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 2 };
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_DUPLICATE_PERIOD) throw new Error(r.result);
});

test("25 duplicate snapshot fails", () => {
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "same" }),
    advanceEvent({ previous_count: 1, new_count: 2, period: "2026-W35", hash: "same", at: "2026-08-30T08:00:00Z" })
  ];
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 2 };
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_DUPLICATE_SNAPSHOT) throw new Error(r.result);
});

test("26 broken transition fails", () => {
  const ev = advanceEvent({ previous_count: 0, new_count: 2, period: "2026-W34", hash: "h1" });
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [ev] });
  if (r.pass) throw new Error("broken");
});

test("27 unhealthy event fails", () => {
  const ev = advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" });
  ev.source_health = "FAIL";
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [ev] });
  if (r.pass) throw new Error("unhealthy");
});

test("28 resolution resets chain", () => {
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    {
      ...advanceEvent({ previous_count: 1, new_count: 0, period: "2026-W35", hash: "h2" }),
      event_type: eventsLib.EVENT_TYPE_SOURCE_RETURN_RESOLVED,
      source_present: true,
      new_count: 0,
      previous_count: 1,
      observed_at: "2026-08-30T08:00:00Z"
    }
  ];
  const resolved = { ...SN_STATE, status: "RESOLVED", consecutive_healthy_absence_count: 0 };
  const r = forensic.evaluateObservationForensicChain({ stateRow: resolved, events });
  if (r.qualifying_advance_events !== 0) throw new Error("chain not reset");
});

test("29 post-resolution new cycle", () => {
  const events = [
    {
      event_type: eventsLib.EVENT_TYPE_SOURCE_RETURN_RESOLVED,
      observed_at: "2026-08-01T08:00:00Z",
      previous_count: 2,
      new_count: 0,
      state_id: SN_STATE.id,
      cruise_line_id: SN_STATE.cruise_line_id,
      official_sailing_id: SN_STATE.official_sailing_id,
      source_present: true
    },
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h-new", at: "2026-08-23T08:00:00Z" })
  ];
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE) throw new Error(r.result);
});

test("30 identity mismatch fails", () => {
  const ev = advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" });
  ev.official_sailing_id = "OTHER";
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [ev] });
  if (r.pass) throw new Error("identity");
});

test("31 aggregate vs derived mismatch", () => {
  const ev = advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" });
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 2 };
  const r = forensic.evaluateObservationForensicChain({ stateRow: state, events: [ev] });
  if (r.pass || r.derived_count === 2) throw new Error(JSON.stringify(r));
});

test("32 quarantine never actionable in M7A assessQuarantineReadiness", () => {
  const state = { ...SN_STATE, consecutive_healthy_absence_count: 3 };
  const events = [
    advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" }),
    advanceEvent({ previous_count: 1, new_count: 2, period: "2026-W35", hash: "h2", at: "2026-08-30T08:00:00Z" }),
    advanceEvent({ previous_count: 2, new_count: 3, period: "2026-W36", hash: "h3", at: "2026-09-06T08:00:00Z" })
  ];
  const r = forensic.assessQuarantineReadiness({
    stateRow: state,
    events,
    sourceHealthy: true,
    sourceStillAbsent: true
  });
  if (r.quarantine_hide_execution_authorised !== false) throw new Error("authorised");
});

test("33 M7B fixture one historical event 0->1 W34", () => {
  const p = M7B_FIX.proposed_event;
  if (p.event_type !== "ABSENCE_ADVANCED") throw new Error("type");
  if (p.record_origin !== "HISTORICAL_BACKFILL") throw new Error("origin");
  if (p.previous_count !== 0 || p.new_count !== 1) throw new Error("counts");
  if (p.observation_period_key !== "2026-W34") throw new Error("period");
});

test("34 M7B fixture would complete forensic chain", () => {
  const p = M7B_FIX.proposed_event;
  const ev = {
    state_id: M7B_FIX.state_id,
    cruise_line_id: M7B_FIX.cruise_line_id,
    official_sailing_id: M7B_FIX.official_sailing_id,
    event_type: p.event_type,
    observed_at: p.observed_at,
    observation_period_key: p.observation_period_key,
    source_snapshot_hash: p.source_snapshot_hash,
    source_health: p.source_health,
    source_present: p.source_present,
    previous_count: p.previous_count,
    new_count: p.new_count
  };
  const r = forensic.evaluateObservationForensicChain({ stateRow: SN_STATE, events: [ev] });
  if (r.result !== forensic.FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE) throw new Error(JSON.stringify(r));
});

test("35 synthetic M5 weeks never in fixtures", () => {
  const blob = JSON.stringify(M7B_FIX);
  if (blob.includes("2026-W35") || blob.includes("2026-W36")) throw new Error("synthetic weeks");
});

test("36 M4B backfill defensible from evidence", () => {
  if (!M7B_FIX.defensibility_sources?.length) throw new Error("sources");
  if (M7B_FIX.proposed_event.run_id !== "silversea-m4-source-absence-SN280222C25-2026-08-23T08-13-17-474Z") {
    throw new Error("run id");
  }
});

test("37 event/state reconciliation helper", () => {
  const rec = eventsLib.buildEventStateReconciliation({
    stateRow: SN_STATE,
    events: [advanceEvent({ previous_count: 0, new_count: 1, period: "2026-W34", hash: "h1" })]
  });
  if (!rec.count_matches_events) throw new Error(JSON.stringify(rec));
});

test("38 M6 lib exports forensic categories", () => {
  const m6 = require(path.join(root, "netlify/functions/lib/silversea-m6-weekly-maintenance-orchestration"));
  if (!m6.FORENSIC_RESULT) throw new Error("missing");
});

test("39 apply script targets only M7A migration", () => {
  const src = fs.readFileSync(path.join(root, "scripts/apply-cruise-source-observation-events-migration.mjs"), "utf8");
  if (!src.includes("20260824_cruise_source_observation_events.sql")) throw new Error("path");
  if (/supabase db push|supabase migration repair|db reset/.test(src)) throw new Error("forbidden cli");
});

test("40 resolve allows multi-cycle (no global one-resolve unique in migration)", () => {
  if (/UNIQUE.*SOURCE_RETURN_RESOLVED.*state_id/i.test(M7A_MIG)) throw new Error("global resolve unique");
});

console.log(`\nM7A tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
