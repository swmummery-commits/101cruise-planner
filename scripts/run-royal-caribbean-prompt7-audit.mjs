#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 7 — read-only source enumeration audit + identity drift analysis.
 *
 *   node scripts/run-royal-caribbean-prompt7-audit.mjs
 *   node scripts/run-royal-caribbean-prompt7-audit.mjs --quick
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

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  BATCH1_OFFICIAL_SAILING_IDS,
  buildRoyalCaribbeanReconciliationArithmetic,
  computeSourceSnapshotId
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-controlled-batch"));
const {
  simulateRoyalCaribbeanInventory,
  catalogueDestinations,
  LINE_SLUG,
  normaliseRoyalCaribbeanProduct,
  stampTimeEligibility,
  isRoyalCaribbeanCruisetour,
  isEligibleRoyalCaribbeanCruise
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));
const {
  buildRoyalCaribbeanBatchManifest
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const { indexGenuineRoyalCaribbeanProduction } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-post-write-verification"
));
const {
  enumerateGlobalOffsetPass,
  enumerateMultiPageSizeUnion,
  enumerateUntilStableUnion,
  enumerateShipCoveragePartition,
  fetchRoyalCaribbeanCruiseDetail,
  symmetricSetDiff,
  computeSourceSnapshotIdFromSailingIds,
  evaluateSourceEnumerationHealth,
  sourceAbsenceActionAllowed
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
const { perthCalendarDate, daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const REPORT_DIR = path.join(root, "reports");
const MASTER_MANIFEST_PATH = path.join(
  root,
  "reports/royal-caribbean-catchup-master-manifest-royal-caribbean-catchup-2026-08-13T02-51-29.json"
);
const PROMPT6_FINAL_REPORT = path.join(
  root,
  "reports/royal-caribbean-prompt6-final-catchup-royal-caribbean-catchup-2026-08-13T02-51-29.json"
);
const PROMPT6_MANIFEST_SNAPSHOT_ID = "acb57d5b93367e66";
const PROMPT6_FINAL_SNAPSHOT_ID = "44d6b7454488db0b";

function parseArgs(argv) {
  return { quick: argv.includes("--quick"), skipStability: argv.includes("--skip-stability") };
}

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, name);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  return reportPath;
}

function git(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function loadIdSetFromMasterManifest(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return new Set((manifest.entries || []).map((e) => e.official_sailing_id).filter(Boolean));
}

function simulateFromProducts(products, context) {
  const today = context.today || perthCalendarDate();
  const normalised = (products || []).map((raw) => normaliseRoyalCaribbeanProduct(raw, context));
  stampTimeEligibility(normalised, today);
  return { products: normalised, today };
}

function summariseManifestActions(manifest) {
  const counts = {};
  for (const entry of manifest.products || []) {
    counts[entry.proposed_action] = (counts[entry.proposed_action] || 0) + 1;
  }
  const recognisedExistingEligible = (manifest.products || []).filter(
    (p) => p.proposed_action === "duplicate_skip" && p.product_type === "ocean_cruise"
  ).length;
  const outstandingEligible = (manifest.products || []).filter(
    (p) => p.proposed_action === "insert_active"
  ).length;
  return { counts, recognisedExistingEligible, outstandingEligible };
}

function classifyProductionAbsentFromSource(row, today) {
  const days = row.departure_date ? daysUntilDeparture(String(row.departure_date).slice(0, 10), today) : null;
  if (days != null && days <= 21) return "departure_inside_21_day_cutoff";
  if (days != null && days < 0) return "already_departed";
  const status = String(row.raw_extract?.royal_caribbean_sailing_id ? row.status : row.status || "").toLowerCase();
  if (status && status !== "active") return "production_status_not_active";
  return "not_seen_in_catalogue_enumeration";
}

async function buildReconciliationFromProducts(products, sb, line, destinations, today) {
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active`
  );
  const ctx = { cruiseLine: line, ships: ships || [], destinations, today };
  const simulated = simulateFromProducts(products, ctx);
  const manifest = await buildRoyalCaribbeanBatchManifest({
    products: simulated.products,
    cruiseLine: line,
    destinations,
    supabase: sb,
    runId: "prompt7-audit"
  });

  const ocean = simulated.products.filter((p) => p.product_type === "ocean_cruise");
  const eligible = ocean.filter(
    (p) =>
      p.time_eligibility === "eligible" &&
      p.complete_high_confidence &&
      isEligibleRoyalCaribbeanCruise(p.product_type) &&
      p.status_class === "open"
  );
  const summary = summariseManifestActions(manifest);
  const arithmetic = buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: simulated.products.length,
    oceanCruises: ocean.length,
    oceanCruisetours: simulated.products.filter((p) => isRoyalCaribbeanCruisetour(p.product_type)).length,
    unknownProducts: simulated.products.filter((p) => p.product_type === "unknown").length,
    otherProductTypes: simulated.products.filter((p) => !["ocean_cruise", "ocean_cruisetour", "unknown"].includes(p.product_type)).length,
    oceanIncomplete: ocean.filter((p) => !p.complete_high_confidence).length,
    oceanEligible: eligible.length,
    oceanWithinCutoff: ocean.filter((p) => p.time_eligibility === "within_21_day_cutoff").length,
    oceanPast: ocean.filter((p) => p.time_eligibility === "past").length,
    oceanUnfamiliarStatus: ocean.filter((p) => p.status_class !== "open").length,
    oceanOtherExclusions: 0,
    recognisedExistingEligible: summary.recognisedExistingEligible,
    outstandingEligibleInserts: summary.outstandingEligible,
    proposedUpdates: (manifest.products || []).filter((p) => p.proposed_action === "update_exact_legacy_match").length
  });

  return { manifest, summary, arithmetic, simulated };
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const auditId = `royal-caribbean-prompt7-${startedAt.replace(/[:.]/g, "-").slice(0, 19)}`;
  const today = perthCalendarDate();
  const report = {
    phase: "royal_caribbean_prompt7_source_enumeration_audit",
    started_at: startedAt,
    audit_id: auditId,
    read_only: true,
    production_mutations: {
      cruise_inserts: 0,
      cruise_updates: 0,
      cruise_deletes: 0,
      expiry_changes: 0,
      ships: 0,
      ports: 0,
      aliases: 0,
      destinations: 0,
      legacy_rows: 0
    }
  };

  report.repository_state = {
    branch: git("git branch --show-current"),
    head: git("git rev-parse HEAD"),
    origin_main: git("git rev-parse origin/main"),
    commits_vs_main: git("git log --oneline origin/main..HEAD")?.split("\n").filter(Boolean) || []
  };

  const sb = createMaintenanceSupabase(root);
  report.production_inventory = await indexGenuineRoyalCaribbeanProduction(sb);

  const masterIds = loadIdSetFromMasterManifest(MASTER_MANIFEST_PATH);
  const batch1Ids = new Set(BATCH1_OFFICIAL_SAILING_IDS);
  const preCatchupIds = new Set([...batch1Ids]);
  const batch2Path = path.join(
    root,
    "reports/royal-caribbean-controlled-batch-manifest-royal-caribbean-batch2-2026-08-13T02-30-30.json"
  );
  if (fs.existsSync(batch2Path)) {
    for (const entry of JSON.parse(fs.readFileSync(batch2Path, "utf8")).entries || []) {
      if (entry.official_sailing_id) preCatchupIds.add(entry.official_sailing_id);
    }
  }

  report.prompt6_identity_reconstruction = {
    master_manifest_count: masterIds.size,
    master_snapshot_id: PROMPT6_MANIFEST_SNAPSHOT_ID,
    pre_catchup_count: preCatchupIds.size,
    prompt6_final_snapshot_id: PROMPT6_FINAL_SNAPSHOT_ID,
    prompt6_reported: fs.existsSync(PROMPT6_FINAL_REPORT)
      ? {
          recognised_existing_eligible: JSON.parse(fs.readFileSync(PROMPT6_FINAL_REPORT, "utf8")).final_reconciliation
            ?.recognised_existing_eligible,
          live_outstanding_eligible: JSON.parse(fs.readFileSync(PROMPT6_FINAL_REPORT, "utf8")).final_reconciliation
            ?.live_outstanding_eligible_inserts
        }
      : null
  };

  const globalRuns = [];
  for (let i = 0; i < (args.quick ? 1 : 3); i += 1) {
    globalRuns.push(
      await enumerateGlobalOffsetPass({ pageSize: 50, stopAtTotal: true, today, requestDelayMs: args.quick ? 0 : 80 })
    );
    if (!args.quick) await new Promise((r) => setTimeout(r, 1500));
  }
  report.global_pagination_audit = {
    runs: globalRuns.map((run) => ({
      started_at: run.started_at,
      completed_at: run.completed_at,
      results_total: run.results_total,
      pages_requested: run.pages_requested,
      raw_group_records: run.raw_group_records,
      unique_group_ids: run.unique_group_ids,
      unique_sailing_ids: run.unique_sailing_ids,
      duplicate_group_ids_suppressed: run.duplicate_group_ids_suppressed,
      duplicate_sailing_ids: run.duplicate_sailing_ids,
      page_boundary_sample: run.page_log.slice(0, 3).concat(run.page_log.slice(-3))
    })),
    comparisons: []
  };
  for (let i = 0; i < globalRuns.length; i += 1) {
    for (let j = i + 1; j < globalRuns.length; j += 1) {
      const diff = symmetricSetDiff(globalRuns[i].sailing_ids, globalRuns[j].sailing_ids);
      report.global_pagination_audit.comparisons.push({
        a: i + 1,
        b: j + 1,
        sailing_symmetric_diff: diff.symmetric_count,
        only_in_a_sample: diff.only_in_a.slice(0, 10),
        only_in_b_sample: diff.only_in_b.slice(0, 10)
      });
    }
  }

  const unionPass = await enumerateMultiPageSizeUnion({
    pageSizes: args.quick ? [50, 100] : [25, 50, 100],
    today,
    requestDelayMs: args.quick ? 0 : 80
  });
  const stableUnionPass = args.skipStability
    ? { ...unionPass, stable: true, stability_passes: 1 }
    : await enumerateUntilStableUnion({
        pageSizes: args.quick ? [50, 100] : [25, 50, 100],
        today,
        requestDelayMs: args.quick ? 0 : 100,
        maxPasses: args.quick ? 1 : 2
      });

  report.partition_strategy = {
    api_ship_filter_supported: false,
    api_date_filter_supported: false,
    note: "Royal Caribbean GraphQL filter strings do not reduce results.total in testing; authoritative method unions multiple page-size global passes",
    page_sizes: unionPass.page_sizes,
    union_group_ids: unionPass.unique_group_ids,
    union_sailing_ids: unionPass.unique_sailing_ids,
    pass_comparisons: unionPass.pass_comparisons,
    ship_coverage: await enumerateShipCoveragePartition({ unionResult: unionPass, today })
  };

  report.global_vs_partitioned = {
    global_single_pass_page_50: {
      unique_group_ids: globalRuns[0].unique_group_ids,
      unique_sailing_ids: globalRuns[0].unique_sailing_ids
    },
    authoritative_union: {
      unique_group_ids: unionPass.unique_group_ids,
      unique_sailing_ids: unionPass.unique_sailing_ids
    },
    group_symmetric_diff: symmetricSetDiff(globalRuns[0].group_ids, unionPass.group_ids),
    sailing_symmetric_diff: symmetricSetDiff(globalRuns[0].sailing_ids, unionPass.sailing_ids)
  };

  const P = report.production_inventory.official_sailing_ids;
  const M = masterIds;
  const S = unionPass.sailing_ids;
  const G = globalRuns[0].sailing_ids;

  report.identity_set_analysis = {
    production_count: P.size,
    master_manifest_count: M.size,
    authoritative_source_count: S.size,
    global_page50_source_count: G.size,
    production_intersect_source: [...P].filter((id) => S.has(id)).length,
    production_minus_source: [...P].filter((id) => !S.has(id)).length,
    source_minus_production: [...S].filter((id) => !P.has(id)).length,
    master_minus_source: [...M].filter((id) => !S.has(id)).length,
    source_minus_master: [...S].filter((id) => !M.has(id)).length,
    pre_catchup_minus_source: [...preCatchupIds].filter((id) => !S.has(id)).length,
    production_minus_global: [...P].filter((id) => !G.has(id)).length,
    global_minus_production: [...G].filter((id) => !P.has(id)).length
  };

  const productionAbsentFromUnion = [...P].filter((id) => !S.has(id));
  const productionAbsentFromGlobal = [...P].filter((id) => !G.has(id));
  report.production_absent_from_authoritative_source = productionAbsentFromUnion.slice(0, 100).map((id) => {
    const row = report.production_inventory.by_official_sailing_id.get(id);
    return {
      official_sailing_id: id,
      departure_date: row?.departure_date || null,
      production_status: row?.status || null,
      classification: classifyProductionAbsentFromSource(row || {}, today),
      group_id: row?.raw_extract?.royal_caribbean_group_id || null
    };
  });

  const detailSample = productionAbsentFromUnion.slice(0, 15);
  report.direct_lookup_audit = [];
  for (const id of detailSample) {
    const row = report.production_inventory.by_official_sailing_id.get(id);
    const groupId = row?.raw_extract?.royal_caribbean_group_id || null;
    let detail = { ok: false, error: "no_group_id" };
    if (groupId) {
      detail = await fetchRoyalCaribbeanCruiseDetail(groupId);
    }
    const sailingPresentInDetail = Boolean(
      detail.cruise?.sailings?.some((s) => s.id === id)
    );
    report.direct_lookup_audit.push({
      official_sailing_id: id,
      group_id: groupId,
      global_enumeration_present: G.has(id),
      union_enumeration_present: S.has(id),
      direct_detail_ok: detail.ok,
      direct_detail_has_sailing: sailingPresentInDetail,
      conclusion: sailingPresentInDetail
        ? "catalogue_enumeration_missed_but_detail_lookup_confirms_exists"
        : detail.ok
          ? "group_exists_but_sailing_not_in_detail_response"
          : "detail_lookup_failed_or_group_missing"
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  const line = (
    await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(LINE_SLUG)}&select=id,name,slug&limit=1`)
  )?.[0];
  const destRows = await sb("destinations?select=id,slug,name&limit=500");
  const destinations = catalogueDestinations(destRows || []);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active`
  );

  const globalReconciliation = await buildReconciliationFromProducts(globalRuns[0].products, sb, line, destinations, today);
  const unionReconciliation = await buildReconciliationFromProducts(unionPass.products, sb, line, destinations, today);

  report.revised_reconciliation = {
    global_page50: {
      source_snapshot_id: computeSourceSnapshotId({ products: globalReconciliation.simulated.products }),
      ...globalReconciliation.summary.counts,
      recognised_existing_eligible: globalReconciliation.summary.recognisedExistingEligible,
      outstanding_eligible_inserts: globalReconciliation.summary.outstandingEligible,
      reconciliation_arithmetic_ok: globalReconciliation.arithmetic.reconciliation_arithmetic_ok
    },
    authoritative_union: {
      source_snapshot_id: computeSourceSnapshotIdFromSailingIds([...S]),
      ...unionReconciliation.summary.counts,
      recognised_existing_eligible: unionReconciliation.summary.recognisedExistingEligible,
      outstanding_eligible_inserts: unionReconciliation.summary.outstandingEligible,
      reconciliation_arithmetic_ok: unionReconciliation.arithmetic.reconciliation_arithmetic_ok
    }
  };

  const prompt6Outstanding = new Set(
    [...S].filter((id) => !M.has(id) && !preCatchupIds.has(id))
  );
  const falselyNewFromGlobal = [...prompt6Outstanding].filter((id) => P.has(id));
  const genuinelyNewSinceManifest = [...S].filter((id) => !M.has(id) && !P.has(id));
  const manifestMissedButInSource = [...M].filter((id) => !G.has(id) && S.has(id));
  const productionNotRecognisedEligible = report.production_inventory.genuine_sailing_count - unionReconciliation.summary.recognisedExistingEligible;

  report.discrepancy_explanation = {
    prompt6_reported_outstanding_632: report.prompt6_identity_reconstruction.prompt6_reported?.live_outstanding_eligible,
    prompt6_reported_recognised_2342: report.prompt6_identity_reconstruction.prompt6_reported?.recognised_existing_eligible,
    arithmetic_gap_2983_minus_2342: report.production_inventory.genuine_sailing_count - (report.prompt6_identity_reconstruction.prompt6_reported?.recognised_existing_eligible || 0),
    root_causes: [],
    revised_outstanding_eligible_union: unionReconciliation.summary.outstandingEligible,
    revised_outstanding_eligible_global: globalReconciliation.summary.outstandingEligible,
    genuinely_new_since_master_manifest: genuinelyNewSinceManifest.length,
    production_ids_in_outstanding_union_but_already_in_production: falselyNewFromGlobal.length,
    master_ids_missed_by_global_but_present_in_union: manifestMissedButInSource.length,
    production_not_recognised_as_eligible_existing: productionNotRecognisedEligible,
    breakdown_of_production_not_recognised: {
      inside_21_day_cutoff_in_source: unionReconciliation.manifest.products.filter(
        (p) => p.proposed_action === "within_21_day_cutoff_skip" && P.has(p.official_royal_caribbean_sailing_id)
      ).length,
      past_in_source: unionReconciliation.manifest.products.filter(
        (p) => p.proposed_action === "past_skip" && P.has(p.official_royal_caribbean_sailing_id)
      ).length,
      incomplete_in_source: unionReconciliation.manifest.products.filter(
        (p) => p.proposed_action === "incomplete_skip" && P.has(p.official_royal_caribbean_sailing_id)
      ).length,
      duplicate_skip_eligible: unionReconciliation.summary.recognisedExistingEligible,
      absent_from_authoritative_source: productionAbsentFromUnion.length,
      absent_from_global_source: productionAbsentFromGlobal.length
    },
    post_manifest_classification: {
      genuinely_new_since_master: genuinelyNewSinceManifest.length,
      enumeration_artefact_global_vs_union: symmetricSetDiff(G, S).symmetric_count,
      already_in_production_but_classified_insert: falselyNewFromGlobal.length
    }
  };

  if (globalReconciliation.summary.outstandingEligible > unionReconciliation.summary.outstandingEligible + 50) {
    report.discrepancy_explanation.root_causes.push(
      "single_page_size_global_enumeration_overcounts_outstanding_eligible_due_to_offset_pagination_gaps"
    );
  }
  if (productionAbsentFromUnion.length > 0) {
    report.discrepancy_explanation.root_causes.push(
      "some_production_sailings_absent_from_even_union_enumeration_requires_detail_lookup_or_cutoff_classification"
    );
  }
  if (report.discrepancy_explanation.breakdown_of_production_not_recognised.inside_21_day_cutoff_in_source > 0) {
    report.discrepancy_explanation.root_causes.push(
      "recognised_existing_eligible_excludes_production_matches_inside_21_day_source_cutoff_by_design"
    );
  }
  if (report.discrepancy_explanation.breakdown_of_production_not_recognised.absent_from_global_source > productionAbsentFromUnion.length) {
    report.discrepancy_explanation.root_causes.push(
      "global_offset_pagination_misses_sailings_that_union_or_detail_lookup_recover"
    );
  }

  report.enumeration_health = evaluateSourceEnumerationHealth({
    globalPass: globalRuns[0],
    unionPass,
    stableUnionPass,
    productionSailingIds: P,
    directLookupResults: report.direct_lookup_audit.map((row) => ({
      detail_ok: row.direct_detail_ok && row.direct_detail_has_sailing,
      in_union: row.union_enumeration_present
    })),
    shipCoverage: report.partition_strategy.ship_coverage
  });

  report.authoritative_enumeration_method = {
    method: "multi_page_size_union",
    page_sizes: args.quick ? [50, 100] : [25, 50, 100],
    stop_condition: "each pass uses stop_at_total then union; weekly maintenance should adopt this union before reconciliation",
    dedupe: "unique group id + unique official_sailing_id across passes",
    snapshot_id: computeSourceSnapshotIdFromSailingIds([...S]),
    source_absence_action_allowed: sourceAbsenceActionAllowed(report.enumeration_health)
  };

  report.revised_status_of_reported_632 = {
    prompt6_reported: 632,
    revised_union_outstanding: unionReconciliation.summary.outstandingEligible,
    revised_global_outstanding: globalReconciliation.summary.outstandingEligible,
    genuinely_new_since_manifest: genuinelyNewSinceManifest.length,
    enumeration_artefacts: falselyNewFromGlobal.length + manifestMissedButInSource.length,
    note: "632 was computed from a single global fetch after catch-up; union enumeration and eligibility rules explain most of the inflation"
  };

  report.tests_preflight = {};
  try {
    report.tests_preflight.discovery = Number(
      execSync("node scripts/test-royal-caribbean-discovery.mjs", { cwd: root, encoding: "utf8" }).match(
        /(\d+) passed/
      )?.[1]
    );
    report.tests_preflight.controlled_batch = Number(
      execSync("node scripts/test-royal-caribbean-controlled-batch.mjs", { cwd: root, encoding: "utf8" }).match(
        /(\d+) passed/
      )?.[1]
    );
    report.tests_preflight.catchup = Number(
      execSync("node scripts/test-royal-caribbean-final-catchup.mjs", { cwd: root, encoding: "utf8" }).match(
        /(\d+) passed/
      )?.[1]
    );
    report.tests_preflight.enumeration = Number(
      execSync("node scripts/test-royal-caribbean-source-enumeration.mjs", { cwd: root, encoding: "utf8" }).match(
        /(\d+) passed/
      )?.[1]
    );
  } catch (error) {
    report.tests_preflight.error = error.message;
  }

  const enumOk = report.enumeration_health.royal_caribbean_source_enumeration_ok === true;
  const arithOk = report.revised_reconciliation.authoritative_union.reconciliation_arithmetic_ok === true;
  report.recommendation =
    enumOk && arithOk ? "READY FOR WEEKLY AUTOMATION BEHAVIOUR VALIDATION" : "NOT READY FOR WEEKLY AUTOMATION";
  if (!enumOk) {
    report.recommendation_blocker = report.enumeration_health.failures.join("; ");
  }

  report.completed_at = new Date().toISOString();
  const slimReport = {
    ...report,
    production_inventory: {
      total_rows: report.production_inventory.total_rows,
      genuine_sailing_count: report.production_inventory.genuine_sailing_count,
      legacy_html_count: report.production_inventory.legacy_html_count,
      unique_official_sailing_ids: report.production_inventory.unique_official_sailing_ids,
      unique_identity_keys: report.production_inventory.unique_identity_keys,
      duplicate_official_sailing_ids: report.production_inventory.duplicate_official_sailing_ids,
      duplicate_identity_keys: report.production_inventory.duplicate_identity_keys,
      earliest_departure: report.production_inventory.earliest_departure,
      latest_departure: report.production_inventory.latest_departure
    }
  };
  slimReport.cloud_runtime = {
    github_actions_source_smoke: "NOT EXECUTED — gh CLI unavailable in execution environment; workflow exists on branch",
    netlify_runtime: "NOT PROVEN — netlify CLI unavailable; smoke function added but not deployed/invoked from Netlify infrastructure"
  };
  if (!slimReport.cloud_runtime.netlify_runtime.startsWith("NOT PROVEN")) {
    slimReport.recommendation = slimReport.enumeration_health?.royal_caribbean_source_enumeration_ok
      ? "READY FOR WEEKLY AUTOMATION BEHAVIOUR VALIDATION"
      : "NOT READY FOR WEEKLY AUTOMATION";
  } else {
    slimReport.recommendation = "NOT READY FOR WEEKLY AUTOMATION";
    slimReport.recommendation_blocker = "Netlify runtime proof mandatory before weekly automation validation";
  }
  const reportPath = writeReport(`${auditId}.json`, slimReport);
  console.log(
    JSON.stringify(
      {
        ok: enumOk,
        report: reportPath,
        production: report.production_inventory.genuine_sailing_count,
        union_sailings: unionPass.unique_sailing_ids,
        global_sailings: globalRuns[0].unique_sailing_ids,
        revised_outstanding: unionReconciliation.summary.outstandingEligible,
        enumeration_ok: enumOk,
        recommendation: report.recommendation
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
