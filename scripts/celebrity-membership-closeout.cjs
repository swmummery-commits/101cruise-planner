#!/usr/bin/env node
/**
 * Celebrity final membership close-out (narrow insert + out-of-set audit).
 *
 *   node scripts/celebrity-membership-closeout.cjs --snapshot
 *   node scripts/celebrity-membership-closeout.cjs --manifest
 *   node scripts/celebrity-membership-closeout.cjs --apply
 *   node scripts/celebrity-membership-closeout.cjs --verify
 *   node scripts/celebrity-membership-closeout.cjs --idempotency
 *   node scripts/celebrity-membership-closeout.cjs --all
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const DATE = "2026-08-06";

const MISSING_SAILING = "EC10U115_2026-09-18";
const OUT_OF_SNAPSHOT_SAILING = "XC07M834_2026-08-22";

const SNAPSHOT_PATH = path.join(root, `reports/celebrity-membership-snapshot-${DATE}.json`);
const RECON_PATH = path.join(root, `reports/celebrity-membership-set-reconciliation-${DATE}.json`);
const MANIFEST_PATH = path.join(root, `reports/celebrity-final-membership-closeout-${DATE}.json`);
const BACKUP_PATH = path.join(root, `reports/celebrity-membership-pre-repair-backup-${DATE}.json`);
const ROLLBACK_PATH = path.join(root, `reports/celebrity-membership-rollback-${DATE}.json`);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateCelebrityInventory,
  catalogueDestinations,
  isEligibleCelebrityCruise,
  officialGroupKey
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));
const { applyCelebrityBatchWrites } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-writes"));
const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
const {
  buildCelebrityRunStats,
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  CELEBRITY_MEMBERSHIP_CLOSEOUT_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-run-tracking"));
const { loadCelebrityDatabaseInventoryCounts } = require(path.join(root, "netlify/functions/lib/celebrity-inventory-counts"));

function checksum(v) {
  return crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
}

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function fetchAllActive(sb, lineId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&select=id,status,departure_date,return_date,nights,official_sailing_id,ship_id,destination_id,departure_port,official_url,created_at,updated_at,raw_extract&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function loadCtx(sb) {
  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug&limit=1"))?.[0];
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return { line, halLine, ships: ships || [], destinations: catalogueDestinations(destRows || []) };
}

async function captureBoundaryCounts(lineId, halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_discovered_cruises: await headCount("discovered_cruises", "status=eq.active"),
    celebrity_total: lineId ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}`) : 0,
    celebrity_active: lineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active`)
      : 0,
    celebrity_ocean_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&raw_extract->>celebrity_product_type=eq.ocean_cruise`
        )
      : 0,
    celebrity_river_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&raw_extract->>celebrity_product_type=eq.river_cruise`
        )
      : 0,
    hal_active: halLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`)
      : 0,
    pending_reviews: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    total_review_items: await headCount("cruise_discovery_review_items"),
    ship_aliases: await headCount("cruise_ship_aliases"),
    destination_aliases: await headCount("cruise_destination_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };
}

function productAuditEntry(p, dbRow) {
  if (!p) {
    return {
      in_official_inventory: false,
      in_eligible_set: false,
      database_record_id: dbRow?.id || null,
      database_match: dbRow
        ? {
            id: dbRow.id,
            status: dbRow.status,
            product_type: dbRow.raw_extract?.celebrity_product_type,
            departure_date: dbRow.departure_date
          }
        : null
    };
  }
  return {
    in_official_inventory: true,
    in_eligible_set: p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type),
    official_sailing_id: p.official_product_key,
    official_group_id: officialGroupKey(p.raw),
    product_type: p.product_type,
    ship: p.raw?.ship_name || p.ship_resolution?.ship?.name,
    ship_code: p.raw?.ship_code,
    departure_date: p.candidate?.departure_date || p.raw?.departure_date,
    return_date: p.candidate?.return_date || p.raw?.return_date,
    nights: p.candidate?.nights || p.raw?.nights,
    departure_port: p.candidate?.departure_port || p.raw?.departure_port,
    destination: p.destination_resolution?.destinationKey || null,
    source_url: p.raw?.official_url,
    pre_tour_duration: p.raw?.pre_tour_duration ?? null,
    post_tour_duration: p.raw?.post_tour_duration ?? null,
    completeness: p.complete_high_confidence ? "complete_high_confidence" : "incomplete",
    confidence: p.adapter_confidence || null,
    ship_resolved: p.ship_resolution?.resolved === true,
    departure_port_resolved: p.departure_port_resolution?.status === "resolved",
    destination_resolved: p.destination_resolution?.status === "resolved",
    failure_reasons: p.failure_reasons || [],
    database_record_id: dbRow?.id || null,
    database_match: dbRow
      ? {
          id: dbRow.id,
          status: dbRow.status,
          product_type: dbRow.raw_extract?.celebrity_product_type,
          departure_date: dbRow.departure_date
        }
      : null
  };
}

function classifyOutOfSnapshot(dbRow, official, eligibleIds) {
  const sid = dbRow?.official_sailing_id || dbRow?.raw_extract?.celebrity_sailing_id;
  if (official && eligibleIds.has(sid)) {
    return { code: "A", action: "unchanged", reason: "present_in_current_eligible_snapshot" };
  }
  if (official && isEligibleCelebrityCruise(official.product_type) && official.complete_high_confidence) {
    return { code: "A", action: "unchanged", reason: "valid_eligible_in_graphql_not_in_eligible_set_filter" };
  }
  if (official && !isEligibleCelebrityCruise(official.product_type)) {
    if (String(official.product_type).includes("cruisetour")) {
      return { code: "E", action: "hold_for_evidence", reason: "reclassified_cruisetour_requires_manual_review" };
    }
    return { code: "F", action: "hold_for_evidence", reason: "invalid_product_type_in_graphql" };
  }
  if (official && !official.complete_high_confidence) {
    return { code: "G", action: "unchanged", reason: "graphql_present_but_incomplete" };
  }
  if (!official) {
    return {
      code: "C",
      action: "unchanged",
      reason: "absent_from_current_full_graphql_fetch_leave_active_without_deterministic_withdrawal_evidence"
    };
  }
  return { code: "G", action: "hold_for_evidence", reason: "unresolved" };
}

function passesInsertGates(product, today, existingBySailingId) {
  const reasons = [];
  if (!product) reasons.push("not_in_graphql");
  if (product && !product.complete_high_confidence) reasons.push("not_complete_high_confidence");
  if (product && !isEligibleCelebrityCruise(product.product_type)) reasons.push("not_eligible_product_type");
  if (product && !product.ship_resolution?.resolved) reasons.push("ship_unresolved");
  if (product && product.departure_port_resolution?.status !== "resolved") reasons.push("departure_port_unresolved");
  if (product && product.destination_resolution?.status !== "resolved") reasons.push("destination_unresolved");
  const dep = product?.candidate?.departure_date || product?.raw?.departure_date;
  if (dep && dep < today) reasons.push("not_future_dated");
  if (existingBySailingId.has(MISSING_SAILING)) reasons.push("already_present_by_official_sailing_id");
  return { ok: reasons.length === 0, reasons };
}

async function runSnapshot(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    requestDelayMs: 150
  });
  const eligible = simulation.products.filter(
    (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
  );
  const byKey = new Map(simulation.products.map((p) => [p.official_product_key, p]));
  const eligibleIds = new Set(eligible.map((p) => p.official_product_key));

  const snapshot = {
    generated_at: new Date().toISOString(),
    cache_disabled: true,
    pagination_requests: simulation.pagination_requests,
    page_log: simulation.page_log,
    official_reported_total: simulation.official_reported_total,
    eligible_count: eligible.length,
    eligible_ocean: eligible.filter((p) => p.product_type === "ocean_cruise").length,
    eligible_river: eligible.filter((p) => p.product_type === "river_cruise").length,
    targeted_audits: {
      [MISSING_SAILING]: productAuditEntry(byKey.get(MISSING_SAILING), null),
      [OUT_OF_SNAPSHOT_SAILING]: productAuditEntry(byKey.get(OUT_OF_SNAPSHOT_SAILING), null)
    },
    eligible_ids: [...eligibleIds].sort(),
    checksum: null
  };
  snapshot.checksum = checksum(snapshot.eligible_ids);
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  return { snapshot, simulation, eligibleIds, byKey, today };
}

async function runReconcile(ctx, sb, snapshot, simulation, eligibleIds, byKey) {
  const activeRows = await fetchAllActive(sb, ctx.line.id);
  const activeIds = new Set(
    activeRows.map((r) => r.official_sailing_id || r.raw_extract?.celebrity_sailing_id).filter(Boolean)
  );
  const eligibleAndActive = [...eligibleIds].filter((id) => activeIds.has(id));
  const eligibleMissing = [...eligibleIds].filter((id) => !activeIds.has(id));
  const activeNotEligible = [...activeIds].filter((id) => !eligibleIds.has(id));

  const missingRow = activeRows.find(
    (r) => (r.official_sailing_id || r.raw_extract?.celebrity_sailing_id) === MISSING_SAILING
  );
  const outRow = activeRows.find(
    (r) => (r.official_sailing_id || r.raw_extract?.celebrity_sailing_id) === OUT_OF_SNAPSHOT_SAILING
  );

  snapshot.targeted_audits[MISSING_SAILING] = productAuditEntry(byKey.get(MISSING_SAILING), missingRow);
  snapshot.targeted_audits[OUT_OF_SNAPSHOT_SAILING] = productAuditEntry(byKey.get(OUT_OF_SNAPSHOT_SAILING), outRow);

  const insertGates = passesInsertGates(byKey.get(MISSING_SAILING), snapshot.generated_at.slice(0, 10), activeIds);
  const outAudit = classifyOutOfSnapshot(outRow, byKey.get(OUT_OF_SNAPSHOT_SAILING), eligibleIds);

  const sailingCounts = {};
  for (const id of activeIds) sailingCounts[id] = (sailingCounts[id] || 0) + 1;
  const duplicateIdentities = Object.entries(sailingCounts).filter(([, c]) => c > 1);
  const untyped = activeRows.filter((r) => !r.raw_extract?.celebrity_product_type);
  const cruisetours = activeRows.filter((r) =>
    ["ocean_cruisetour", "river_cruisetour"].includes(r.raw_extract?.celebrity_product_type)
  );

  const recon = {
    generated_at: new Date().toISOString(),
    snapshot_timestamp: snapshot.generated_at,
    snapshot_checksum: snapshot.checksum,
    set_counts: {
      official_eligible: eligibleIds.size,
      active_celebrity: activeIds.size,
      eligible_and_active: eligibleAndActive.length,
      eligible_missing_from_production: eligibleMissing.length,
      active_not_in_current_eligible_set: activeNotEligible.length,
      duplicate_official_identities: duplicateIdentities.length,
      active_untyped: untyped.length,
      active_cruisetours: cruisetours.length
    },
    eligible_missing_ids: eligibleMissing.sort(),
    active_not_eligible_ids: activeNotEligible.sort(),
    targeted: {
      missing_eligible: {
        official_sailing_id: MISSING_SAILING,
        audit: snapshot.targeted_audits[MISSING_SAILING],
        insert_gates: insertGates
      },
      out_of_snapshot: {
        official_sailing_id: OUT_OF_SNAPSHOT_SAILING,
        discovered_cruise_id: outRow?.id || null,
        audit: snapshot.targeted_audits[OUT_OF_SNAPSHOT_SAILING],
        classification: outAudit
      }
    }
  };

  fs.mkdirSync(path.dirname(RECON_PATH), { recursive: true });
  fs.writeFileSync(RECON_PATH, JSON.stringify(recon, null, 2));
  return recon;
}

function buildManifest(recon, snapshot) {
  const actions = [];
  const missing = recon.targeted.missing_eligible;
  if (missing.insert_gates.ok) {
    actions.push({
      action: "insert_missing_eligible",
      official_sailing_id: MISSING_SAILING,
      discovered_cruise_id: null,
      current_classification: missing.audit.product_type,
      proposed_action: "insert_missing_eligible",
      official_source_evidence: missing.audit,
      source_snapshot_timestamp: snapshot.generated_at,
      source_checksum: snapshot.checksum,
      before_values: null,
      rollback_values: { delete_on_rollback: true, official_sailing_id: MISSING_SAILING }
    });
  } else {
    actions.push({
      action: "hold_for_evidence",
      official_sailing_id: MISSING_SAILING,
      proposed_action: "hold_for_evidence",
      official_source_evidence: missing.audit,
      reason: missing.insert_gates.reasons.join("; "),
      source_snapshot_timestamp: snapshot.generated_at,
      source_checksum: snapshot.checksum
    });
  }

  const out = recon.targeted.out_of_snapshot;
  actions.push({
    action: out.classification.action,
    official_sailing_id: OUT_OF_SNAPSHOT_SAILING,
    discovered_cruise_id: out.discovered_cruise_id,
    current_classification: outRowProductType(out),
    proposed_action: out.classification.action,
    official_source_evidence: out.audit,
    classification_code: out.classification.code,
    reason: out.classification.reason,
    source_snapshot_timestamp: snapshot.generated_at,
    source_checksum: snapshot.checksum,
    before_values: { status: "active" },
    rollback_values: { status: "active" }
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    phase: "celebrity_final_membership_closeout",
    source_snapshot_checksum: snapshot.checksum,
    source_snapshot_timestamp: snapshot.generated_at,
    actions,
    deterministic_insert_count: actions.filter((a) => a.action === "insert_missing_eligible").length,
    checksum: checksum(actions.filter((a) => a.action === "insert_missing_eligible"))
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

function outRowProductType(out) {
  return out.audit?.database_match?.product_type || out.audit?.product_type || null;
}

async function runApply(ctx, manifest, snapshot) {
  if (String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("Set CELEBRITY_DISCOVERY_WRITE_ENABLED=true temporarily for membership apply");
  }

  const inserts = manifest.actions.filter((a) => a.action === "insert_missing_eligible");
  if (inserts.length !== 1 || inserts[0].official_sailing_id !== MISSING_SAILING) {
    return { applied: false, reason: "no_approved_insert_action", inserts: inserts.length };
  }

  const countsBefore = await captureBoundaryCounts(ctx.line.id, ctx.halLine?.id);
  fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
  fs.writeFileSync(
    BACKUP_PATH,
    JSON.stringify({ counts_before: countsBefore, manifest_checksum: manifest.checksum, snapshot_checksum: snapshot.checksum }, null, 2)
  );

  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    requestDelayMs: 150
  });

  const product = simulation.products.find((p) => p.official_product_key === MISSING_SAILING);
  const gates = passesInsertGates(
    product,
    today,
    new Set(
      (await fetchAllActive(createSupabaseRest(root), ctx.line.id))
        .map((r) => r.official_sailing_id || r.raw_extract?.celebrity_sailing_id)
        .filter(Boolean)
    )
  );
  if (!gates.ok) {
    return { applied: false, reason: "insert_gates_failed_at_apply", gates };
  }

  const runId = `celebrity-membership-closeout-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "membership_closeout",
    runType: CELEBRITY_MEMBERSHIP_CLOSEOUT_RUN_TYPE,
    writesEnabled: true
  });

  const writeResult = await applyCelebrityBatchWrites({
    products: simulation.products,
    cruiseLine: ctx.line,
    maxWrites: 1,
    runId,
    supabase,
    controlledSelection: [product]
  });

  const insertedId = writeResult.stats.write_details?.[0]?.discovered_cruise_id || null;
  const rollbackDoc = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    db_run_id: dbRun.id,
    manifest_checksum: manifest.checksum,
    snapshot_checksum: snapshot.checksum,
    rollback_entries: insertedId
      ? [{ action: "delete_inserted", discovered_cruise_id: insertedId, official_sailing_id: MISSING_SAILING }]
      : []
  };
  fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(rollbackDoc, null, 2));

  const countsAfter = await captureBoundaryCounts(ctx.line.id, ctx.halLine?.id);

  await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
    status: writeResult.stats.inserted === 1 ? "completed" : "failed",
    stats: {
      ...buildCelebrityRunStats({
        runType: CELEBRITY_MEMBERSHIP_CLOSEOUT_RUN_TYPE,
        mode: "membership_closeout",
        runId,
        writesEnabled: true,
        proposedWrites: 1,
        inserted: writeResult.stats.inserted || 0,
        failed: writeResult.stats.failed || 0,
        duplicateSkips: writeResult.stats.duplicate_skips || 0,
        rollbackManifest: path.basename(ROLLBACK_PATH)
      }),
      official_eligible_total: snapshot.eligible_count,
      eligible_missing_from_production: null,
      out_of_snapshot_active: 1,
      out_of_snapshot_sailing_ids: [OUT_OF_SNAPSHOT_SAILING],
      inserted_official_sailing_id: MISSING_SAILING,
      inserted_discovered_cruise_id: insertedId,
      snapshot_checksum: snapshot.checksum,
      manifest_checksum: manifest.checksum
    }
  });

  return {
    applied: writeResult.stats.inserted === 1,
    run_id: runId,
    inserted_id: insertedId,
    write_stats: writeResult.stats,
    counts_before: countsBefore,
    counts_after: countsAfter
  };
}

async function runIdempotency(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });
  const product = simulation.products.find((p) => p.official_product_key === MISSING_SAILING);
  if (!product) return { skipped: true, reason: "product_not_in_graphql" };

  const writeResult = await applyCelebrityBatchWrites({
    products: simulation.products,
    cruiseLine: ctx.line,
    maxWrites: 1,
    runId: `celebrity-membership-idempotency-${Date.now()}`,
    supabase,
    controlledSelection: [product]
  });

  return {
    inserts: writeResult.stats.inserted || 0,
    updates: writeResult.stats.updated || 0,
    duplicate_skips: writeResult.stats.duplicate_skips || 0,
    ok:
      (writeResult.stats.inserted || 0) === 0 &&
      (writeResult.stats.updated || 0) === 0 &&
      (writeResult.stats.duplicate_skips || 0) >= 1
  };
}

async function runVerify(ctx, sb, snapshot, simulation, eligibleIds, byKey) {
  const recon = await runReconcile(ctx, sb, snapshot, simulation, eligibleIds, byKey);
  const inventory = await loadCelebrityDatabaseInventoryCounts(supabase, ctx.line.id);
  const inserted = await sb.get(
    `discovered_cruises?official_sailing_id=eq.${encodeURIComponent(MISSING_SAILING)}&select=*&limit=1`
  );
  const row = inserted?.[0];
  return {
    set_reconciliation: recon.set_counts,
    eligible_missing_ids: recon.eligible_missing_ids,
    active_not_eligible_ids: recon.active_not_eligible_ids,
    inventory,
    inserted_record: row
      ? {
          id: row.id,
          official_sailing_id: row.official_sailing_id,
          status: row.status,
          product_type: row.raw_extract?.celebrity_product_type,
          ship_id: row.ship_id,
          destination_id: row.destination_id,
          departure_date: row.departure_date,
          departure_port: row.departure_port,
          nights: row.nights,
          return_date: row.return_date,
          official_url: row.official_url
        }
      : null
  };
}

async function recordAuditRun(ctx, recon, snapshot, manifest) {
  const runId = `celebrity-membership-audit-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "membership_closeout_audit",
    runType: CELEBRITY_MEMBERSHIP_CLOSEOUT_RUN_TYPE,
    writesEnabled: false
  });
  await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
    status: "completed",
    stats: {
      ...buildCelebrityRunStats({
        runType: CELEBRITY_MEMBERSHIP_CLOSEOUT_RUN_TYPE,
        mode: "membership_closeout_audit",
        runId,
        writesEnabled: false,
        proposedWrites: manifest.deterministic_insert_count,
        inserted: 0
      }),
      official_eligible_total: recon.set_counts.official_eligible,
      eligible_missing_from_production: recon.set_counts.eligible_missing_from_production,
      out_of_snapshot_active: recon.set_counts.active_not_in_current_eligible_set,
      out_of_snapshot_sailing_ids: recon.active_not_eligible_ids,
      snapshot_checksum: snapshot.checksum,
      manifest_checksum: manifest.checksum,
      targeted_audits: recon.targeted
    }
  });
  return runId;
}

async function main() {
  const args = {
    snapshot: process.argv.includes("--snapshot"),
    manifest: process.argv.includes("--manifest"),
    apply: process.argv.includes("--apply"),
    verify: process.argv.includes("--verify"),
    idempotency: process.argv.includes("--idempotency"),
    record: process.argv.includes("--record"),
    all: process.argv.includes("--all")
  };
  if (!Object.values(args).some(Boolean)) {
    console.error("Use --snapshot, --manifest, --apply, --verify, --idempotency, --record, or --all");
    process.exit(1);
  }

  const sb = createSupabaseRest(root);
  const ctx = await loadCtx(sb);

  let snapshotBundle = args.snapshot || args.all ? await runSnapshot(ctx) : null;
  if (!snapshotBundle && fs.existsSync(SNAPSHOT_PATH)) {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const simulation = await simulateCelebrityInventory({
      cruiseLine: ctx.line,
      ships: ctx.ships,
      destinations: ctx.destinations,
      today,
      requestDelayMs: 150
    });
    const eligible = simulation.products.filter(
      (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
    );
    snapshotBundle = {
      snapshot,
      simulation,
      eligibleIds: new Set(eligible.map((p) => p.official_product_key)),
      byKey: new Map(simulation.products.map((p) => [p.official_product_key, p])),
      today
    };
  }

  if (args.snapshot || args.all) {
    console.log(
      "Snapshot eligible:",
      snapshotBundle.snapshot.eligible_count,
      "targets:",
      JSON.stringify(snapshotBundle.snapshot.targeted_audits, null, 2)
    );
  }

  let recon = null;
  let manifest = null;
  if (args.manifest || args.apply || args.verify || args.record || args.all) {
    recon = await runReconcile(
      ctx,
      sb,
      snapshotBundle.snapshot,
      snapshotBundle.simulation,
      snapshotBundle.eligibleIds,
      snapshotBundle.byKey
    );
    manifest = buildManifest(recon, snapshotBundle.snapshot);
    console.log("Manifest deterministic inserts:", manifest.deterministic_insert_count);
    console.log("Set counts:", recon.set_counts);
  }

  if (args.apply || args.all) {
    const applyResult = await runApply(ctx, manifest, snapshotBundle.snapshot);
    console.log("Apply:", JSON.stringify(applyResult, null, 2));
    snapshotBundle = await runSnapshot(ctx);
    recon = await runReconcile(
      ctx,
      sb,
      snapshotBundle.snapshot,
      snapshotBundle.simulation,
      snapshotBundle.eligibleIds,
      snapshotBundle.byKey
    );
  }

  if (args.idempotency || args.all) {
    const idem = await runIdempotency(ctx);
    console.log("Idempotency:", JSON.stringify(idem, null, 2));
  }

  if (args.verify || args.all) {
    const verify = await runVerify(
      ctx,
      sb,
      snapshotBundle.snapshot,
      snapshotBundle.simulation,
      snapshotBundle.eligibleIds,
      snapshotBundle.byKey
    );
    console.log("Verify:", JSON.stringify(verify, null, 2));
  }

  if ((args.record || args.all) && recon && manifest) {
    const auditRunId = await recordAuditRun(ctx, recon, snapshotBundle.snapshot, manifest);
    console.log("Recorded audit run:", auditRunId);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
