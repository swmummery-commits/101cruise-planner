/**
 * Shared Princess Incident P3 remediation helpers (local scripts).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const OLD_SHA = "8f867a7f0d1879ed6df3dbddbecc363b8765c24e";

function loadDeps(root) {
  const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const { headCountSupabase } = require(path.join(root, "netlify/functions/lib/celebrity-inventory-counts"));
  const { perthCalendarDate, partitionByPublicBookingCutoff } = require(path.join(
    root,
    "netlify/functions/lib/public-discovered-cruise-inventory"
  ));
  const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
  const {
    computePrincessDisjointSourceAccounting
  } = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
  const {
    buildFrozenCandidateFromProductRow,
    hashPrincessFrozenBatch,
    hashPrincessFrozenCandidate,
    comparePrincessLiveCandidateToFreeze,
    validateFrozenBatchCandidates,
    P3_BATCH_MAX_WRITES
  } = require(path.join(root, "netlify/functions/lib/princess-frozen-payload"));
  const { buildPrincessUpsertCandidate } = require(path.join(
    root,
    "netlify/functions/lib/princess-discovery-writes"
  ));
  const batchLib = require(path.join(root, "scripts/lib/princess-controlled-catch-up-batch.cjs"));

  return {
    createSupabaseRest,
    exactCountSupabase,
    headCountSupabase,
    perthCalendarDate,
    partitionByPublicBookingCutoff,
    loadClassificationDestinations,
    computePrincessDisjointSourceAccounting,
    buildFrozenCandidateFromProductRow,
    hashPrincessFrozenBatch,
    hashPrincessFrozenCandidate,
    comparePrincessLiveCandidateToFreeze,
    validateFrozenBatchCandidates,
    buildPrincessUpsertCandidate,
    batchLib,
    P3_BATCH_MAX_WRITES
  };
}

function hashIds(ids) {
  return crypto.createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}

async function loadAllPrincessRows(sb) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,official_url,updated_at&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function runPrincessSimulation(root) {
  const deps = loadDeps(root);
  const adapter = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
  const rest = deps.createSupabaseRest(root);
  const sb = async (q) => rest.get(q);
  const line = (await sb("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"))[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const destinations = await deps.loadClassificationDestinations(sb);
  const today = deps.perthCalendarDate();
  const sim = await adapter.simulatePrincessInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    useCache: false,
    collectSourceDiagnostics: true
  });
  return { adapter, sim, today, line, ships, destinations, sb };
}

function summariseSimulation(ctx, productionKeys, oldEligibleSet = null) {
  const { adapter, sim, today } = ctx;
  const deps = loadDeps(ctx.root || process.cwd());
  const normalised = sim.products || [];
  const disjoint = deps.computePrincessDisjointSourceAccounting({
    normalised,
    today,
    isEligibleProductType: adapter.isEligiblePrincessCruise.bind(adapter)
  });
  const { publiclyEligible } = deps.partitionByPublicBookingCutoff(
    normalised.filter((p) => p.product_type === "cruise"),
    (p) => p.candidate?.departure_date,
    today
  );
  const eligible = publiclyEligible.filter(
    (p) => p.complete_high_confidence && adapter.isEligiblePrincessCruise(p.product_type)
  );
  const eligibleIds = eligible.map((p) => adapter.officialProductKey(p.raw)).filter(Boolean);

  const insertProducts = eligible.filter((p) => {
    const id = adapter.officialProductKey(p.raw);
    return id && !productionKeys.has(id);
  });

  return {
    disjoint,
    eligible,
    eligibleIds,
    eligibleHash: hashIds(eligibleIds),
    insertProducts,
    rawGroups: sim.raw_group_count ?? sim.num_found_official ?? null,
    metrics: sim.metrics || {}
  };
}

function buildOldEligibleSet(root) {
  const { execSync } = require("child_process");
  const worktree = path.join(root, ".worktrees", "princess-p1-old");
  if (!fs.existsSync(worktree)) {
    execSync(`git worktree add -f ${worktree} ${OLD_SHA}`, { cwd: root, stdio: "inherit" });
  }
  return worktree;
}

async function buildMasterPlanCandidates(ctx, productionKeys) {
  const { line, adapter } = ctx;
  const summary = summariseSimulation({ ...ctx, root: ctx.root }, productionKeys);
  const oldWorktree = buildOldEligibleSet(ctx.root);
  const oldCtx = await runPrincessSimulation(oldWorktree);
  const oldSummary = summariseSimulation({ ...oldCtx, root: ctx.root }, productionKeys);
  const oldEligible = new Set(oldSummary.eligibleIds);

  const frozen = [];
  for (const row of summary.insertProducts) {
    const id = adapter.officialProductKey(row.raw);
    const fc = loadDeps(ctx.root).buildFrozenCandidateFromProductRow(row, line, {
      resolver_remediated: !oldEligible.has(id),
      old_rule_eligible_current_production_missing: oldEligible.has(id),
      historical_2026_08_10_source_present: "unknown"
    });
    if (!fc) continue;
    frozen.push(fc);
  }

  frozen.sort((a, b) => {
    const da = String(a.write_payload.departure_date);
    const db = String(b.write_payload.departure_date);
    if (da !== db) return da.localeCompare(db);
    return String(a.official_sailing_id).localeCompare(String(b.official_sailing_id));
  });

  return { frozen, summary, oldEligible };
}

function partitionIntoBatches(candidates, maxSize = P3_BATCH_MAX_WRITES) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += maxSize) {
    batches.push(candidates.slice(i, i + maxSize));
  }
  return batches;
}

async function collisionAuditProduction(sb, candidates) {
  const rows = await loadAllPrincessRows(sb);
  const official = new Set(rows.map((r) => r.official_sailing_id).filter(Boolean));
  const external = new Set(rows.map((r) => r.external_key).filter(Boolean));
  const identity = new Set(rows.map((r) => r.identity_key).filter(Boolean));

  let officialCollisions = 0;
  let externalCollisions = 0;
  let identityCollisions = 0;
  for (const c of candidates) {
    const p = c.write_payload || c.canonical_write_payload;
    if (official.has(c.official_sailing_id)) officialCollisions += 1;
    if (p?.external_key && external.has(p.external_key)) externalCollisions += 1;
    if (p?.identity_key && identity.has(p.identity_key)) identityCollisions += 1;
  }
  return {
    official_collisions: officialCollisions,
    external_collisions: externalCollisions,
    identity_collisions: identityCollisions,
    pass: officialCollisions + externalCollisions + identityCollisions === 0
  };
}

function compareLiveBatchToFreeze(liveRows, frozenCandidates, cruiseLine) {
  const deps = loadDeps(process.cwd());
  const byId = new Map(liveRows.map((r) => [deps.buildPrincessUpsertCandidate(r, cruiseLine)?.official_sailing_id, r]));
  const mismatches = [];
  for (const frozen of frozenCandidates) {
    const row = [...liveRows].find((r) => {
      const id = require(path.join(process.cwd(), "netlify/functions/lib/princess-discovery-adapter")).officialProductKey(r.raw);
      return id === frozen.official_sailing_id;
    });
    if (!row) {
      mismatches.push({ official_sailing_id: frozen.official_sailing_id, error: "missing_from_live_source" });
      continue;
    }
    const live = deps.buildPrincessUpsertCandidate(row, cruiseLine);
    const cmp = deps.comparePrincessLiveCandidateToFreeze({ liveCandidate: live, frozenCandidate: frozen });
    if (!cmp.ok) {
      mismatches.push({ official_sailing_id: frozen.official_sailing_id, ...cmp });
    }
  }
  const liveHashes = frozenCandidates.map((f) => {
    const row = liveRows.find((r) => {
      const id = require(path.join(process.cwd(), "netlify/functions/lib/princess-discovery-adapter")).officialProductKey(r.raw);
      return id === f.official_sailing_id;
    });
    const live = row ? deps.buildPrincessUpsertCandidate(row, cruiseLine) : null;
    return live ? deps.hashPrincessFrozenCandidate(live) : null;
  });
  const liveBatchHash = crypto.createHash("sha256").update(JSON.stringify(liveHashes.filter(Boolean).sort())).digest("hex");
  const frozenBatchHash = deps.hashPrincessFrozenBatch(frozenCandidates);
  return {
    ok: mismatches.length === 0 && liveBatchHash === frozenBatchHash,
    mismatches,
    live_batch_hash: liveBatchHash,
    frozen_batch_hash: frozenBatchHash
  };
}

function snapshotProductionCanonical(rows) {
  const snap = new Map();
  for (const r of rows) {
    if (!r.official_sailing_id) continue;
    snap.set(r.official_sailing_id, {
      official_sailing_id: r.official_sailing_id,
      ship_id: r.ship_id,
      destination_id: r.destination_id,
      departure_date: String(r.departure_date).slice(0, 10),
      return_date: String(r.return_date).slice(0, 10),
      nights: r.nights,
      departure_port: r.departure_port,
      itinerary: r.itinerary,
      external_key: r.external_key,
      identity_key: r.identity_key,
      official_url: r.official_url,
      status: r.status
    });
  }
  return snap;
}

function verifyPreExistingImmutability(beforeSnap, afterRows, allowedStatusChanges = new Set()) {
  const afterSnap = snapshotProductionCanonical(afterRows);
  const changes = [];
  for (const [id, before] of beforeSnap) {
    const after = afterSnap.get(id);
    if (!after) {
      if (allowedStatusChanges.has(id)) continue;
      changes.push({ official_sailing_id: id, error: "row_missing" });
      continue;
    }
    for (const key of Object.keys(before)) {
      if (key === "status") continue;
      if (String(before[key] ?? "") !== String(after[key] ?? "")) {
        changes.push({ official_sailing_id: id, field: key, before: before[key], after: after[key] });
      }
    }
  }
  return { ok: changes.length === 0, changes };
}

module.exports = {
  PRINCESS_LINE_ID,
  P3_BATCH_MAX_WRITES,
  loadDeps,
  hashIds,
  loadAllPrincessRows,
  runPrincessSimulation,
  summariseSimulation,
  buildMasterPlanCandidates,
  partitionIntoBatches,
  collisionAuditProduction,
  compareLiveBatchToFreeze,
  snapshotProductionCanonical,
  verifyPreExistingImmutability,
  hashPrincessFrozenBatch,
  hashPrincessFrozenCandidate,
  comparePrincessLiveCandidateToFreeze,
  validateFrozenBatchCandidates
};
