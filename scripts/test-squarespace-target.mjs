/**
 * Offline tests for explicit --target + gated Original-project single-line COPY.
 * No network. No credentials printed.
 */

import {
  DEV_REF,
  PRODUCTION_REF,
  parseTargetArg,
  resolveMigrationTarget,
  formatTargetBanner,
  projectRefFromUrl
} from "./lib/squarespace-ci-media/target.js";
import {
  PRODUCTION_COPY_ALLOWED_LINE_ID,
  parseConfirmProductionCopy,
  assertProductionCopyCliGate,
  assertProductionCopyPlan,
  assertCopyDidNotChangeCiUrls
} from "./lib/squarespace-ci-media/production-copy-gate.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, code) {
  let ok = false;
  try {
    fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

function main() {
  let passed = 0;
  const NCL_ID = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";
  const line = { id: NCL_ID, name: "Norwegian Cruise Line" };

  assert(parseTargetArg(["node", "script.mjs", "--dry-run"]) === null, "omit parse");
  passed += 1;
  assertThrows(
    () => resolveMigrationTarget({ target: null, mode: "dry-run", env: {} }),
    "missing_target"
  );
  passed += 1;

  assert(parseTargetArg(["--target=production"]) === "production", "parse =production");
  assert(parseTargetArg(["--target", "dev"]) === "dev", "parse space dev");
  passed += 1;

  const mixedEnv = {
    SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DEV_SERVICE_ROLE_KEY: "dev-secret-value-not-printed",
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret-value-not-printed"
  };

  const devResolved = resolveMigrationTarget({
    target: "dev",
    mode: "dry-run",
    env: mixedEnv
  });
  assert(devResolved.project_ref === DEV_REF, "dev ref");
  passed += 1;

  const prodResolved = resolveMigrationTarget({
    target: "production",
    mode: "dry-run",
    env: mixedEnv
  });
  assert(prodResolved.project_ref === PRODUCTION_REF, "prod ref");
  assert(!prodResolved.url.includes(DEV_REF), "dev not used for prod");
  passed += 1;

  assert(
    resolveMigrationTarget({ target: "production", mode: "dry-run", env: mixedEnv }).url.includes(
      PRODUCTION_REF
    ),
    "prod keys only"
  );
  passed += 1;

  assert(
    resolveMigrationTarget({
      target: "dev",
      mode: "copy",
      env: { ...mixedEnv, SUPABASE_URL: "https://evil.example.com", SUPABASE_SERVICE_ROLE_KEY: "x" }
    }).project_ref === DEV_REF,
    "prod ignored for dev"
  );
  passed += 1;

  assertThrows(
    () =>
      resolveMigrationTarget({
        target: "dev",
        mode: "dry-run",
        env: {
          SUPABASE_DEV_URL: "https://wrongproject.supabase.co",
          SUPABASE_DEV_SERVICE_ROLE_KEY: "x"
        }
      }),
    "unexpected_dev_ref"
  );
  passed += 1;

  assertThrows(
    () =>
      resolveMigrationTarget({
        target: "production",
        mode: "dry-run",
        env: {
          SUPABASE_URL: "https://wrongproject.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "x"
        }
      }),
    "unexpected_production_ref"
  );
  passed += 1;

  assert(
    resolveMigrationTarget({ target: "production", mode: "dry-run", env: mixedEnv })
      .production_copy_gated === false,
    "prod dry"
  );
  passed += 1;

  assertThrows(
    () => resolveMigrationTarget({ target: "production", mode: "rollback", env: mixedEnv }),
    "production_write_forbidden"
  );
  passed += 1;

  const prodPromoteResolve = resolveMigrationTarget({
    target: "production",
    mode: "promote",
    env: mixedEnv
  });
  assert(prodPromoteResolve.production_promote_gated === true, "prod promote gated");
  assert(prodPromoteResolve.writes_allowed === false, "prod promote writes not open");
  passed += 1;

  const prodRepair = resolveMigrationTarget({
    target: "production",
    mode: "repair-logo",
    env: mixedEnv
  });
  assert(prodRepair.production_logo_repair_gated === true, "prod logo repair gated");
  passed += 1;

  assertThrows(
    () => resolveMigrationTarget({ target: "dev", mode: "repair-logo", env: mixedEnv }),
    "logo_repair_dev_forbidden"
  );
  passed += 1;

  const prodCopy = resolveMigrationTarget({
    target: "production",
    mode: "copy",
    env: mixedEnv
  });
  assert(prodCopy.production_copy_gated === true, "prod copy gated");
  assert(prodCopy.project_ref === PRODUCTION_REF, "prod copy ref");
  passed += 1;

  for (const mode of ["copy", "promote", "rollback"]) {
    const r = resolveMigrationTarget({ target: "dev", mode, env: mixedEnv });
    assert(r.writes_allowed === true, `dev ${mode}`);
  }
  passed += 1;

  const goodScope = { lineId: NCL_ID, shipId: null, entityIds: null };
  assert(
    parseConfirmProductionCopy([`--confirm-production-copy=${NCL_ID}`]) === NCL_ID,
    "confirm parse uuid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: null,
        line
      }),
    "production_copy_confirm_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: "PRINCESS",
        line
      }),
    "production_copy_confirm_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: NCL_ID, shipId: "ship-1", entityIds: null },
        confirmToken: NCL_ID,
        line
      }),
    "production_copy_scope_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: NCL_ID, shipId: null, entityIds: ["a", "b"] },
        confirmToken: NCL_ID,
        line
      }),
    "production_copy_scope_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: null, shipId: null, entityIds: null },
        confirmToken: NCL_ID
      }),
    "production_copy_scope_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyCliGate({
        target: "production",
        mode: "copy",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: NCL_ID,
        line: null
      }),
    "production_copy_line_missing"
  );
  passed += 1;

  assert(
    assertProductionCopyCliGate({
      target: "production",
      mode: "copy",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: goodScope,
      confirmToken: NCL_ID,
      line
    }) === true,
    "cli gate ok"
  );
  passed += 1;

  // Princess still works with UUID confirm
  assert(
    assertProductionCopyCliGate({
      target: "production",
      mode: "copy",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: { lineId: PRODUCTION_COPY_ALLOWED_LINE_ID, shipId: null, entityIds: null },
      confirmToken: PRODUCTION_COPY_ALLOWED_LINE_ID,
      line: { id: PRODUCTION_COPY_ALLOWED_LINE_ID, name: "Princess Cruises" }
    }) === true,
    "princess uuid still ok"
  );
  passed += 1;

  const eleven = Array.from({ length: 11 }, (_, i) => ({
    entity_id: `e${i}`,
    cruise_line_id: NCL_ID,
    status: "proposed_upload",
    bytes: 10,
    oversized: false
  }));
  assertThrows(
    () => assertProductionCopyPlan({ inspected: eleven, summary: { broken_urls: 0 }, lineId: NCL_ID }),
    "production_copy_candidate_count"
  );
  passed += 1;

  // 6 candidates now allowed (max 10)
  const six = Array.from({ length: 6 }, (_, i) => ({
    entity_id: `e${i}`,
    cruise_line_id: NCL_ID,
    status: "proposed_upload",
    bytes: 10,
    oversized: false
  }));
  assert(
    assertProductionCopyPlan({
      inspected: six,
      summary: {
        broken_urls: 0,
        invalid_mime_types: 0,
        ssrf_blocked: 0,
        too_large: 0,
        estimated_upload_bytes: 60
      },
      lineId: NCL_ID,
      lineName: "Norwegian Cruise Line"
    }).candidate_count === 6,
    "six ok"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyPlan({
        inspected: [{ entity_id: "x", cruise_line_id: NCL_ID, status: "broken_url", error: "HTTP 404" }],
        summary: { broken_urls: 1, invalid_mime_types: 0, ssrf_blocked: 0, too_large: 0 },
        lineId: NCL_ID
      }),
    "production_copy_broken_url"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionCopyPlan({
        inspected: [{ entity_id: "x", cruise_line_id: NCL_ID, status: "invalid_mime" }],
        summary: { broken_urls: 0, invalid_mime_types: 1, ssrf_blocked: 0, too_large: 0 },
        lineId: NCL_ID
      }),
    "production_copy_invalid_mime"
  );
  passed += 1;

  const okPlan = assertProductionCopyPlan({
    inspected: [
      {
        entity_id: "a",
        cruise_line_id: NCL_ID,
        status: "proposed_upload",
        bytes: 100,
        oversized: false
      },
      {
        entity_id: "b",
        cruise_line_id: NCL_ID,
        status: "already_copied",
        bytes: 50,
        oversized: false
      }
    ],
    summary: {
      broken_urls: 0,
      invalid_mime_types: 0,
      ssrf_blocked: 0,
      too_large: 0,
      estimated_upload_bytes: 100
    },
    lineId: NCL_ID,
    lineName: "Norwegian Cruise Line"
  });
  assert(okPlan.canonical_url_changes_on_copy === 0, "canonical changes 0");
  assert(okPlan.candidate_count === 2, "count 2");
  passed += 1;

  assert(assertCopyDidNotChangeCiUrls([{ ci_url_changed: false }]) === true, "ci unchanged");
  assertThrows(
    () => assertCopyDidNotChangeCiUrls([{ ci_url_changed: true }]),
    "production_copy_ci_url_changed"
  );
  passed += 1;

  const banner = formatTargetBanner(prodResolved, "dry-run");
  assert(!banner.includes("dev-secret") && !banner.includes("prod-secret"), "no secrets");
  assert(projectRefFromUrl(`https://${PRODUCTION_REF}.supabase.co`) === PRODUCTION_REF, "ref");
  passed += 1;

  console.log(`PASS ${passed} squarespace target + general production-copy-gate tests`);
}

main();
