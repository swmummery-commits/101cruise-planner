/**
 * Offline tests for Batch 2 mixed-line runner.
 * No network. No credentials. No live DB writes.
 */

import {
  BATCH_1_ID,
  BATCH_1_CONFIRM_TOKEN,
  BATCH_1_LINES,
  getApprovedBatch,
  assertProductionBatchCliGate,
  assertBatch1LogoOnlyScope
} from "./lib/squarespace-ci-media/batch-1-logo-lines.js";
import {
  BATCH_2_ID,
  BATCH_2_CONFIRM_TOKEN,
  BATCH_2_LINES,
  BATCH_2_LINE_IDS,
  BATCH_2_SHIP_IDS,
  DISNEY_CRUISE_LINE_ID,
  DISNEY_CRUISE_LINE_NAME,
  getBatch2Config,
  assertBatch2MixedScope,
  assertBatch2PromotePlan
} from "./lib/squarespace-ci-media/batch-2-mixed-lines.js";
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

function okScope(approved, overrides = {}) {
  return {
    approved,
    logoCandidates: overrides.logoCandidates ?? [{ url: "logo" }],
    shipHeroCandidates:
      overrides.shipHeroCandidates ??
      approved.ships.map((s) => ({ ship_id: s.id, name: s.name, url: "hero" }))
  };
}

async function main() {
  let passed = 0;
  const batch = getBatch2Config();
  const viaRegistry = getApprovedBatch(BATCH_2_ID);

  // exactly six approved lines; Disney excluded
  assert(batch.lines.length === 6, "six lines");
  assert(BATCH_2_LINES.length === 6, "frozen six");
  assert(BATCH_2_LINE_IDS.length === 6, "six ids");
  assert(batch.excludes_disney === true, "excludes disney flag");
  assert(!BATCH_2_LINE_IDS.includes(DISNEY_CRUISE_LINE_ID), "disney id absent");
  assert(
    !batch.lines.some((l) => l.name === DISNEY_CRUISE_LINE_NAME),
    "disney name absent"
  );
  assert(batch.expected_total_assets === 19, "19 assets excluding disney");
  assert(BATCH_2_SHIP_IDS.length === 13, "13 ships");
  passed += 1;

  assert(viaRegistry.id === BATCH_2_ID, "registry batch 2");
  assert(viaRegistry.kind === "mixed", "mixed kind");
  assert(viaRegistry.confirm_token === BATCH_2_CONFIRM_TOKEN, "confirm token");
  passed += 1;

  // exact UUID/name/count configuration
  assert(batch.lines[0].name === "Celebrity Cruises", "celebrity name");
  assert(batch.lines[0].id === "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec", "celebrity id");
  assert(batch.lines[1].name === "Atlas Cruises", "atlas canonical name");
  assert(batch.lines[1].id === "8aa1d0a8-c04c-4494-8ff3-928e811057e1", "atlas id");
  assert(batch.lines[2].name === "Azamara", "azamara");
  assert(batch.lines[3].name === "Explora Journeys", "explora");
  assert(batch.lines[4].name === "Oceania Cruises", "oceania");
  assert(batch.lines[5].name === "Royal Caribbean International", "rci");
  for (const line of batch.lines) {
    assert(
      line.expected_logo_count + line.expected_ship_hero_count === line.expected_total,
      `${line.name} totals`
    );
    assert(line.ships.length === line.expected_ship_hero_count, `${line.name} ship list`);
  }
  assert(batch.lines[0].expected_total === 3, "celebrity 3");
  assert(batch.lines[1].expected_total === 4, "atlas 4");
  assert(batch.lines[2].expected_total === 4, "azamara 4");
  assert(batch.lines[3].expected_total === 4, "explora 4");
  assert(batch.lines[4].expected_total === 2, "oceania 2");
  assert(batch.lines[5].expected_total === 2, "rci 2");
  passed += 1;

  // CLI gate
  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_2_ID,
      confirmToken: BATCH_2_CONFIRM_TOKEN
    }).id === BATCH_2_ID,
    "cli ok"
  );
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "production",
        mode: "copy",
        batchId: BATCH_2_ID,
        confirmToken: "BATCH-1-LOGOS"
      }),
    "batch_confirm_invalid"
  );
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "dev",
        mode: "copy",
        batchId: BATCH_2_ID,
        confirmToken: BATCH_2_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  passed += 1;

  const celebrity = batch.lines[0];
  assertBatch2MixedScope(okScope(celebrity));
  passed += 1;

  // unexpected logo count aborts
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, { logoCandidates: [{}, {}] })
      ),
    "batch2_unexpected_logo_count"
  );
  assertThrows(
    () => assertBatch2MixedScope(okScope(celebrity, { logoCandidates: [] })),
    "batch2_unexpected_logo_count"
  );
  passed += 1;

  // unexpected ship count aborts
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: celebrity.ships.slice(0, 1).map((s) => ({
            ship_id: s.id,
            name: s.name
          }))
        })
      ),
    "batch2_unexpected_ship_count"
  );
  passed += 1;

  // unexpected ship name aborts (UUID/name pair mismatch)
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: [
            { ship_id: celebrity.ships[0].id, name: celebrity.ships[1].name },
            { ship_id: celebrity.ships[1].id, name: celebrity.ships[0].name }
          ]
        })
      ),
    "batch2_unexpected_ship_name"
  );
  passed += 1;

  // ship owned by another line aborts (foreign UUID under this line's scope)
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: [
            { ship_id: batch.lines[1].ships[0].id, name: celebrity.ships[0].name },
            { ship_id: celebrity.ships[1].id, name: celebrity.ships[1].name }
          ]
        })
      ),
    "batch2_missing_ship"
  );
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: [
            { ship_id: batch.lines[1].ships[0].id, name: batch.lines[1].ships[0].name },
            { ship_id: celebrity.ships[1].id, name: celebrity.ships[1].name }
          ]
        })
      ),
    "batch2_missing_ship"
  );
  passed += 1;

  // extra candidate aborts
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: [
            ...celebrity.ships.map((s) => ({ ship_id: s.id, name: s.name })),
            { ship_id: "11111111-1111-1111-1111-111111111111", name: "Extra" }
          ]
        })
      ),
    "batch2_unexpected_ship_count"
  );
  passed += 1;

  // missing candidate aborts
  assertThrows(
    () =>
      assertBatch2MixedScope(
        okScope(celebrity, {
          shipHeroCandidates: [
            { ship_id: celebrity.ships[0].id, name: celebrity.ships[0].name }
            // second ship missing → count mismatch
          ]
        })
      ),
    "batch2_unexpected_ship_count"
  );
  passed += 1;

  // Disney forbidden in scope
  assertThrows(
    () =>
      assertBatch2MixedScope({
        approved: {
          ...celebrity,
          id: DISNEY_CRUISE_LINE_ID,
          name: DISNEY_CRUISE_LINE_NAME
        },
        logoCandidates: [{}],
        shipHeroCandidates: []
      }),
    "batch2_disney_forbidden"
  );
  passed += 1;

  // promote plan gates
  const goodPlan = {
    line_id: celebrity.id,
    updates: [
      {
        table: "ci_cruise_lines",
        field: "logo_url",
        entity_uuid: celebrity.id,
        entity_type: "cruise_line"
      },
      {
        table: "ci_cruise_ships",
        field: "hero_image_url",
        entity_uuid: celebrity.ships[0].id,
        entity_type: "ship"
      },
      {
        table: "ci_cruise_ships",
        field: "hero_image_url",
        entity_uuid: celebrity.ships[1].id,
        entity_type: "ship"
      }
    ]
  };
  assertBatch2PromotePlan(goodPlan, celebrity);
  assertThrows(
    () =>
      assertBatch2PromotePlan(
        {
          ...goodPlan,
          updates: goodPlan.updates.slice(0, 1)
        },
        celebrity
      ),
    "batch2_promote_count_mismatch"
  );
  assertThrows(
    () =>
      assertBatch2PromotePlan(
        {
          line_id: celebrity.id,
          updates: [
            ...goodPlan.updates.slice(0, 2),
            {
              table: "ci_cruise_ships",
              field: "hero_image_url",
              entity_uuid: batch.lines[1].ships[0].id,
              entity_type: "ship"
            }
          ]
        },
        celebrity
      ),
    "batch2_promote_ship_not_approved"
  );
  assertThrows(
    () =>
      assertBatch2PromotePlan(
        {
          line_id: celebrity.id,
          updates: [
            {
              table: "ci_cruise_lines",
              field: "description",
              entity_uuid: celebrity.id
            },
            ...goodPlan.updates.slice(1)
          ]
        },
        celebrity
      ),
    "batch2_promote_field_forbidden"
  );
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
      logos_uploaded: 0,
      ship_heroes_uploaded: 0,
      skipped_already_migrated: 0,
      promoted_fields: [],
      bytes_uploaded: 0,
      report_path: `r-${approved.order}.json`,
      rollback_manifest_path: null
    })
  });
  assert(dry.original_project_writes === 0, "dry writes 0");
  assert(dry.dev_writes === 0, "dev 0");
  assert(dry.completed_lines === 6, "all dry");
  passed += 1;

  // copy modifies only Storage + Media Library (CI URLs never changed)
  const copy = await runApprovedBatch({
    mode: "copy",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: true,
      uploaded_count: approved.expected_total,
      logos_uploaded: approved.expected_logo_count,
      ship_heroes_uploaded: approved.expected_ship_hero_count,
      media_library_inserted_count: approved.expected_total,
      skipped_already_migrated: 0,
      bytes_uploaded: 1000,
      promoted_fields: [],
      ci_urls_changed: 0,
      report_path: `c-${approved.order}.json`,
      rollback_manifest_path: null
    })
  });
  assert(copy.uploaded_assets === 19, "19 uploads");
  assert(copy.dev_writes === 0, "copy dev 0");
  assert(
    copy.lines.every((l) => (l.promoted_fields || []).length === 0),
    "copy no promote"
  );
  assertThrows(
    () => summariseCopyResults([{ copy_result: "uploaded", ci_url_changed: true }]),
    "batch_copy_ci_url_changed"
  );
  passed += 1;

  // promote modifies only approved logo_url + hero_image_url; no upload/insert
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
      logos_uploaded: 0,
      ship_heroes_uploaded: 0,
      skipped_already_migrated: 0,
      bytes_uploaded: 0,
      logos_promoted: 1,
      ship_heroes_promoted: approved.expected_ship_hero_count,
      promoted_fields: [
        "ci_cruise_lines.logo_url",
        ...approved.ships.map(() => "ci_cruise_ships.hero_image_url")
      ],
      report_path: `p-${approved.order}.json`,
      rollback_manifest_path: `m-${approved.order}.json`
    })
  });
  assert(promote.promoted_fields === 19, "19 promoted fields");
  assert(promote.rollback_manifest_paths.length === 6, "6 manifests");
  assert(promote.uploaded_assets === 0, "promote no upload");
  assert(
    promote.lines.every((l) => (l.uploaded_count || 0) === 0),
    "no promote uploads"
  );
  assert(
    promote.lines.every((l) => (l.media_library_inserted_count || 0) === 0),
    "no promote inserts"
  );
  assert(
    promote.lines.every((l) =>
      l.promoted_fields.every(
        (f) => f === "ci_cruise_lines.logo_url" || f === "ci_cruise_ships.hero_image_url"
      )
    ),
    "only logo/hero fields"
  );
  passed += 1;

  // failure stops later lines
  const stop = await runApprovedBatch({
    mode: "copy",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => {
      if (approved.order === 2) {
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
  assert(stop.completed_lines === 1, "one ok before fail");
  assert(stop.failed_line.order === 2, "failed second");
  assert(stop.unprocessed_lines.length === 4, "4 unprocessed");
  assert(stop.unprocessed_lines.every((l) => l.id !== DISNEY_CRUISE_LINE_ID), "no disney");
  passed += 1;

  // verified PATCH + re-read remain enforced
  assertThrows(
    () =>
      assertExactOnePatchedRow([], {
        entityUuid: celebrity.id,
        field: "logo_url",
        expectedValue: "https://x.supabase.co/x"
      }),
    "patch_zero_rows"
  );
  assertThrows(
    () =>
      assertExactOnePatchedRow(
        [{ id: celebrity.id, logo_url: "https://wrong" }],
        {
          entityUuid: celebrity.id,
          field: "logo_url",
          expectedValue: "https://x.supabase.co/x"
        }
      ),
    "patch_wrong_field_value"
  );
  passed += 1;

  // Batch 1 behaviour remains unchanged
  const batch1 = getApprovedBatch(BATCH_1_ID);
  assert(batch1.lines.length === 13, "batch1 still 13");
  assert(batch1.kind === "logo-only", "batch1 logo-only");
  assert(BATCH_1_LINES.length === 13, "batch1 frozen");
  assertBatch1LogoOnlyScope({
    logoCandidates: [{}],
    shipHeroCandidates: [],
    lineName: "NCL"
  });
  assertThrows(
    () =>
      assertBatch1LogoOnlyScope({
        logoCandidates: [{}],
        shipHeroCandidates: [{ name: "Ship" }],
        lineName: "NCL"
      }),
    "batch_ship_candidate_forbidden"
  );
  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_1_ID,
      confirmToken: BATCH_1_CONFIRM_TOKEN
    }).id === BATCH_1_ID,
    "batch1 cli still works"
  );
  passed += 1;

  // DEV remains untouched
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
        batchId: BATCH_2_ID,
        confirmToken: BATCH_2_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  assert(dry.dev_writes === 0 && copy.dev_writes === 0 && promote.dev_writes === 0, "dev 0");
  passed += 1;

  console.log(`PASS ${passed} squarespace batch-2-mixed-lines tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
