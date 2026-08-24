#!/usr/bin/env node
/**
 * Princess source failure + scheduled retry regression tests (Monday 2026-08-24 P1B).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const src = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const lifecycle = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const updatePolicy = require(path.join(root, "netlify/functions/lib/princess-weekly-update-policy"));

const TRANSIENT_400_BODY = {
  httpCode: "400",
  httpMessage: "Bad Request",
  moreInformation: "One or more required API parameters are missing in the API request."
};

const MINIMAL_PRODUCTS = {
  products: [
    {
      id: "IT001",
      trades: [{ id: "C" }],
      subTrades: [{ id: "C1" }],
      sailings: [
        {
          id: "S001",
          sailDate: "20270101",
          ship: { id: "GP" },
          embarkPort: { id: "SYD" },
          disembarkPort: { id: "MEL" }
        }
      ]
    }
  ]
};

function bootstrapOk() {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: JSON.stringify({
      ube: {
        settings: {
          productCompany: "PC",
          features: { bookingCompanyCode: "PA" }
        }
      }
    }),
    setCookie: ["session=abc; Path=/"]
  };
}

function jsonResponse(status, data) {
  return {
    status,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(data),
    setCookie: []
  };
}

let passed = 0;
function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      passed += 1;
      console.log(`✓ ${passed}. ${name}`);
    });
  }
  passed += 1;
  console.log(`✓ ${passed}. ${name}`);
}

const tests = [];

tests.push(() => {
  const detail = src.formatPrincessHttpError(
    {
      status: 400,
      data: TRANSIENT_400_BODY,
      diagnostics: { request: { path: "resdb/p1.0/products?agencyCountry=AU" } }
    },
    "catalogue"
  );
  if (!detail.message.includes("missing in the API request")) throw new Error("missing moreInformation");
  if (detail.stage !== "catalogue") throw new Error("missing stage");
});

tests.push(() => {
  const detail = { more_information: TRANSIENT_400_BODY.moreInformation };
  const attempts = [{ http_status: 400 }, { http_status: 400 }];
  if (!src.isPrincessTransientMissingParamsError(detail, attempts)) throw new Error("should detect transient pattern");
});

tests.push(async () => {
  let catalogueCalls = 0;
  src.__setPrincessTransportGetForTests(async (url) => {
    if (url.includes("/resdb/p1.0/products")) {
      catalogueCalls += 1;
      if (catalogueCalls <= 4) return jsonResponse(400, TRANSIENT_400_BODY);
      return jsonResponse(200, MINIMAL_PRODUCTS);
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const result = await src.fetchPrincessResdbCatalogue({
      session: { clientId: "test-client", cookie: "x=y", productCompany: "PC", bookingCompany: "PA" },
      collectDiagnostics: false
    });
    if (!result.ok) throw new Error(`expected success got ${result.error}`);
    if (catalogueCalls !== 5) throw new Error(`expected 5 catalogue calls (4+retry) got ${catalogueCalls}`);
    if (!result.diagnostics?.transient_retry) throw new Error("expected transient_retry marker");
  } finally {
    src.__resetPrincessTransportGetForTests();
  }
});

tests.push(async () => {
  let catalogueCalls = 0;
  src.__setPrincessTransportGetForTests(async (url) => {
    if (url.includes("/resdb/p1.0/products")) {
      catalogueCalls += 1;
      if (catalogueCalls <= 4) return jsonResponse(400, TRANSIENT_400_BODY);
      return jsonResponse(200, MINIMAL_PRODUCTS);
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const result = await src.fetchPrincessResdbCatalogue({
      session: { clientId: "test-client", cookie: "x=y", productCompany: "PC", bookingCompany: "PA" },
      collectDiagnostics: true
    });
    if (!result.ok) throw new Error("expected success");
    if (catalogueCalls !== 5) throw new Error(`expected exactly one retry, calls=${catalogueCalls}`);
    if (!result.diagnostics?.transient_retry) throw new Error("missing transient_retry");
    if (!result.diagnostics?.attempts?.some((a) => a.retry_after_transient_400)) {
      throw new Error("missing retry_after_transient_400 diagnostic");
    }
    const leaked = JSON.stringify(result.diagnostics).toLowerCase();
    if (leaked.includes("pcl-client-id") || leaked.includes("authorization")) {
      throw new Error("diagnostics leaked secrets");
    }
  } finally {
    src.__resetPrincessTransportGetForTests();
  }
});

tests.push(async () => {
  let catalogueCalls = 0;
  src.__setPrincessTransportGetForTests(async (url) => {
    if (url.includes("/resdb/p1.0/products")) {
      catalogueCalls += 1;
      return jsonResponse(400, {
        httpCode: "400",
        httpMessage: "Bad Request",
        moreInformation: "Invalid cruise type supplied."
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const result = await src.fetchPrincessResdbCatalogue({
      session: { clientId: "test-client", productCompany: "PC", bookingCompany: "PA" },
      collectDiagnostics: false
    });
    if (result.ok) throw new Error("expected failure");
    if (catalogueCalls !== 4) throw new Error(`expected 4 variant attempts only, got ${catalogueCalls}`);
  } finally {
    src.__resetPrincessTransportGetForTests();
  }
});

for (const status of [401, 403, 404]) {
  tests.push(async () => {
    let catalogueCalls = 0;
    src.__setPrincessTransportGetForTests(async (url) => {
      if (url.includes("/resdb/p1.0/products")) {
        catalogueCalls += 1;
        return jsonResponse(status, { httpMessage: "Denied" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    try {
      const result = await src.fetchPrincessResdbCatalogue({
        session: { clientId: "test-client", productCompany: "PC", bookingCompany: "PA" },
        collectDiagnostics: false
      });
      if (result.ok) throw new Error("expected failure");
      if (catalogueCalls !== 4) throw new Error(`expected 4 attempts, got ${catalogueCalls}`);
    } finally {
      src.__resetPrincessTransportGetForTests();
    }
  });
}

tests.push(async () => {
  src.__setPrincessTransportGetForTests(async (url) => {
    if (url.includes("/resdb/p1.0/products")) return jsonResponse(400, TRANSIENT_400_BODY);
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const result = await src.fetchPrincessResdbCatalogue({
      session: { clientId: "test-client", productCompany: "PC", bookingCompany: "PA" },
      collectDiagnostics: false
    });
    if (result.ok) throw new Error("expected failure after retry 400");
  } finally {
    src.__resetPrincessTransportGetForTests();
  }
});

tests.push(() => {
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

tests.push(() => {
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

tests.push(() => {
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2485,
    previousEligible: 2061,
    proposedInserts: 0
  });
  if (expansion.passed) throw new Error(">20% expansion must remain blocked");
});

tests.push(() => {
  if (quality.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("weekly write cap must remain 30");
});

tests.push(() => {
  const diffs = updatePolicy.diffPrincessUpdateCandidate(
    { ship_id: "a", destination_id: "d1", departure_date: "2027-01-01" },
    { ship_id: "b", destination_id: "d1", departure_date: "2027-01-01" }
  );
  const risk = updatePolicy.classifyPrincessUpdateRisk(diffs);
  if (risk.risk !== "HIGH") throw new Error("ship_id change must be HIGH risk");
});

tests.push(() => {
  const diffs = updatePolicy.diffPrincessUpdateCandidate(
    { official_url: "https://old.example" },
    { official_url: "https://new.example" }
  );
  const risk = updatePolicy.classifyPrincessUpdateRisk(diffs);
  if (risk.risk !== "LOW") throw new Error("official_url-only should be LOW");
});

tests.push(() => {
  const gate = quality.evaluatePrincessWeeklyQualityGate({
    metrics: {
      eligible_total: 2042,
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 100,
      destination_resolution_pct: 100,
      identity_coverage_pct: 100,
      duplicate_official_identities: 0
    },
    previousEligible: { stats: { eligible_total: 2061 } },
    manifest: {
      products: [{ proposed_action: "update_identity_review_required" }]
    },
    dryRun: false,
    simulation: { fetch_failed: false },
    summary: {},
    performWrites: true
  });
  if (gate.auto_apply_permitted) throw new Error("identity review updates must block auto apply");
});

tests.push(async () => {
  const perQueryCalls = new Map();
  src.__setPrincessTransportGetForTests(async (url) => {
    if (url.includes("/ube/")) return bootstrapOk();
    if (url.includes("/resdb/p1.0/products")) {
      const key = url.includes("light=false") ? "heavy" : "light";
      const n = (perQueryCalls.get(key) || 0) + 1;
      perQueryCalls.set(key, n);
      if (n <= 4) return jsonResponse(400, TRANSIENT_400_BODY);
      return jsonResponse(200, MINIMAL_PRODUCTS);
    }
    if (url.includes("/resdb/p1.0/ships")) return jsonResponse(200, { ships: [{ id: "GP", name: "Grand Princess" }] });
    if (url.includes("/resdb/p1.0/ports")) {
      return jsonResponse(200, {
        ports: [
          { id: "SYD", name: "Sydney" },
          { id: "MEL", name: "Melbourne" }
        ]
      });
    }
    throw new Error(`unexpected url ${url}`);
  });

  try {
    const fetch = await src.fetchAllPrincessRawSailings({ collectDiagnostics: false, today: "2026-08-24" });
    if (fetch.fetch_failed) throw new Error("scheduled-equivalent fetch must succeed after retry");
    if ((perQueryCalls.get("light") || 0) < 5) throw new Error("light catalogue retry not exercised");
    const retryEvidence = fetch.source_diagnostics?.catalogue?.transient_retry;
    if (!retryEvidence) throw new Error("missing transient_retry on scheduled-equivalent fetch");
  } finally {
    src.__resetPrincessTransportGetForTests();
  }
});

const names = [
  "400 source response preserves rich diagnostics",
  "transient missing-params 400 detection",
  "transient retry works with collectDiagnostics=false",
  "transient retry works with collectDiagnostics=true",
  "arbitrary HTTP 400 is not retried",
  "HTTP 401 is not retried",
  "HTTP 403 is not retried",
  "HTTP 404 is not retried",
  "transient retry second 400 fails safely",
  "400 weekly report => zero writes exit non-zero",
  "failed source run does not advance accepted baseline",
  "future 20% expansion safeguard unchanged",
  "30-write cap unchanged",
  "update field-diff helper detects ship_id change as HIGH",
  "official_url-only change is LOW risk metadata",
  "identity-critical weekly policy blocks auto apply in quality gate",
  "scheduled production-equivalent fetchAllPrincessRawSailings retry (collectDiagnostics=false)"
];

for (let i = 0; i < tests.length; i += 1) {
  await test(names[i], tests[i]);
}

console.log(`\ntest-princess-source-failure: ${passed} passed`);
