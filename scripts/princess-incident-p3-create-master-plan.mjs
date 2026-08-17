#!/usr/bin/env node
/**
 * Create finite Princess Incident P3 master remediation plan + batch freezes.
 * Read-only until --write flag.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const p3 = require(path.join(root, "scripts/lib/princess-incident-p3-lib.cjs"));
const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MASTER_PATH = path.join(root, "reports/princess-incident-p3-master-plan.json");
const P2_FREEZE_PATH = path.join(root, "reports/princess-incident-p2-batch-1-freeze.json");

async function main() {
  const write = process.argv.includes("--write");
  const rest = createSupabaseRest(root);
  const sb = async (q) => rest.get(q);

  console.error("Simulation run 1…");
  const ctx1 = await p3.runPrincessSimulation(root);
  ctx1.root = root;
  console.error("Simulation run 2…");
  const ctx2 = await p3.runPrincessSimulation(root);
  ctx2.root = root;

  const productionRows = await p3.loadAllPrincessRows(sb);
  const productionKeys = new Set(productionRows.map((r) => r.official_sailing_id).filter(Boolean));
  const s1 = p3.summariseSimulation({ ...ctx1, root }, productionKeys);
  const s2 = p3.summariseSimulation({ ...ctx2, root }, productionKeys);

  if (!s1.disjoint.accounting_exact || !s2.disjoint.accounting_exact) {
    console.error(JSON.stringify({ error: "accounting_not_exact", s1: s1.disjoint, s2: s2.disjoint }, null, 2));
    process.exit(2);
  }
  if (s1.eligibleHash !== s2.eligibleHash) {
    console.error(JSON.stringify({ error: "source_not_reproducible" }, null, 2));
    process.exit(2);
  }

  const { frozen, summary } = await p3.buildMasterPlanCandidates({ ...ctx1, root }, productionKeys);
  const keyValidation = p3.validateFrozenBatchCandidates(frozen);
  if (!keyValidation.ok) {
    console.error(JSON.stringify({ error: "invalid_frozen_keys", issues: keyValidation.issues }, null, 2));
    process.exit(2);
  }

  const masterHash = p3.hashPrincessFrozenBatch(frozen);
  const batches = p3.partitionIntoBatches(frozen);

  const activeExact = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${p3.PRINCESS_LINE_ID}&status=eq.active`
  );

  const masterPlan = {
    generated_at: new Date().toISOString(),
    repository_sha: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
    immutable: true,
    source_snapshot: {
      raw_groups: s1.rawGroups,
      expanded_dated_sailings: s1.disjoint.expanded_dated_sailings,
      within_public_cutoff: s1.disjoint.within_public_cutoff,
      public_eligible_complete: s1.disjoint.public_eligible_complete,
      public_incomplete: s1.disjoint.public_incomplete,
      eligible_hash: s1.eligibleHash,
      accounting_exact: true
    },
    production_baseline: {
      active: activeExact.count,
      outstanding_planned_inserts: frozen.length
    },
    master_plan_hash: masterHash,
    master_identity_count: frozen.length,
    batch_count: batches.length,
    batch_sizes: batches.map((b) => b.length),
    identities: frozen.map((c) => c.official_sailing_id),
    candidates: frozen
  };

  if (write) {
    fs.writeFileSync(MASTER_PATH, JSON.stringify(masterPlan, null, 2));
    for (let i = 0; i < batches.length; i++) {
      const batchNum = String(i + 1).padStart(2, "0");
      const batchCandidates = batches[i];
      const batchHash = p3.hashPrincessFrozenBatch(batchCandidates);
      const freezeDoc = {
        master_plan_hash: masterHash,
        batch_number: i + 1,
        batch_label: `P3-${batchNum}`,
        batch_size: batchCandidates.length,
        batch_hash: batchHash,
        max_writes: p3.P3_BATCH_MAX_WRITES,
        candidates: batchCandidates
      };
      fs.writeFileSync(
        path.join(root, `reports/princess-incident-p3-batch-${batchNum}-freeze.json`),
        JSON.stringify(freezeDoc, null, 2)
      );
    }
  }

  const report = {
    master_plan_path: write ? MASTER_PATH : null,
    outstanding: frozen.length,
    master_plan_hash: masterHash,
    batch_count: batches.length,
    batch_sizes: batches.map((b) => b.length),
    external_key_coverage_pct: 100,
    identity_key_coverage_pct: 100,
    source_reproducibility: s1.eligibleHash === s2.eligibleHash,
    accounting_exact: s1.disjoint.accounting_exact
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
