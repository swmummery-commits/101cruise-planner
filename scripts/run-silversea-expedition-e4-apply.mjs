#!/usr/bin/env node
/**
 * Silversea Expedition Phase E4 — first controlled production batch (250 inserts).
 *
 *   node scripts/run-silversea-expedition-e4-apply.mjs --preflight
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-expedition-e4-apply.mjs \
 *     --apply --confirm=SILVERSEA-EXPEDITION-FIRST-CONTROLLED-BATCH
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/expedition-e3-first-250.json");
const E3_FIXTURE_SHA = "2a9d01e0fe202bbe2ac825760b323b8c3ff6faaa";
const E3_COMMIT_SHA = "9fa73113aa2bdafcd91ce00680ef8990cc6becd4";

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { isClassic, MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  isComboSegmentProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  EXPEDITION_BATCH_SIZE,
  EXPEDITION_FIRST_BATCH_MODE,
  EXPEDITION_APPLY_CONFIRMATION_TOKEN,
  loadFrozenExpeditionIds,
  selectFrozenExpeditionBatch,
  selectExpeditionCompletePool,
  validateAllExpeditionCandidates,
  buildExpeditionPreWriteTableRow,
  computeExpeditionManifestHash,
  evaluateExpeditionPreWriteGate,
  countItinerarySemantics
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const {
  buildExpeditionBatchManifest,
  dryRunExpeditionBatchManifest,
  applyExpeditionBatchWrites,
  buildItineraryPorts,
  buildExpeditionUpsertCandidate,
  indexExistingSilverseaRecords
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
const { DEFAULT_GLOBAL_LEASE_SECONDS, executeControlledProductionApply } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const { buildRollbackManifestFromWriteResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-manifests"
));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE, perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));

export const LINE_SLUG = adapter.LINE_SLUG;

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv = process.argv) {
  const args = { preflight: false, apply: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (args.apply) args.preflight = true;
  if (!args.preflight && !args.apply) args.preflight = true;
  return args;
}

function assertApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== EXPEDITION_APPLY_CONFIRMATION_TOKEN) {
    const err = new Error("expedition_apply_confirmation_required");
    err.code = "expedition_apply_confirmation_required";
    throw err;
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    const err = new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
    err.code = "silversea_discovery_write_disabled";
    throw err;
  }
}

function fixtureProvenanceCheck() {
  const diff = git(`git diff --name-only ${E3_FIXTURE_SHA}..HEAD -- \
    netlify/functions/lib/silversea-expedition-eligibility.js \
    netlify/functions/lib/silversea-expedition-semantics.js \
    netlify/functions/lib/silversea-expedition-endpoint-resolution.js \
    netlify/functions/lib/silversea-expedition-e2c-destination-batch.js \
    netlify/functions/lib/silversea-expedition-e2a-rules-batch.js \
    netlify/functions/lib/public-discovered-cruise-inventory.js`);
  const writeShapeOnly = git(`git diff --name-only ${E3_FIXTURE_SHA}..HEAD -- \
    netlify/functions/lib/silversea-discovery-writes.js \
    netlify/functions/lib/silversea-expedition-controlled-batch.js \
    scripts/run-silversea-expedition-e3-preparation.mjs \
    scripts/run-silversea-expedition-e4-apply.mjs`);
  return {
    fixture_git_sha: E3_FIXTURE_SHA,
    e3_commit_sha: E3_COMMIT_SHA,
    current_sha: git("git rev-parse HEAD"),
    eligibility_semantics_changed: diff.split("\n").filter(Boolean),
    write_shape_and_batch_modules: writeShapeOnly.split("\n").filter(Boolean),
    frozen_fixture_valid_under_current_code:
      diff.split("\n").filter(Boolean).length === 0,
    note: "Only write-shape / controlled-batch support changed since fixture freeze; eligibility unchanged"
  };
}

function countProductionState(rows) {
  const activeOfficial = rows.filter((r) => r.status === "active" && r.official_sailing_id);
  const expeditionOfficial = activeOfficial.filter((r) =>
    /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  const classicOfficial = activeOfficial.filter(
    (r) => !/^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  return {
    total: rows.length,
    active_official: activeOfficial.length,
    classic_official: classicOfficial.length,
    expedition_official: expeditionOfficial.length,
    legacy_hidden: rows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: expeditionOfficial.length
  };
}

async function countExistingOfficialIds(sb, cruiseLineId, officialIds) {
  if (!officialIds?.length) return { count: 0, rows: [] };
  const rows = [];
  for (let i = 0; i < officialIds.length; i += 50) {
    const chunk = officialIds.slice(i, i + 50);
    const quoted = chunk.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        cruiseLineId
      )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id,status`
    );
    if (batch?.length) rows.push(...batch);
  }
  return { count: rows.length, rows };
}

function auditWriteShape(row, cruiseLine, today) {
  const candidate = buildExpeditionUpsertCandidate(row, cruiseLine, today);
  const issues = [];
  if (!candidate) issues.push("upsert_candidate_null");
  const ports = buildItineraryPorts(row);
  for (const stop of row.itinerary || []) {
    if (stop.kind !== "port") continue;
    if (
      stop.expedition_semantic &&
      stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
      stop.port_resolution?.canonicalPortName &&
      ports.includes(stop.port_resolution.canonicalPortName)
    ) {
      issues.push(`semantic_leak:${stop.port_code || stop.port_name}`);
    }
  }
  return { ok: issues.length === 0, issues, ports, candidate };
}

function kgiLogisticsCount(rows) {
  let count = 0;
  for (const row of rows) {
    const codes = [
      row.departure_port_resolution?.sourceCode,
      row.departure_port_resolution?.portCode,
      row.arrival_port_resolution?.sourceCode,
      row.arrival_port_resolution?.portCode
    ]
      .map((c) => String(c || "").toUpperCase())
      .filter(Boolean);
    const names = [row.raw?.departure_port, row.raw?.arrival_port].join(" ");
    if (
      codes.some((c) => c === "AQKGG" || c === "AQKGI") ||
      /king george island/i.test(names)
    ) {
      count += 1;
    }
  }
  return count;
}

function verifyKgiPayloads(rows, cruiseLine, today) {
  const issues = [];
  for (const row of rows) {
    const hasKgi =
      row.departure_port_resolution?.expedition_logistics_gateway ||
      row.arrival_port_resolution?.expedition_logistics_gateway;
    if (!hasKgi) continue;
    const candidate = buildExpeditionUpsertCandidate(row, cruiseLine, today);
    const ports = buildItineraryPorts(row);
    if (/king george island/i.test(ports.join(" "))) {
      issues.push({ id: row.official_sailing_id, issue: "kgi_in_itinerary_ports" });
    }
    if (!candidate?.raw_extract?.expedition_endpoint_embark && !candidate?.raw_extract?.expedition_endpoint_disembark) {
      issues.push({ id: row.official_sailing_id, issue: "kgi_metadata_missing" });
    }
  }
  return { ok: issues.length === 0, issues };
}

async function verifyInsertedExpeditionRecords(sb, lineId, writeDetails, manifestProducts, selectedRows, cruiseLine, today) {
  const insertedIds = (writeDetails || [])
    .filter((d) => d.created && d.discovered_cruise_id)
    .map((d) => d.discovered_cruise_id);
  if (insertedIds.length !== EXPEDITION_BATCH_SIZE) {
    return { ok: false, reason: `expected_${EXPEDITION_BATCH_SIZE}_inserted_got_${insertedIds.length}` };
  }

  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,itinerary_ports,status,official_url,source_url,official_sailing_id,raw_extract";
  const rows = await sb(`discovered_cruises?id=in.(${insertedIds.join(",")})&select=${select}`);
  const byOfficial = new Map((rows || []).map((r) => [String(r.official_sailing_id).toUpperCase(), r]));
  const manifestById = new Map((manifestProducts || []).map((m) => [m.official_sailing_id, m]));
  const sourceById = new Map((selectedRows || []).map((r) => [String(r.official_sailing_id).toUpperCase(), r]));

  const checks = [];
  let allOk = true;
  let semanticOk = true;

  for (const detail of writeDetails.filter((d) => d.created)) {
    const row = byOfficial.get(String(detail.official_sailing_id).toUpperCase());
    const manifest = manifestById.get(detail.official_sailing_id);
    const source = sourceById.get(String(detail.official_sailing_id).toUpperCase());
    const issues = [];
    if (!row) issues.push("missing_from_production");
    if (row?.cruise_line_id !== lineId) issues.push("wrong_cruise_line");
    if (row?.official_sailing_id !== detail.official_sailing_id) issues.push("wrong_official_sailing_id");
    if (row?.status !== "active") issues.push(`unexpected_status:${row?.status}`);
    if (manifest?.candidate) {
      if (row?.ship_id !== manifest.candidate.ship_id) issues.push("ship_mismatch");
      if (row?.departure_date !== manifest.candidate.departure_date) issues.push("departure_mismatch");
      if (row?.return_date !== manifest.candidate.return_date) issues.push("return_mismatch");
      if (row?.nights !== manifest.candidate.nights) issues.push("nights_mismatch");
      if (row?.destination_id !== manifest.candidate.destination_id) issues.push("destination_mismatch");
    }
    const expectedPorts = source ? buildItineraryPorts(source) : [];
    const actualPorts = row?.itinerary_ports || [];
    if (JSON.stringify(expectedPorts) !== JSON.stringify(actualPorts)) {
      issues.push("itinerary_ports_mismatch");
    }
    if (!row?.raw_extract?.silversea_expedition_controlled_batch) {
      issues.push("missing_expedition_raw_extract_flag");
    }
    if (source) {
      for (const stop of source.itinerary || []) {
        if (stop.kind !== "port") continue;
        if (
          stop.expedition_semantic &&
          stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
          stop.port_resolution?.canonicalPortName &&
          actualPorts.includes(stop.port_resolution.canonicalPortName)
        ) {
          issues.push("semantic_leak_in_production_ports");
          semanticOk = false;
        }
      }
    }
    if (issues.length) allOk = false;
    checks.push({
      discovered_cruise_id: detail.discovered_cruise_id,
      official_sailing_id: detail.official_sailing_id,
      ok: issues.length === 0,
      issues
    });
  }

  const officialIds = (rows || []).map((r) => r.official_sailing_id).filter(Boolean);
  const duplicateOfficialIds = officialIds.length !== new Set(officialIds).size;

  return {
    ok: allOk && !duplicateOfficialIds && checks.length === EXPEDITION_BATCH_SIZE,
    semantic_write_shape_verified: semanticOk,
    duplicate_official_sailing_id: duplicateOfficialIds,
    verified_count: checks.filter((c) => c.ok).length,
    failed_count: checks.filter((c) => !c.ok).length,
    records: checks
  };
}

async function headLineCount(lineId, statusFilter = null) {
  let query = `cruise_line_id=eq.${encodeURIComponent(lineId)}`;
  if (statusFilter) query += `&status=eq.${statusFilter}`;
  const { count } = await exactCountSupabase(root, "discovered_cruises", query);
  return count;
}

async function headOtherLineCounts(sb) {
  const slugs = [
    "royal-caribbean-international",
    "celebrity-cruises",
    "princess-cruises",
    "seabourn-cruise-line",
    "norwegian-cruise-line",
    "azamara"
  ];
  const out = {};
  for (const slug of slugs) {
    const line = (await sb(`ci_cruise_lines?slug=eq.${slug}&select=id&limit=1`))?.[0];
    if (!line?.id) continue;
    out[slug] = await headLineCount(line.id, "active");
  }
  return out;
}

function snapshotOfficialRows(rows) {
  return rows
    .filter((r) => r.official_sailing_id)
    .map((r) => ({
      id: r.id,
      official_sailing_id: r.official_sailing_id,
      status: r.status,
      departure_date: r.departure_date,
      ship_id: r.ship_id
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export async function runSilverseaExpeditionE4(options = {}) {
  const args = options.args || parseArgs();
  assertApplyAllowed(args);
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const modeGate = resolveSilverseaDiscoveryMode(args.apply ? "production_write" : "production_read_only");
  const sb = createMaintenanceSupabase(root);
  const provenance = fixtureProvenanceCheck();

  if (!provenance.frozen_fixture_valid_under_current_code) {
    throw new Error("fixture_invalid_under_current_code — STOP WITH ZERO WRITES");
  }

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`fixture_not_found:${FIXTURE_PATH}`);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const frozenIds = loadFrozenExpeditionIds(fixture);
  if (frozenIds.length !== EXPEDITION_BATCH_SIZE || new Set(frozenIds).size !== EXPEDITION_BATCH_SIZE) {
    throw new Error(`fixture_count_invalid:${frozenIds.length} — STOP WITH ZERO WRITES`);
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);
  const destinations = adapter.catalogueDestinations(
    await loadClassificationDestinations(async (q) => sb(q))
  );
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const existingRows = indexed.rows;
  const existingByOfficialId = indexed.byOfficialId;

  const productionBefore = countProductionState(existingRows);
  if (productionBefore.recognised_expedition > 0) {
    throw new Error("expedition_ids_already_present — STOP WITH ZERO WRITES");
  }

  const legacyBefore = existingRows
    .filter((r) => !r.official_sailing_id)
    .map((r) => ({
      id: r.id,
      status: r.status,
      official_sailing_id: r.official_sailing_id,
      review_reason: r.review_reason
    }));
  const officialSnapshotBefore = snapshotOfficialRows(existingRows);

  const countsBefore = {
    silversea_total: await headLineCount(line.id),
    silversea_active: await headLineCount(line.id, "active"),
    other_lines_active: await headOtherLineCounts(sb)
  };

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });
  const sourceHealthOk = simulation.ok === true && simulation.health?.ok === true;
  if (!sourceHealthOk) {
    throw new Error("source_health_failed — STOP WITH ZERO WRITES");
  }

  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );

  const selection = selectFrozenExpeditionBatch(expRows, frozenIds, {
    today,
    existingByOfficialId
  });
  if (!selection.exact_frozen_set_match) {
    throw new Error(
      `frozen_set_no_longer_eligible missing=${selection.missing.length} ineligible=${selection.no_longer_eligible.length} — STOP WITH ZERO WRITES`
    );
  }

  const revalidation = validateAllExpeditionCandidates(selection.selected, today, existingByOfficialId);
  if (!revalidation.ok) {
    throw new Error(`revalidation_failed:${revalidation.failed.length} — STOP WITH ZERO WRITES`);
  }

  const preWriteTable = selection.selected.map((row, i) => ({
    ...buildExpeditionPreWriteTableRow(i + 1, row, today),
    proposed_action: "INSERT"
  }));
  const cutoffViolations = preWriteTable.filter(
    (r) => r.days_until_departure != null && r.days_until_departure < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
  );
  if (cutoffViolations.length > 0) {
    throw new Error(`cutoff_violations:${cutoffViolations.length} — STOP WITH ZERO WRITES`);
  }

  const existingOfficialBefore = await countExistingOfficialIds(sb, line.id, frozenIds);
  if (existingOfficialBefore.count > 0) {
    throw new Error(`selected_ids_already_present:${existingOfficialBefore.count} — STOP WITH ZERO WRITES`);
  }

  const writeShapeResults = selection.selected.map((row) => auditWriteShape(row, line, today));
  if (!writeShapeResults.every((r) => r.ok)) {
    throw new Error("write_shape_invalid — STOP WITH ZERO WRITES");
  }

  const kgiCount = kgiLogisticsCount(selection.selected);
  const kgiVerify = verifyKgiPayloads(selection.selected, line, today);

  const comboCount = selection.selected.filter((r) => isComboSegmentProduct(r.raw)).length;
  const comboIds = new Set(selection.selected.map((r) => String(r.official_sailing_id).toUpperCase()));
  const comboSafe = comboIds.size === selection.selected.length;

  const runId = options.runId || `silversea-expedition-e4-${startedAt.replace(/[:.]/g, "-")}`;
  const manifest = await buildExpeditionBatchManifest({
    selectedProducts: selection.selected,
    cruiseLine: line,
    destinations,
    supabase: sb,
    runId,
    today,
    existingByOfficialId
  });
  manifest.manifest_hash = computeExpeditionManifestHash(manifest);
  const dryRun = dryRunExpeditionBatchManifest(manifest);

  const preWriteGate = evaluateExpeditionPreWriteGate({
    completePoolCount: fixture.complete_pool_count || EXPEDITION_BATCH_SIZE,
    selection,
    proposedInserts: dryRun.proposed_inserts,
    proposedUpdates: dryRun.proposed_updates,
    revalidation,
    sourceHealthOk,
    expectedCount: EXPEDITION_BATCH_SIZE,
    existingSelectedOfficialIds: existingOfficialBefore.count
  });

  if (
    !preWriteGate.passed ||
    dryRun.proposed_inserts !== EXPEDITION_BATCH_SIZE ||
    dryRun.proposed_updates !== 0
  ) {
    const blocked = {
      phase: "preflight_blocked",
      run_id: runId,
      pre_write_gate: preWriteGate,
      dry_run: dryRun,
      provenance,
      production_before: productionBefore
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `silversea-expedition-e4-${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(blocked, null, 2)}\n`);
    return { ...blocked, report_path: reportPath, blocked: true };
  }

  let writeResult = null;
  let globalLockReport = null;
  let rollbackManifest = null;
  let underLockRecheck = null;

  if (args.apply) {
    assertSilverseaWritesAllowed(modeGate);
    const applyStarted = Date.now();
    const protectedApply = await executeControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: LINE_SLUG,
        operation: EXPEDITION_FIRST_BATCH_MODE,
        performWrites: true,
        leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
        underLockRecheck: async () => {
          const existingUnderLock = await countExistingOfficialIds(sb, line.id, frozenIds);
          underLockRecheck = {
            selected_ids_present: existingUnderLock.count,
            proposed_inserts: dryRun.proposed_inserts,
            proposed_updates: dryRun.proposed_updates
          };
          if (existingUnderLock.count > 0) {
            return { ok: false, reason: "under_lock_selected_official_ids_already_present" };
          }
          if (dryRun.proposed_inserts !== EXPEDITION_BATCH_SIZE || dryRun.proposed_updates !== 0) {
            return { ok: false, reason: "under_lock_write_count_invalid" };
          }
          return { ok: true };
        }
      },
      async () =>
        applyExpeditionBatchWrites({
          selectedProducts: selection.selected,
          cruiseLine: line,
          runId,
          supabase: sb,
          today,
          existingByOfficialId,
          performWrites: true,
          maxWrites: EXPEDITION_BATCH_SIZE,
          mode: EXPEDITION_FIRST_BATCH_MODE
        })
    );

    globalLockReport = protectedApply.global_lock;

    if (protectedApply.blocked) {
      const blocked = {
        phase: "apply_blocked",
        run_id: runId,
        reason: protectedApply.reason,
        global_lock: globalLockReport,
        under_lock_recheck: underLockRecheck
      };
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const reportPath = path.join(REPORT_DIR, `silversea-expedition-e4-${runId}.json`);
      fs.writeFileSync(reportPath, `${JSON.stringify(blocked, null, 2)}\n`);
      return { ...blocked, report_path: reportPath, blocked: true };
    }

    writeResult = protectedApply.writeResult;
    const applyElapsedMs = Date.now() - applyStarted;

    if (writeResult.stats.failed > 0) {
      throw new Error(`partial_write_failure: inserted=${writeResult.stats.inserted} failed=${writeResult.stats.failed}`);
    }
    if (writeResult.stats.inserted !== EXPEDITION_BATCH_SIZE) {
      throw new Error(`insert_count_mismatch:${writeResult.stats.inserted} !== ${EXPEDITION_BATCH_SIZE}`);
    }
    if (writeResult.stats.updated > 0) {
      throw new Error(`unexpected_updates:${writeResult.stats.updated}`);
    }
    if (
      writeResult.stats.attempted !==
      writeResult.stats.inserted + writeResult.stats.duplicate_skips + writeResult.stats.invalid_skips + writeResult.stats.failed
    ) {
      throw new Error("count_reconciliation_failed");
    }

    rollbackManifest = buildRollbackManifestFromWriteResult({
      runId,
      cruiseLineId: line.id,
      lineSlug: LINE_SLUG,
      triggerType: EXPEDITION_FIRST_BATCH_MODE,
      writeResult,
      frozenFixturePath: "scripts/fixtures/silversea/expedition-e3-first-250.json",
      expectedInserts: EXPEDITION_BATCH_SIZE
    });
  }

  const indexedAfter = args.apply ? await indexExistingSilverseaRecords(sb, line.id) : indexed;
  const productionAfter = args.apply ? countProductionState(indexedAfter.rows) : productionBefore;
  const countsAfter = args.apply
    ? {
        silversea_total: await headLineCount(line.id),
        silversea_active: await headLineCount(line.id, "active"),
        other_lines_active: await headOtherLineCounts(sb)
      }
    : countsBefore;

  const legacyAfter = args.apply
    ? indexedAfter.rows
        .filter((r) => !r.official_sailing_id)
        .map((r) => ({
          id: r.id,
          status: r.status,
          official_sailing_id: r.official_sailing_id,
          review_reason: r.review_reason
        }))
    : legacyBefore;

  const officialSnapshotAfter = args.apply ? snapshotOfficialRows(indexedAfter.rows) : officialSnapshotBefore;
  const previousOfficialUnchanged = args.apply
    ? (() => {
        const afterById = new Map(officialSnapshotAfter.map((r) => [r.id, r]));
        return officialSnapshotBefore.every((row) => {
          const current = afterById.get(row.id);
          return current && JSON.stringify(row) === JSON.stringify(current);
        });
      })()
    : true;

  const verification = args.apply
    ? await verifyInsertedExpeditionRecords(
        sb,
        line.id,
        writeResult.stats.write_details,
        manifest.products,
        selection.selected,
        line,
        today
      )
    : null;

  const duplicateCheck = args.apply
    ? await countExistingOfficialIds(sb, line.id, frozenIds)
    : existingOfficialBefore;

  let postApplySnapshot = null;
  if (args.apply) {
    const completePool = selectExpeditionCompletePool(expRows, { today, existingByOfficialId: indexedAfter.byOfficialId });
    const inProduction = completePool.eligible_ids.filter((id) =>
      indexedAfter.byOfficialId.has(String(id).toUpperCase())
    );
    const notInProduction = completePool.eligible_ids.filter(
      (id) => !indexedAfter.byOfficialId.has(String(id).toUpperCase())
    );
    postApplySnapshot = {
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: expRows.filter((r) => {
        const b = classifyExpeditionExclusiveBucket(r, today);
        return b !== "within_21_day_cutoff" && b !== "invalid_identity";
      }).length,
      recognised_expedition_production_ids: productionAfter.recognised_expedition,
      complete_in_production: inProduction.length,
      complete_not_in_production: notInProduction.length,
      remaining_new_complete_ids: notInProduction,
      duration_mismatch: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "duration_mismatch"
      ).length,
      ambiguous_blocked: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "ambiguous_semantic_itinerary"
      ).length
    };
  }

  const report = {
    phase: args.apply ? "e4_apply" : "e4_preflight",
    run_id: runId,
    fixture_path: "scripts/fixtures/silversea/expedition-e3-first-250.json",
    frozen_count: frozenIds.length,
    frozen_unique_count: new Set(frozenIds).size,
    provenance,
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: expRows.filter((r) => {
        const b = classifyExpeditionExclusiveBucket(r, today);
        return b !== "within_21_day_cutoff" && b !== "invalid_identity";
      }).length,
      source_health: sourceHealthOk ? "PASS" : "FAIL"
    },
    frozen_revalidation: revalidation,
    cutoff: {
      earliest_departure: preWriteTable[0]?.departure,
      minimum_days_to_departure: Math.min(...preWriteTable.map((r) => r.days_until_departure).filter((d) => d != null)),
      violations: cutoffViolations.length
    },
    production_before: productionBefore,
    production_after: productionAfter,
    selected_ids_already_present_before: existingOfficialBefore.count,
    dry_run: dryRun,
    pre_write_gate: preWriteGate,
    pre_write_table: preWriteTable,
    write_shape_all_verified: writeShapeResults.every((r) => r.ok),
    kgi_logistics_voyage_count: kgiCount,
    kgi_payload_verification: kgiVerify.ok ? "PASS" : "FAIL",
    combo_segment_count: comboCount,
    combo_identity_safe: comboSafe,
    global_lock_path: "controlled_production_import:global",
    lease_seconds: DEFAULT_GLOBAL_LEASE_SECONDS,
    lease_sufficient: true,
    global_lock: globalLockReport,
    under_lock_recheck: underLockRecheck,
    write_result: writeResult,
    verification,
    duplicate_check_after: duplicateCheck,
    counts_before: countsBefore,
    counts_after: countsAfter,
    row_delta: args.apply ? countsAfter.silversea_total - countsBefore.silversea_total : 0,
    legacy_before: legacyBefore,
    legacy_after: legacyAfter,
    legacy_8_unchanged: JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter),
    previous_official_unchanged: previousOfficialUnchanged,
    cross_line_active_delta: args.apply
      ? Object.fromEntries(
          Object.entries(countsBefore.other_lines_active).map(([slug, before]) => [
            slug,
            (countsAfter.other_lines_active[slug] || 0) - before
          ])
        )
      : null,
    post_apply_snapshot: postApplySnapshot,
    weekly_maintenance: "NOT ENABLED",
    production_writes: {
      inserts: writeResult?.stats?.inserted || 0,
      updates: writeResult?.stats?.updated || 0,
      deletes: 0
    },
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: { branch: git("git rev-parse --abbrev-ref HEAD"), sha: git("git rev-parse HEAD") }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e4-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;

  if (rollbackManifest) {
    const rollbackPath = path.join(REPORT_DIR, `silversea-expedition-e4-rollback-${runId}.json`);
    fs.writeFileSync(rollbackPath, `${JSON.stringify(rollbackManifest, null, 2)}\n`);
    report.rollback_manifest_path = rollbackPath;
  }

  return report;
}

async function main() {
  try {
    const report = await runSilverseaExpeditionE4();
    console.log(JSON.stringify({ ok: !report.blocked, phase: report.phase, report: report.report_path }, null, 2));
    if (report.blocked) process.exit(1);
    if (report.verification && !report.verification.ok) process.exit(1);
    if (report.phase === "e4_apply" && report.production_writes.inserts !== EXPEDITION_BATCH_SIZE) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message, code: err.code }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
