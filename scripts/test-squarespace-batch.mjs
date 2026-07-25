/**
 * Offline tests for Batch 1 logo-line runner.
 * No network. No credentials. No live DB writes.
 */

import {
  BATCH_1_ID,
  BATCH_1_CONFIRM_TOKEN,
  BATCH_1_LINES,
  BATCH_1_LINE_IDS,
  getApprovedBatch,
  assertProductionBatchCliGate,
  assertApprovedLineOrder,
  assertLineInApprovedBatch,
  assertCanonicalLineMatch,
  assertBatch1LogoOnlyScope
} from "./lib/squarespace-ci-media/batch-1-logo-lines.js";
import {
  runApprovedBatch,
  summariseCopyResults
} from "./lib/squarespace-ci-media/batch-runner.js";
import { assertExactOnePatchedRow } from "./lib/squarespace-ci-media/verified-ci-patch.js";
import { resolveMigrationTarget, DEV_REF, PRODUCTION_REF } from "./lib/squarespace-ci-media/target.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, code) {
  let ok = false;
  try {
    fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

async function assertThrowsAsync(fn, code) {
  let ok = false;
  try {
    await fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

async function main() {
  let passed = 0;
  const batch = getApprovedBatch(BATCH_1_ID);
  assert(batch.lines.length === 13, "13 lines");
  assert(BATCH_1_LINES.length === 13, "frozen 13");
  assert(BATCH_1_LINE_IDS.length === 13, "ids 13");
  passed += 1;

  // approved order cannot change
  assertApprovedLineOrder(batch);
  assert(batch.lines[0].name === "Norwegian Cruise Line", "first NCL");
  assert(batch.lines[12].name === "Cunard Line", "last Cunard");
  for (let i = 0; i < batch.lines.length; i += 1) {
    assert(batch.lines[i].order === i + 1, `order ${i + 1}`);
  }
  passed += 1;

  // wrong batch name aborts
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "production",
        mode: "dry-run",
        batchId: "batch-2",
        confirmToken: BATCH_1_CONFIRM_TOKEN
      }),
    "batch_id_invalid"
  );
  passed += 1;

  // wrong confirmation aborts
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "production",
        mode: "dry-run",
        batchId: BATCH_1_ID,
        confirmToken: "WRONG"
      }),
    "batch_confirm_invalid"
  );
  passed += 1;

  // missing target aborts
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: null,
        mode: "dry-run",
        batchId: BATCH_1_ID,
        confirmToken: BATCH_1_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "dev",
        mode: "copy",
        batchId: BATCH_1_ID,
        confirmToken: BATCH_1_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  passed += 1;

  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_1_ID,
      confirmToken: BATCH_1_CONFIRM_TOKEN
    }).id === BATCH_1_ID,
    "cli ok"
  );
  passed += 1;

  // unexpected line name aborts
  assertThrows(
    () =>
      assertCanonicalLineMatch(batch.lines[0], {
        id: batch.lines[0].id,
        name: "Wrong Name"
      }),
    "batch_line_name_mismatch"
  );
  passed += 1;

  assertCanonicalLineMatch(batch.lines[0], {
    id: batch.lines[0].id,
    name: "Norwegian Cruise Line"
  });
  passed += 1;

  // line outside approved list cannot be processed
  assertThrows(
    () => assertLineInApprovedBatch(batch, "00000000-0000-0000-0000-000000000000"),
    "batch_line_not_approved"
  );
  passed += 1;

  // ship candidate causes abort
  assertThrows(
    () =>
      assertBatch1LogoOnlyScope({
        logoCandidates: [{ url: "x" }],
        shipHeroCandidates: [{ name: "Ship" }],
        lineName: "NCL"
      }),
    "batch_ship_candidate_forbidden"
  );
  passed += 1;

  // candidate count other than one causes abort
  assertThrows(
    () =>
      assertBatch1LogoOnlyScope({
        logoCandidates: [],
        shipHeroCandidates: [],
        lineName: "NCL"
      }),
    "batch_logo_candidate_count"
  );
  passed += 1;

  assertThrows(
    () =>
      assertBatch1LogoOnlyScope({
        logoCandidates: [{}, {}],
        shipHeroCandidates: [],
        lineName: "NCL"
      }),
    "batch_logo_candidate_count"
  );
  passed += 1;

  assertBatch1LogoOnlyScope({
    logoCandidates: [{}],
    shipHeroCandidates: [],
    lineName: "NCL"
  });
  passed += 1;

  // dry-run performs zero writes
  const dry = await runApprovedBatch({
    mode: "dry-run",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: false,
      uploaded_count: 0,
      skipped_already_migrated: 0,
      promoted_fields: [],
      bytes_uploaded: 0,
      report_path: `r-${approved.order}.json`,
      rollback_manifest_path: null
    })
  });
  assert(dry.original_project_writes === 0, "dry writes 0");
  assert(dry.dev_writes === 0, "dev 0");
  assert(dry.completed_lines === 13, "all dry");
  passed += 1;

  // copy processes sequentially; Norwegian skips duplicate
  const copyOrder = [];
  const copy = await runApprovedBatch({
    mode: "copy",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => {
      copyOrder.push(approved.id);
      const isNcl = approved.order === 1;
      return {
        order: approved.order,
        line_id: approved.id,
        line_name: approved.name,
        status: "ok",
        wrote: !isNcl,
        uploaded_count: isNcl ? 0 : 1,
        media_library_inserted_count: isNcl ? 0 : 1,
        skipped_already_migrated: isNcl ? 1 : 0,
        bytes_uploaded: isNcl ? 0 : 1000,
        promoted_fields: [],
        report_path: `c-${approved.order}.json`,
        rollback_manifest_path: null
      };
    }
  });
  assert(copyOrder.length === 13, "copy all");
  assert(copyOrder[0] === batch.lines[0].id, "copy order first");
  assert(copy.skipped_existing_assets === 1, "ncl skip");
  assert(copy.uploaded_assets === 12, "12 uploads");
  assert(copy.dev_writes === 0, "copy dev 0");
  passed += 1;

  // promote sequential + manifests
  const promote = await runApprovedBatch({
    mode: "promote",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: true,
      uploaded_count: 0,
      media_library_inserted_count: 0,
      skipped_already_migrated: 0,
      bytes_uploaded: 0,
      promoted_fields: ["ci_cruise_lines.logo_url"],
      report_path: `p-${approved.order}.json`,
      rollback_manifest_path: `m-${approved.order}.json`
    })
  });
  assert(promote.promoted_fields === 13, "13 logos");
  assert(promote.rollback_manifest_paths.length === 13, "13 manifests");
  assert(
    promote.lines.every(
      (l) =>
        l.promoted_fields.length === 1 && l.promoted_fields[0] === "ci_cruise_lines.logo_url"
    ),
    "only logo fields"
  );
  assert(promote.uploaded_assets === 0, "promote no upload");
  passed += 1;

  // failure stops later lines
  const stop = await runApprovedBatch({
    mode: "copy",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => {
      if (approved.order === 3) {
        throw Object.assign(new Error("boom"), { code: "test_fail" });
      }
      return {
        order: approved.order,
        line_id: approved.id,
        line_name: approved.name,
        status: "ok",
        wrote: true,
        uploaded_count: 1,
        skipped_already_migrated: 0,
        promoted_fields: [],
        bytes_uploaded: 10,
        report_path: null,
        rollback_manifest_path: null
      };
    }
  });
  assert(stop.stopped_early === true, "stopped");
  assert(stop.completed_lines === 2, "two ok before fail");
  assert(stop.failed_line.order === 3, "failed third");
  assert(stop.unprocessed_lines.length === 10, "10 unprocessed");
  assert(stop.lines.length === 3, "two ok + fail recorded");
  passed += 1;

  // copy never changes CI URLs
  assertThrows(
    () => summariseCopyResults([{ copy_result: "uploaded", ci_url_changed: true }]),
    "batch_copy_ci_url_changed"
  );
  const skipStats = summariseCopyResults([
    { copy_result: "skipped_already_present", status: "already_copied", ci_url_changed: false }
  ]);
  assert(skipStats.skipped_already_migrated === 1 && skipStats.uploaded_count === 0, "ncl stats");
  passed += 1;

  // verified PATCH still enforced
  assertThrows(
    () =>
      assertExactOnePatchedRow([], {
        entityUuid: batch.lines[0].id,
        field: "logo_url",
        expectedValue: "https://x.supabase.co/x"
      }),
    "patch_zero_rows"
  );
  passed += 1;

  // DEV remains untouched / batch refuses DEV
  const mixedEnv = {
    SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DEV_SERVICE_ROLE_KEY: "dev-secret",
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret"
  };
  const dev = resolveMigrationTarget({ target: "dev", mode: "copy", env: mixedEnv });
  assert(dev.writes_allowed === true, "dev still works for single-line tool");
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "dev",
        mode: "promote",
        batchId: BATCH_1_ID,
        confirmToken: BATCH_1_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  passed += 1;

  // promote never uploads — covered by promote summary above
  assert(promote.lines.every((l) => (l.uploaded_count || 0) === 0), "no promote uploads");
  assert(
    promote.lines.every((l) => (l.media_library_inserted_count || 0) === 0),
    "no promote inserts"
  );
  passed += 1;

  console.log(`PASS ${passed} squarespace batch-1-logo-lines tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
