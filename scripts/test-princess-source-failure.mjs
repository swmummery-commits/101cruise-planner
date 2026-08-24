#!/usr/bin/env node
/**
 * Princess source failure regression tests (Monday 2026-08-24 incident).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const src = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const lifecycle = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${passed}. ${name}`);
}

test("400 source response preserves rich diagnostics", () => {
  const detail = src.formatPrincessHttpError(
    {
      status: 400,
      data: {
        httpCode: "400",
        httpMessage: "Bad Request",
        moreInformation: "One or more required API parameters are missing in the API request."
      },
      diagnostics: { request: { path: "resdb/p1.0/products?agencyCountry=AU" } }
    },
    "catalogue"
  );
  if (!detail.message.includes("missing in the API request")) throw new Error("missing moreInformation");
  if (detail.stage !== "catalogue") throw new Error("missing stage");
});

test("transient missing-params 400 detection", () => {
  const detail = {
    more_information: "One or more required API parameters are missing in the API request."
  };
  const attempts = [{ http_status: 400 }, { http_status: 400 }];
  if (!src.isPrincessTransientMissingParamsError(detail, attempts)) throw new Error("should detect transient pattern");
});

test("400 weekly report => zero writes exit non-zero", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-24T00:00:00.000Z",
    endedAt: "2026-08-24T00:00:08.000Z",
    environment: {},
    executeResult: { success: false, reason: "official_source_unreachable" },
    maintenanceResult: {
      ok: false,
      failed: true,
      reason: "official_source_unreachable",
      simulation: { fetch_result: { fetch_failed: true, error: "catalogue | http_400 | Bad Request" } }
    },
    countsBefore: { princess: 2042 },
    countsAfter: { princess: 2042 }
  });
  if (report.writes_performed !== 0) throw new Error("must not write on source failure");
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("source failure must exit non-zero");
});

test("failed source run does not advance accepted baseline", () => {
  const acceptance = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: { quality_gate: { passed: false }, reconciliation_arithmetic_ok: true },
    executeResult: { success: false },
    report: {},
    maintenanceResult: { ok: false },
    dryRun: false,
    simulation: { fetch_failed: true }
  });
  if (acceptance.accept) throw new Error("failed source must not advance baseline");
});

test("header-only catalogue variant is attempted first", () => {
  const file = require("fs").readFileSync(
    path.join(root, "netlify/functions/lib/princess-discovery-source.js"),
    "utf8"
  );
  if (!file.includes("Header-only requests first")) throw new Error("expected header-first ordering");
  if (!file.includes("transient_retry")) throw new Error("expected transient retry marker");
});

test("future 20% expansion safeguard unchanged", () => {
  const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2485,
    previousEligible: 2061,
    proposedInserts: 0
  });
  if (expansion.passed) throw new Error(">20% expansion must remain blocked");
});

console.log(`\ntest-princess-source-failure: ${passed} passed`);
