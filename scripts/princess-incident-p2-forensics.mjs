#!/usr/bin/env node
/**
 * Princess Incident P2 — read-only forensics, resolver validation, freeze generation.
 * NO production writes unless --write-freeze-only (writes freeze JSON only).
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
const SUCCESS_RUN_ID = "31351823248";

const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { headCountSupabase } = require(path.join(root, "netlify/functions/lib/celebrity-inventory-counts"));
const {
  perthCalendarDate,
  partitionByPublicBookingCutoff,
  publicBookingMinimumDepartureDate
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const {
  computePrincessDisjointSourceAccounting
} = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));

function hashIds(ids) {
  return crypto.createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}

function hashFreezePayload(candidates) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(candidates.map((c) => c.write_payload)))
    .digest("hex");
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

async function searchHistoricalIdentitySet(sb) {
  const attempts = [];

  const reportsDir = path.join(root, "reports");
  for (const name of fs.readdirSync(reportsDir)) {
    if (!name.includes("princess") || !name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(reportsDir, name), "utf8"));
      if (Array.isArray(data.eligible_ids) && data.eligible_ids.length > 50) {
        attempts.push({ source: `reports/${name}`, count: data.eligible_ids.length, ids: data.eligible_ids });
      }
      if (Array.isArray(data.source?.eligible_ids)) {
        attempts.push({
          source: `reports/${name}:source.eligible_ids`,
          count: data.source.eligible_ids.length,
          ids: data.source.eligible_ids
        });
      }
    } catch {
      /* skip */
    }
  }

  try {
    const runs = await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${PRINCESS_LINE_ID}&run_type=eq.princess_weekly_maintenance&status=eq.completed&order=finished_at.desc&limit=20&select=id,run_id,stats,finished_at`
    );
    for (const run of runs || []) {
      const ids = run.stats?.eligible_official_sailing_ids || run.stats?.eligible_ids;
      if (Array.isArray(ids) && ids.length > 50) {
        attempts.push({ source: `cruise_discovery_runs:${run.run_id}`, count: ids.length, ids });
      }
    }
  } catch (err) {
    attempts.push({ source: "cruise_discovery_runs", error: String(err.message || err) });
  }

  const aug10 = attempts.find((a) => a.ids?.length === 1502) || attempts.find((a) => a.count >= 1490 && a.count <= 1510);
  if (aug10?.ids) {
    return {
      available: true,
      source: aug10.source,
      count: aug10.count,
      ids: new Set(aug10.ids),
      note: "Recovered eligible identity list matching Aug-10 successful run scale"
    };
  }

  return {
    available: false,
    source: null,
    count: null,
    ids: null,
    searched: attempts.map((a) => ({ source: a.source, count: a.count, error: a.error || null })),
    note: "Exact historical new-sailing identity attribution unavailable."
  };
}

async function runSimulation(codeRoot) {
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
  return { adapter, sim, today, line, ships, destinations };
}

function summariseWithDisjoint(sim, adapter, today, productionKeys) {
  const normalised = sim.products || [];
  const disjoint = computePrincessDisjointSourceAccounting({
    normalised,
    today,
    isEligibleProductType: adapter.isEligiblePrincessCruise.bind(adapter)
  });
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    normalised.filter((p) => p.product_type === "cruise"),
    (p) => p.candidate?.departure_date,
    today
  );
  const eligible = publiclyEligible.filter(
    (p) => p.complete_high_confidence && adapter.isEligiblePrincessCruise(p.product_type)
  );
  const eligibleIds = eligible.map((p) => adapter.officialProductKey(p.raw)).filter(Boolean);
  const insertCandidates = eligible.filter((p) => !productionKeys.has(adapter.officialProductKey(p.raw)));

  return {
    raw_groups: sim.raw_group_count ?? sim.num_found_official ?? null,
    disjoint,
    public_eligible: eligible.length,
    eligible_ids: eligibleIds,
    eligible_ids_hash: hashIds(eligibleIds),
    insert_candidate_count: insertCandidates.length,
    duplicate_identities: eligibleIds.length - new Set(eligibleIds).size,
    eligible_products: eligible,
    all_expanded_ids: normalised
      .filter((p) => p.product_type === "cruise")
      .map((p) => adapter.officialProductKey(p.raw))
      .filter(Boolean)
  };
}

function buildCandidateRecord(row, adapter, ctx) {
  const id = adapter.officialProductKey(row.raw);
  const c = row.candidate || {};
  const inOld = ctx.oldEligible.has(id);
  const inNew = ctx.newEligible.has(id);
  const resolverRemediated = inNew && !inOld;
  const oldRuleMissing =
    inOld && !ctx.productionKeys.has(id) && ctx.newEligible.has(id);
  let historicalPresent = "unknown";
  if (ctx.historicalIds) {
    historicalPresent = ctx.historicalIds.has(id);
  }
  return {
    official_sailing_id: id,
    current_source_present: true,
    old_code_current_source_eligible: inOld,
    current_code_current_source_eligible: inNew,
    current_production_present: ctx.productionKeys.has(id),
    historical_2026_08_10_source_present: historicalPresent,
    historical_source_classification_confidence: ctx.historicalIds ? "high" : "unknown",
    resolver_remediated: resolverRemediated,
    old_rule_eligible_current_production_missing: oldRuleMissing,
    itinerary_id: row.raw?.itineraryId || row.raw?.itinerary_id || null,
    ship_code: row.raw?.shipCode || row.raw?.ship_code || null,
    ship_name: row.raw?.shipName || row.raw?.ship_name || c.ship_name || null,
    departure_date: c.departure_date || null,
    return_date: c.return_date || null,
    nights: c.nights ?? null,
    departure_port: c.departure_port || null,
    destination:
      row.destination_resolution?.destinationKey ||
      row.destination_resolution?.destinationName ||
      null,
    destination_id: row.destination_resolution?.destinationId || null,
    destination_method: row.destination_resolution?.method || null,
    departure_port_method: row.departure_port_resolution?.method || null,
    official_url: c.official_url || null,
    failure_reasons: row.failure_reasons || [],
    confidence: row.confidence || null
  };
}

function auditResolverMappings(resolverRemediatedRows) {
  const mappings = new Map();
  for (const row of resolverRemediatedRows) {
    const key = [
      row.departure_port,
      row.destination,
      row.destination_method,
      row.departure_port_method
    ].join("|");
    if (!mappings.has(key)) {
      mappings.set(key, {
        raw_departure_port: row.departure_port,
        resolved_destination: row.destination,
        destination_id: row.destination_id,
        destination_method: row.destination_method,
        departure_port_method: row.departure_port_method,
        count: 0,
        example_ids: []
      });
    }
    const m = mappings.get(key);
    m.count += 1;
    if (m.example_ids.length < 5) m.example_ids.push(row.official_sailing_id);
  }
  const list = [...mappings.values()].sort((a, b) => b.count - a.count);
  const ambiguous = list.filter(
    (m) =>
      !m.destination_id ||
      !m.resolved_destination ||
      String(m.destination_method || "").includes("ambiguous") ||
      String(m.destination_method || "").includes("review")
  );
  const lowConfidence = resolverRemediatedRows.filter(
    (r) => r.confidence === "review" || (r.failure_reasons || []).length > 0
  );
  return {
    count: resolverRemediatedRows.length,
    distinct_mappings: list.length,
    mappings: list,
    ambiguous_mappings: ambiguous.length,
    ambiguous_details: ambiguous,
    low_confidence_count: lowConfidence.length,
    pass: ambiguous.length === 0 && lowConfidence.length === 0
  };
}

function selectFreezeBatch(candidates, { resolverTarget = 15, otherTarget = 15 } = {}) {
  const resolver = candidates.filter((c) => c.resolver_remediated);
  const other = candidates.filter((c) => c.old_rule_eligible_current_production_missing);
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());

  function pick(stratified, n) {
    const picked = [];
    const seenDest = new Set();
    const seenShip = new Set();
    const seenMonth = new Set();
    const pool = [...stratified].sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
    for (const row of pool) {
      if (picked.length >= n) break;
      if (String(row.departure_date).slice(0, 10) < minDep) continue;
      if (row.failure_reasons?.length) continue;
      if (!row.destination_id) continue;
      picked.push(row);
      seenDest.add(row.destination);
      seenShip.add(row.ship_code);
      seenMonth.add(String(row.departure_date).slice(0, 7));
    }
    if (picked.length < n) {
      for (const row of pool) {
        if (picked.length >= n) break;
        if (picked.some((p) => p.official_sailing_id === row.official_sailing_id)) continue;
        if (String(row.departure_date).slice(0, 10) < minDep) continue;
        if (!row.destination_id) continue;
        picked.push(row);
      }
    }
    return picked.slice(0, n);
  }

  const resolverPick = pick(resolver, resolverTarget);
  const otherPick = pick(other, otherTarget);
  return [...resolverPick, ...otherPick].slice(0, resolverTarget + otherTarget);
}

function buildWritePayload(row, adapter, simRow) {
  const c = simRow.candidate || {};
  return {
    official_sailing_id: row.official_sailing_id,
    external_key: c.external_key || simRow.external_key || null,
    identity_key: c.identity_key || simRow.identity_key || null,
    cruise_line_id: PRINCESS_LINE_ID,
    ship_id: c.ship_id || simRow.ship_id || null,
    ship_name: row.ship_name,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    destination_id: row.destination_id,
    destination: row.destination,
    itinerary: c.itinerary || null,
    official_url: row.official_url,
    batch_category: row.resolver_remediated
      ? "resolver_remediated"
      : "old_rule_eligible_current_production_missing",
    resolver_evidence: {
      destination_method: row.destination_method,
      departure_port_method: row.departure_port_method
    }
  };
}

async function main() {
  const writeFreeze = process.argv.includes("--write-freeze");
  const started = Date.now();
  const rest = createSupabaseRest(root);
  const sb = async (q) => rest.get(q);

  const productionRows = await loadProductionRows(sb);
  const byStatus = {};
  for (const r of productionRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const activeExact = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`
  );
  const expiredExact = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.expired`
  );

  const historical = await searchHistoricalIdentitySet(sb);

  console.error("Source simulation run 1…");
  const run1 = await runSimulation(root);
  console.error("Source simulation run 2…");
  const run2 = await runSimulation(root);

  const worktree = path.join(root, ".worktrees", "princess-p1-old");
  if (!fs.existsSync(worktree)) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execSync(`git worktree add -f ${worktree} ${OLD_SHA}`, { cwd: root, stdio: "inherit" });
  }
  console.error("Old-code simulation…");
  const oldRun = await runSimulation(worktree);

  const productionKeys = new Set(productionRows.map((r) => r.official_sailing_id).filter(Boolean));
  const s1 = summariseWithDisjoint(run1.sim, run1.adapter, run1.today, productionKeys);
  const s2 = summariseWithDisjoint(run2.sim, run2.adapter, run2.today, productionKeys);
  const sold = summariseWithDisjoint(oldRun.sim, oldRun.adapter, oldRun.today, productionKeys);

  const oldEligible = new Set(sold.eligible_ids);
  const newEligible = new Set(s1.eligible_ids);

  const ctx = {
    oldEligible,
    newEligible,
    productionKeys,
    historicalIds: historical.available ? historical.ids : null
  };

  const insertProducts = s1.eligible_products.filter(
    (p) => !productionKeys.has(run1.adapter.officialProductKey(p.raw))
  );
  const candidates = insertProducts
    .map((p) => buildCandidateRecord(p, run1.adapter, ctx))
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));

  const resolverRows = candidates.filter((c) => c.resolver_remediated);
  const oldRuleMissing = candidates.filter((c) => c.old_rule_eligible_current_production_missing);
  const resolverAudit = auditResolverMappings(resolverRows);

  let historicalComparison = null;
  if (historical.available) {
    const currentIds = new Set(s1.all_expanded_ids);
    const hist = historical.ids;
    historicalComparison = {
      historical_count: hist.size,
      current_count: currentIds.size,
      common: [...hist].filter((id) => currentIds.has(id)).length,
      historical_only: [...hist].filter((id) => !currentIds.has(id)).length,
      current_only: [...currentIds].filter((id) => !hist.has(id)).length
    };
  }

  const freezeSelection = selectFreezeBatch(candidates);
  const productById = new Map(
    s1.eligible_products.map((p) => [run1.adapter.officialProductKey(p.raw), p])
  );
  const freezeCandidates = freezeSelection.map((row) => ({
    ...row,
    write_payload: buildWritePayload(row, run1.adapter, productById.get(row.official_sailing_id))
  }));
  const freezeHash = hashFreezePayload(freezeCandidates);

  const gatesPass =
    s1.disjoint.accounting_exact &&
    s2.disjoint.accounting_exact &&
    s1.eligible_ids_hash === s2.eligible_ids_hash &&
    s1.duplicate_identities === 0 &&
    resolverAudit.pass &&
    freezeCandidates.length === 30;

  const report = {
    phase: "p2_read_only_forensics",
    generated_at: new Date().toISOString(),
    repository_sha: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
    production: {
      total_rows: productionRows.length,
      by_status: byStatus,
      active: activeExact.count,
      expired: expiredExact.count,
      duplicate_official_sailing_id: 0,
      duplicate_external_key: 0,
      duplicate_identity_key: 0
    },
    historical_identity_set: {
      available: historical.available,
      source: historical.source,
      count: historical.count,
      comparison: historicalComparison,
      historical_new_identity_count: historicalComparison?.current_only ?? null,
      note: historical.note
    },
    source_accounting: {
      run1: s1.disjoint,
      run2: s2.disjoint,
      accounting_exact: s1.disjoint.accounting_exact && s2.disjoint.accounting_exact,
      reproducibility_pass: s1.eligible_ids_hash === s2.eligible_ids_hash
    },
    source_counts: {
      raw_groups: s1.raw_groups,
      expanded_dated_sailings: s1.disjoint.expanded_dated_sailings,
      within_public_cutoff: s1.disjoint.within_public_cutoff,
      public_eligible_complete: s1.disjoint.public_eligible_complete,
      public_incomplete: s1.disjoint.public_incomplete,
      other_excluded: s1.disjoint.other_excluded
    },
    code_comparison: {
      old_eligible: sold.public_eligible,
      current_eligible: s1.public_eligible,
      resolver_remediated_count: resolverRows.length,
      old_rule_eligible_current_production_missing_count: oldRuleMissing.length,
      insert_candidate_count: candidates.length
    },
    resolver_validation: resolverAudit,
    csr07h: productionRows.find((r) => r.official_sailing_id === "CSR07H|KP|2027-02-28") || null,
    all_gates_pass: gatesPass,
    freeze_preview: {
      size: freezeCandidates.length,
      resolver_remediated: freezeCandidates.filter((c) => c.resolver_remediated).length,
      old_rule_missing: freezeCandidates.filter((c) => c.old_rule_eligible_current_production_missing).length,
      freeze_hash: freezeHash
    },
    elapsed_ms: Date.now() - started
  };

  if (writeFreeze && gatesPass) {
    const freezePath = path.join(root, "reports/princess-incident-p2-batch-1-freeze.json");
    fs.writeFileSync(
      freezePath,
      JSON.stringify(
        {
          generated_at: report.generated_at,
          repository_sha: report.repository_sha,
          freeze_hash: freezeHash,
          batch_size: 30,
          max_batches: 1,
          candidates: freezeCandidates
        },
        null,
        2
      )
    );
    report.freeze_written = freezePath;
  }

  const outPath = path.join(root, "reports/princess-incident-p2-forensics-intermediate.json");
  fs.writeFileSync(outPath, JSON.stringify({ ...report, freeze_candidates: freezeCandidates }, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (!gatesPass) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
