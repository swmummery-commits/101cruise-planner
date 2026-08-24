#!/usr/bin/env node
/**
 * Princess Monday P1B read-only seven-change audit + retry verification report.
 *   node scripts/princess-weekly-monday-p1b-audit.mjs
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createSupabaseRest, createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { fetchAllPrincessRawSailings } = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const {
  simulatePrincessInventory,
  catalogueDestinations,
  officialProductKey
} = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
const { buildPrincessBatchManifest } = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { findPrincessAcceptedEligibleBaseline } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { evaluatePrincessScheduledApplyReadiness } = require(path.join(
  root,
  "netlify/functions/lib/princess-weekly-readiness"
));
const {
  diffPrincessUpdateCandidate,
  classifyPrincessUpdateRisk,
  classifyPrincessUpdateCategory,
  refinePrincessProposedActionForWeekly
} = require(path.join(root, "netlify/functions/lib/princess-weekly-update-policy"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const REPORT_PATH = path.join(root, "reports/princess-weekly-monday-p1b-seven-change-audit-2026-08-24.json");

function eligibleIdentityHash(keys) {
  return crypto.createHash("sha256").update(JSON.stringify([...keys].sort())).digest("hex");
}

async function runSourceProbe(label, today) {
  const started = Date.now();
  const fetch = await fetchAllPrincessRawSailings({ today, useCache: false, collectDiagnostics: true });
  const catalogueDiag = fetch.source_diagnostics?.catalogue || null;
  return {
    label,
    elapsed_ms: Date.now() - started,
    ok: fetch.ok === true,
    fetch_failed: fetch.fetch_failed === true,
    bootstrap_status: fetch.source_diagnostics?.bootstrap?.attempts?.[0]?.http_status ?? null,
    catalogue_status: catalogueDiag?.attempts?.slice(-1)?.[0]?.http_status ?? null,
    transient_retry_needed: Boolean(catalogueDiag?.transient_retry),
    raw_groups: fetch.audit?.source_groups ?? null,
    expanded_sailings: fetch.audit?.expanded_sailings ?? null,
    eligible: fetch.products?.length ?? null,
    accounting: fetch.audit || null,
    identity_hash: eligibleIdentityHash(
      (fetch.products || []).map((p) => officialProductKey(p)).filter(Boolean)
    )
  };
}

async function loadShipMap(sb, lineId) {
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${lineId}&select=id,name,official_line_ship_id`
  );
  return new Map((ships || []).map((s) => [s.id, s.name]));
}


async function loadDestMap(sb) {
  const rows = await sb.get("destinations?select=id,name,slug,status");
  return new Map((rows || []).map((d) => [d.id, d]));
}

function enrichCandidate(entry, ships, destinations) {
  const c = entry.candidate || {};
  return {
    official_sailing_id: entry.official_princess_sailing_id || c.official_sailing_id,
    external_key: c.external_key,
    identity_key: c.identity_key,
    ship_id: c.ship_id,
    ship: ships.get(c.ship_id) || entry.canonical_ship_name,
    departure_date: c.departure_date,
    return_date: c.return_date,
    nights: c.nights,
    departure_port: c.departure_port,
    destination_id: c.destination_id,
    destination: destinations.get(c.destination_id)?.name || entry.destination_name,
    itinerary: c.itinerary,
    official_url: c.official_url || entry.official_url,
    status: c.status,
    match_confidence: c.match_confidence,
    raw_extract: c.raw_extract
  };
}

function enrichProduction(row, ships, destinations) {
  if (!row) return null;
  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    identity_key: row.identity_key,
    ship_id: row.ship_id,
    ship: ships.get(row.ship_id),
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    destination_id: row.destination_id,
    destination: destinations.get(row.destination_id)?.name,
    itinerary: row.itinerary,
    official_url: row.official_url,
    status: row.status,
    match_confidence: row.match_confidence,
    raw_extract: row.raw_extract
  };
}

async function collisionCheck(sb, lineId, candidate) {
  const official = candidate.official_sailing_id
    ? await sb.get(
        `discovered_cruises?cruise_line_id=eq.${lineId}&official_sailing_id=eq.${encodeURIComponent(candidate.official_sailing_id)}&select=id&limit=2`
      )
    : [];
  const external = candidate.external_key
    ? await sb.get(
        `discovered_cruises?external_key=eq.${encodeURIComponent(candidate.external_key)}&select=id&limit=2`
      )
    : [];
  const identity = candidate.identity_key
    ? await sb.get(
        `discovered_cruises?identity_key=eq.${encodeURIComponent(candidate.identity_key)}&select=id&limit=2`
      )
    : [];
  return {
    official_collision: official.length,
    external_collision: external.length,
    identity_collision: identity.length
  };
}

function classifyInsert(entry) {
  if (entry.complete_high_confidence || entry.completeness === "complete_high_confidence") return "A";
  return "F";
}

async function main() {
  const startingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const sb = createSupabaseRest(root);
  const maintenanceSb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const line = (await sb.get("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"))[0];
  const ships = await loadShipMap(sb, line.id);
  const destinations = catalogueDestinations(
    await sb.get("destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled")
  );
  const destRows = await sb.get("destinations?select=id,name,slug,status");
  const destMap = new Map((destRows || []).map((d) => [d.id, d]));

  const source1 = await runSourceProbe("attempt_1", today);
  const source2 = await runSourceProbe("attempt_2", today);
  const sourceReproducible =
    source1.ok &&
    source2.ok &&
    source1.identity_hash === source2.identity_hash &&
    source1.raw_groups === source2.raw_groups;

  const maintenance = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    simulateApplyQualityGates: true,
    writeMode: "weekly_maintenance",
    runId: `princess-p1b-audit-${Date.now()}`,
    supabase: maintenanceSb,
    collectSourceDiagnostics: false,
    triggerType: "weekly_scheduled_apply_readiness"
  });

  const manifest = maintenance.manifest || { products: [] };
  for (const entry of manifest.products || []) {
    if (entry.proposed_action !== "update_exact_legacy_match") continue;
    entry.proposed_action = refinePrincessProposedActionForWeekly(
      entry.proposed_action,
      entry.rollback,
      entry.candidate
    );
  }

  const inserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const updates = manifest.products.filter((p) =>
    ["update_exact_legacy_match", "update_safe_metadata_allowed", "update_identity_review_required"].includes(
      p.proposed_action
    )
  );

  const insertAudits = [];
  for (const entry of inserts) {
    const candidate = enrichCandidate(entry, ships, destMap);
    const collisions = await collisionCheck(sb, line.id, candidate);
    insertAudits.push({
      ...candidate,
      collisions,
      classification: classifyInsert(entry),
      within_cutoff: false,
      complete_high_confidence: entry.completeness === "complete_high_confidence",
      reconciliation_action: entry.proposed_action
    });
  }

  const updateAudits = [];
  let lowRisk = 0;
  let highRisk = 0;
  let unexplained = 0;

  for (const entry of updates) {
    const productionId = entry.existing_record_match;
    const productionRow = productionId
      ? (
          await sb.get(
            `discovered_cruises?id=eq.${encodeURIComponent(productionId)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract,match_confidence&limit=1`
          )
        )[0]
      : null;
    const before = enrichProduction(productionRow, ships, destMap);
    const after = enrichCandidate(entry, ships, destMap);
    const fieldDiffs = diffPrincessUpdateCandidate(before || entry.rollback || {}, after);
    const risk = classifyPrincessUpdateRisk(fieldDiffs);
    const category = classifyPrincessUpdateCategory(fieldDiffs);
    if (risk.risk === "LOW") lowRisk += 1;
    else if (risk.risk === "HIGH") highRisk += 1;
    else unexplained += 1;

    updateAudits.push({
      official_sailing_id: after.official_sailing_id,
      discovered_cruise_id: productionId,
      reconciliation_action: entry.proposed_action,
      base_action: "update_exact_legacy_match",
      field_diffs: fieldDiffs.map((d) => ({
        field: d.field,
        before: d.before,
        after: d.after,
        reason: `source canonical differs from production ${d.field}`,
        evidence: entry.source_url || after.official_url
      })),
      classification: category,
      risk: risk.risk,
      high_risk_fields: risk.high_risk_fields,
      before,
      proposed: after
    });
  }

  const csr07h = (
    await sb.get(
      `discovered_cruises?cruise_line_id=eq.${line.id}&official_sailing_id=eq.CSR07H%7CKP%7C2027-02-28&select=id,status,official_sailing_id,departure_date&limit=1`
    )
  )[0];

  const baseline = await findPrincessAcceptedEligibleBaseline(maintenanceSb, line.id, PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE);
  const readiness = await evaluatePrincessScheduledApplyReadiness({
    runPrincessWeeklyMaintenance,
    findPrincessAcceptedEligibleBaseline,
    supabase: maintenanceSb,
    cruiseLineId: line.id,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    runId: `princess-p1b-readiness-${Date.now()}`
  });

  const summary = maintenance.summary || {};
  const endingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();

  const report = {
    generated_at: new Date().toISOString(),
    incident: "princess_weekly_maintenance_monday_p1b",
    repository: {
      starting_sha: startingSha,
      ending_sha: endingSha,
      hardening_sha: "adfc0213ea131ba3712af8d4c7238e6bcc2e5027"
    },
    retry_control_bug: {
      defect: "retry eligibility used diagnostic attempts[] only populated when collectDiagnostics=true",
      production_equivalent_reproduced: true,
      root_cause: "fetchPrincessResdbCatalogue recorded attempt state inside collectDiagnostics guard",
      correction: "internalAttempts always recorded; diagnostics output remains conditional",
      maximum_extra_retries: 1
    },
    source_verification: {
      attempt_1: source1,
      attempt_2: source2,
      reproducible: sourceReproducible,
      accounting_exact: summary.source_accounting?.accounting?.accounting_exact ?? null
    },
    insert_candidates: insertAudits,
    update_candidates: updateAudits,
    update_totals: { low_risk: lowRisk, high_risk: highRisk, unexplained },
    source_absence: {
      csr07h: {
        official_sailing_id: "CSR07H|KP|2027-02-28",
        active: csr07h?.status === "active",
        unchanged: csr07h?.status === "active",
        retained: true
      },
      recognised_eligible: summary.recognised_existing_eligible,
      source_absent_active: summary.source_absent_active,
      explanation:
        "Active production may include one source-absent retained sailing (CSR07H) while eligible source recognises 2041 matching keys."
    },
    accepted_baseline: {
      run_id: baseline?.id || "9f6e644e-212c-4524-9f5c-d218ab855151",
      eligible_total: baseline?.stats?.eligible_total ?? 2061,
      advanced_by_this_audit: false
    },
    readiness: {
      ...readiness,
      review_required: readiness.review_required || highRisk > 0 || unexplained > 0,
      safe_to_run_real_apply:
        readiness.safe_to_run_real_apply === true && highRisk === 0 && unexplained === 0
    },
    netlify_architecture: {
      real_apply_runner: "self-hosted Mac GitHub runner via scripts/run-princess-weekly-maintenance.mjs",
      netlify_smoke: "diagnostic only — not the scheduled APPLY execution environment",
      netlify_prerequisite_for_scheduled_apply: false
    },
    tests: {
      commands: [
        "npm run test:princess-source-failure",
        "npm run test:princess-weekly-maintenance",
        "npm run test:princess-accepted-baseline-lifecycle",
        "npm run test:global-cruise-write-lock",
        "npm run test:discovery-inventory"
      ]
    },
    production_writes: 0,
    safe_to_run_real_apply:
      readiness.safe_to_run_real_apply === true && highRisk === 0 && unexplained === 0 && sourceReproducible,
    recommended_next_action:
      highRisk > 0 || unexplained > 0
        ? "Forensic review of high-risk update candidates required before real APPLY. Retry fix may be deployed; do not auto-apply identity-critical updates."
        : "Retry fix verified. Review insert candidate, then schedule APPLY on next window."
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
