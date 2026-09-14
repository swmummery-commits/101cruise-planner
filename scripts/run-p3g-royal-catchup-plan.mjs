#!/usr/bin/env node
/**
 * Freeze a Royal P3G catch-up master plan from the latest read-only weekly summary.
 * Does not write discovered_cruises.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { freezeRoyalCatchupMasterPlan } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-p3g-catchup-plan")
);

const inputPath = process.argv.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
if (!inputPath) {
  console.error("usage: node scripts/run-p3g-royal-catchup-plan.mjs --from=reports/<royal-preflight-or-weekly>.json");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const summary = raw.result || raw.summary || raw;
const manifest = raw.manifest || raw.weekly_manifest || {};
const proposedInserts =
  manifest.inserts ||
  (manifest.products || []).filter((row) => row.proposed_action === "insert_active") ||
  [];
const proposedUpdates =
  manifest.updates ||
  (manifest.products || []).filter((row) => row.proposed_action === "update_exact_legacy_match") ||
  [];

const plan = freezeRoyalCatchupMasterPlan({
  proposedInserts,
  proposedUpdates,
  productionRows: raw.production_rows || [],
  today: summary.perth_today || summary.as_of || null,
  sourceSnapshotId: summary.source_snapshot_id || raw.source_snapshot_id || null,
  unionCount: summary.union_sailing_identities || summary.union || null
});

const out = path.join(root, "reports", `royal-p3g-catchup-master-plan-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ plan_file: out, safe_backlog: plan.safe_backlog, batches: plan.batches.length, counts: plan.classification_counts, plan_hash: plan.plan_hash }, null, 2));
process.exit(0);
