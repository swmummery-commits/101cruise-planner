#!/usr/bin/env node
/**
 * Princess Weekly Maintenance P1 — read-only forensic simulation.
 * NO production writes.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const OLD_SHA = "8f867a7f0d1879ed6df3dbddbecc363b8765c24e";

const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { headCountSupabase } = require(path.join(root, "netlify/functions/lib/celebrity-inventory-counts"));
const { perthCalendarDate, partitionByPublicBookingCutoff, PUBLIC_BOOKING_CUTOFF_DAYS } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));

function hashIds(ids) {
  return crypto.createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}

function summariseSimulation(sim, adapter, { today, productionKeys = new Set() } = {}) {
  const normalised = sim.products || [];
  const cruises = normalised.filter((n) => n.product_type === "cruise");
  const cruisetours = normalised.filter((n) => n.product_type === "cruisetour");
  const incomplete = cruises.filter((n) => !n.complete_high_confidence);
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    normalised,
    (p) => p.candidate?.departure_date,
    today
  );
  const eligible = publiclyEligible.filter(
    (p) => p.complete_high_confidence && adapter.isEligiblePrincessCruise(p.product_type)
  );
  const eligibleIds = eligible.map((p) => adapter.officialProductKey(p.raw)).filter(Boolean);
  const expandedIds = (sim.fetch_result?.products || sim.products?.map((p) => p.raw) || [])
    .map((r) => adapter.officialProductKey(r))
    .filter(Boolean);
  const failureCounts = {};
  for (const row of incomplete) {
    for (const reason of row.failure_reasons || []) {
      failureCounts[reason] = (failureCounts[reason] || 0) + 1;
    }
  }
  const insertCandidates = eligible.filter((p) => {
    const id = adapter.officialProductKey(p.raw);
    return id && !productionKeys.has(id);
  });
  return {
    official_source_total: sim.num_found_official ?? sim.raw_group_count ?? null,
    light_catalogue_groups: sim.fetch_result?.audit?.light_catalogue_groups ?? null,
    full_catalogue_groups: sim.fetch_result?.audit?.full_catalogue_groups ?? null,
    raw_groups: sim.raw_group_count ?? sim.fetch_result?.raw_group_count ?? null,
    expanded_dated_sailings: sim.raw_sailing_count ?? sim.metrics?.expanded_dated_sailings ?? sim.fetch_result?.products?.length ?? null,
    cruise_products: cruises.length,
    cruisetours_excluded: cruisetours.length,
    complete_high_confidence: complete.length,
    incomplete: incomplete.length,
    within_cutoff: withinCutoff.length,
    public_eligible: eligible.length,
    eligible_ids_hash: hashIds(eligibleIds),
    eligible_ids: eligibleIds,
    insert_candidate_count: insertCandidates.length,
    failure_counts: failureCounts,
    ship_resolution_pct: sim.metrics?.ship_resolution_pct ?? null,
    departure_port_resolution_pct: sim.metrics?.departure_port_resolution_pct ?? null,
    destination_resolution_pct: sim.metrics?.destination_resolution_pct ?? null,
    identity_coverage_pct: sim.metrics?.identity_coverage_pct ?? null,
    duplicate_identities: countDuplicateKeys(eligibleIds)
  };
}

function countDuplicateKeys(ids) {
  const seen = new Set();
  let dups = 0;
  for (const id of ids) {
    if (seen.has(id)) dups += 1;
    seen.add(id);
  }
  return dups;
}

async function loadProductionKeys(sb, adapter) {
  const keys = new Set();
  let offset = 0;
  const page = 1000;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=official_sailing_id,status&limit=${page}&offset=${offset}`
    );
    if (!batch?.length) break;
    for (const row of batch) {
      if (row.official_sailing_id) keys.add(row.official_sailing_id);
    }
    if (batch.length < page) break;
    offset += page;
  }
  return keys;
}

async function loadProductionRows(sb) {
  const rows = [];
  let offset = 0;
  const page = 1000;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,status,official_sailing_id,external_key,identity_key,departure_date,updated_at&limit=${page}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < page) break;
    offset += page;
  }
  return rows;
}

function classifyInsertCandidate(row, adapter, { oldEligibleSet, newEligibleSet, productionKeys }) {
  const id = adapter.officialProductKey(row.raw);
  const inOld = oldEligibleSet.has(id);
  const inNew = newEligibleSet.has(id);
  const inProd = productionKeys.has(id);
  const reasons = row.failure_reasons || [];
  let bucket = "I";
  let confidence = "low";
  if (!inProd && inNew && !inOld) {
    if (reasons.length === 0) {
      bucket = "A";
      confidence = "high";
    } else {
      bucket = "B";
      confidence = "medium";
    }
  } else if (!inProd && inNew && inOld) {
    bucket = "G";
    confidence = "medium";
  } else if (!inProd && inNew) {
    bucket = "B";
    confidence = "medium";
  }
  if (reasons.some((r) => r.includes("destination"))) {
    bucket = bucket === "B" ? "D" : bucket;
    confidence = "medium";
  }
  if (reasons.some((r) => r.includes("missing_departure_port") || r.includes("port"))) {
    bucket = bucket === "B" ? "C" : bucket;
    confidence = "medium";
  }
  const c = row.candidate || {};
  return {
    official_sailing_id: id,
    itinerary_id: row.raw?.itineraryId || row.raw?.itinerary_id || null,
    ship_code: row.raw?.shipCode || row.raw?.ship_code || null,
    ship_name: row.raw?.shipName || row.raw?.ship_name || null,
    departure_date: c.departure_date || null,
    return_date: c.return_date || null,
    nights: c.nights ?? null,
    departure_port: c.departure_port || null,
    destination: row.destination_resolution?.destinationKey || row.destination_resolution?.destinationName || null,
    official_url: c.official_url || null,
    classification: bucket,
    historical_cause_confidence: confidence,
    failure_reasons: reasons
  };
}

async function runCodeAtRoot(codeRoot, label) {
  const req = createRequire(path.join(codeRoot, "package.json"));
  const adapter = req(path.join(codeRoot, "netlify/functions/lib/princess-discovery-adapter"));
  const rest = createSupabaseRest(root);
  const sb = async (q) => rest.get(q);
  const line = (await sb("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"))[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const destinations = await loadClassificationDestinations(sb);
  const today = perthCalendarDate();
  const sim = await adapter.simulatePrincessInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    useCache: false,
    collectSourceDiagnostics: true
  });
  return { label, adapter, sim, today };
}

async function main() {
  const started = Date.now();
  const rest = createSupabaseRest(root);
  const sb = async (q) => rest.get(q);

  const productionRows = await loadProductionRows(sb);
  const byStatus = {};
  for (const r of productionRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const dup = (field) => {
    const seen = new Set();
    let d = 0;
    for (const r of productionRows) {
      const v = r[field];
      if (!v) continue;
      const k = String(v).toUpperCase();
      if (seen.has(k)) d += 1;
      seen.add(k);
    }
    return d;
  };

  console.error("Running current simulation run 1…");
  const run1 = await runCodeAtRoot(root, "current_run1");
  console.error("Running current simulation run 2…");
  const run2 = await runCodeAtRoot(root, "current_run2");

  const productionKeys = new Set(productionRows.map((r) => r.official_sailing_id).filter(Boolean));
  const s1 = summariseSimulation(run1.sim, run1.adapter, { today: run1.today, productionKeys });
  const s2 = summariseSimulation(run2.sim, run2.adapter, { today: run2.today, productionKeys });

  const worktree = path.join(root, ".worktrees", "princess-p1-old");
  if (!fs.existsSync(worktree)) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execSync(`git worktree add ${worktree} ${OLD_SHA}`, { cwd: root, stdio: "inherit" });
  }
  console.error("Running old-code simulation at", OLD_SHA.slice(0, 8), "…");
  const oldRun = await runCodeAtRoot(worktree, "old_code");
  const sold = summariseSimulation(oldRun.sim, oldRun.adapter, { today: oldRun.today, productionKeys });

  const currentAdapter = run1.adapter;
  const oldEligible = new Set(sold.eligible_ids);
  const newEligible = new Set(s1.eligible_ids);
  const onlyNew = [...newEligible].filter((id) => !oldEligible.has(id));
  const onlyOld = [...oldEligible].filter((id) => !newEligible.has(id));
  const common = [...newEligible].filter((id) => oldEligible.has(id));

  const eligibleProducts = (run1.sim.products || []).filter(
    (p) =>
      p.complete_high_confidence &&
      currentAdapter.isEligiblePrincessCruise(p.product_type) &&
      !productionKeys.has(currentAdapter.officialProductKey(p.raw))
  );
  const insertAudit = eligibleProducts
    .map((p) => classifyInsertCandidate(p, currentAdapter, { oldEligibleSet: oldEligible, newEligibleSet: newEligible, productionKeys }))
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));

  const classCounts = {};
  for (const row of insertAudit) {
    classCounts[row.classification] = (classCounts[row.classification] || 0) + 1;
  }

  const csr = productionRows.find((r) => r.official_sailing_id === "CSR07H|KP|2027-02-28");

  const report = {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    repository: {
      starting_sha: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
      old_comparison_sha: OLD_SHA
    },
    production_safety: {
      total_rows: productionRows.length,
      by_status: byStatus,
      active: byStatus.active || 0,
      expired: byStatus.expired || 0,
      duplicate_official_sailing_id: dup("official_sailing_id"),
      duplicate_external_key: dup("external_key"),
      duplicate_identity_key: dup("identity_key"),
      production_writes_performed: 0
    },
    source_reproducibility: {
      run1_eligible: s1.public_eligible,
      run2_eligible: s2.public_eligible,
      eligible_delta: s2.public_eligible - s1.public_eligible,
      hash_equal: s1.eligible_ids_hash === s2.eligible_ids_hash,
      pass: s1.eligible_ids_hash === s2.eligible_ids_hash && s1.public_eligible === s2.public_eligible
    },
    current_source_run1: s1,
    current_source_run2: { ...s2, eligible_ids: undefined },
    old_code_current_source: sold,
    code_vs_code_eligible: {
      old_eligible: sold.public_eligible,
      current_eligible: s1.public_eligible,
      eligible_delta: s1.public_eligible - sold.public_eligible,
      only_in_current: onlyNew.length,
      only_in_old: onlyOld.length,
      common: common.length,
      old_incomplete: sold.incomplete,
      current_incomplete: s1.incomplete,
      incomplete_delta: s1.incomplete - sold.incomplete,
      old_failure_counts: sold.failure_counts,
      current_failure_counts: s1.failure_counts
    },
    insert_candidate_audit: {
      total: insertAudit.length,
      classification_counts: classCounts,
      candidates: insertAudit
    },
    source_absence: {
      csr07h: csr || null,
      in_current_eligible: newEligible.has("CSR07H|KP|2027-02-28"),
      policy: "source_absent_retained_active"
    },
    expanded_sailings_null_explanation:
      "Cap-failure path in executeWeeklyMaintenance returns summary without simulation attached to executeResult; report uses simulation.raw_sailing_count which is null when simulation omitted — NOT evidence of missing source enumeration."
  };

  const out = path.join(root, "reports/princess-incident-p1-forensics-intermediate.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, insert_candidate_audit: { ...report.insert_candidate_audit, candidates: `[${insertAudit.length} rows]` } }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
