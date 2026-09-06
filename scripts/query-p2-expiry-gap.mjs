#!/usr/bin/env node
/**
 * Inspect daily expiry ledger around the missing 2026-09-03 Perth slot.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional — supabase-rest.cjs loads .env */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const runs = await sb(
    "cruise_discovery_runs?scope=eq.full&select=id,status,stats,started_at,finished_at,error_message,created_at&order=started_at.desc&limit=80"
  );
  const expiry = (runs || []).filter((r) => r.stats?.run_type === "daily_expiry_maintenance");
  const compact = expiry.map((r) => ({
    id: r.id,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
    perth_started: r.started_at
      ? new Date(r.started_at).toLocaleString("en-AU", { timeZone: "Australia/Perth" })
      : null,
    expired_count: r.stats?.expired_count ?? null,
    trigger_type: r.stats?.trigger_type || null,
    already_dispatched: r.stats?.already_dispatched ?? null,
    dry_run: r.stats?.dry_run ?? null,
    error: r.error_message || r.stats?.failure_reason || null,
    deploy_id: r.stats?.deploy_id || r.stats?.invocation_provenance?.deploy_id || null,
    commit_ref: r.stats?.commit_ref || r.stats?.invocation_provenance?.commit_ref || null
  }));

  const leases = await sb(
    "cruise_discovery_schedule_leases?select=*&order=created_at.desc&limit=40"
  ).catch(() => []);
  const expiryLeases = (leases || []).filter((l) => String(l.lease_key || l.lock_key || "").includes("daily-expiry") || String(l.lease_key || "").includes("daily_expiry"));

  const expectedSlots = [];
  for (let d = 1; d <= 6; d += 1) {
    const perth = `2026-09-0${d}`;
    expectedSlots.push({
      perth_date: perth,
      utc_start: `${d === 1 ? "2026-08-31" : `2026-09-0${d - 1}`}T17:30:00.000Z`
    });
  }

  const classified = expectedSlots.map((slot) => {
    const match = compact.find((r) => {
      if (!r.started_at) return false;
      const t = Date.parse(r.started_at);
      const start = Date.parse(slot.utc_start) - 30 * 60 * 1000;
      const end = Date.parse(slot.utc_start) + 90 * 60 * 1000;
      return t >= start && t <= end;
    });
    return { ...slot, found: Boolean(match), run: match || null };
  });

  console.log(
    JSON.stringify(
      {
        expiry_runs: compact,
        expected_slots: classified,
        expiry_leases: expiryLeases
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
