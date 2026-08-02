#!/usr/bin/env node
/**
 * Discovery departure port validation tests.
 * Run: npm run test:discovery-departure-port
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  resolveRawPortText,
  resolveDepartureFromSource,
  isRejectedPortText,
  mergeDeparturePortForUpsert,
  extractDepartureCandidates,
  legacyExtractDeparturePort,
  compactDepartureAudit
} = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));
const { validateCruise } = require(path.join(root, "netlify/functions/lib/cruise-discovery.js"));
const { isExcludedCruiseLine } = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
  }
}

function baseCandidate(overrides = {}) {
  return {
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-09-11",
    official_url: "https://example.com/cruise",
    departure_port_meta: {
      status: "resolved",
      canonicalPortName: "Sydney",
      confidence: "exact"
    },
    departure_port: "Sydney",
    raw_extract: {},
    ...overrides
  };
}

async function main() {
  await test("Explicit departure_port resolves correctly", () => {
    const out = resolveRawPortText("Sydney, Australia");
    assert(out.status === "resolved", out.status);
    assert(out.canonicalPortName === "Sydney", out.canonicalPortName);
  });

  await test("Approved alias resolves correctly (Perth → Fremantle)", () => {
    const out = resolveRawPortText("Perth (Fremantle), Australia");
    assert(out.status === "resolved", out.status);
    assert(out.canonicalPortName === "Fremantle", out.canonicalPortName);
    assert(out.confidence === "alias" || out.confidence === "exact", out.confidence);
  });

  await test("Rome (Civitavecchia) resolves safely", () => {
    const out = resolveRawPortText("Rome (Civitavecchia), Italy");
    assert(out.status === "resolved", out.status);
    assert(out.canonicalPortName === "Civitavecchia", out.canonicalPortName);
  });

  await test("Glacier Majesty is rejected", () => {
    assert(isRejectedPortText("Glacier Majesty").rejected, "not rejected");
    const out = resolveRawPortText("Glacier Majesty");
    assert(out.status === "invalid", out.status);
  });

  await test("Alaska region is rejected", () => {
    assert(isRejectedPortText("Alaska").rejected, "not rejected");
    const out = resolveRawPortText("Alaska");
    assert(out.status === "invalid", out.status);
  });

  await test("Ship name is rejected as a port", () => {
    const out = resolveRawPortText("EXPLORA III", { shipName: "EXPLORA III" });
    assert(out.status === "invalid", out.status);
  });

  await test("Destination region is rejected as a port", () => {
    const out = resolveRawPortText("Alaska", { destinationName: "Alaska" });
    assert(out.status === "invalid", out.status);
  });

  await test("Missing departure is classified as missing", () => {
    const out = resolveDepartureFromSource({ title: "Generic cruise page" });
    assert(out.status === "missing", out.status);
  });

  await test("Explora source resolves Vancouver instead of Glacier Majesty", () => {
    const out = resolveDepartureFromSource({
      title: "A Grand Journey from Glacier Majesty to Japanese Grace",
      description:
        "Journey aboard EXPLORA III for 16 nights sailing from Vancouver via Ketchikan, Sitka and Sailing the Hubbard Glacier. Departing 11th September 2027.",
      shipName: "EXPLORA III",
      destinationName: "Alaska"
    });
    assert(out.status === "resolved", `${out.status}: ${out.reason}`);
    assert(out.canonicalPortName === "Vancouver", out.canonicalPortName);
  });

  await test("Regent title route extracts Whittier", () => {
    const out = resolveDepartureFromSource({
      title: "Alaska Luxury Cruise - Whittier to Vancouver on Aug 05, 2026 | Regent Seven Seas Cruises",
      description:
        "Plan your all-inclusive luxury cruise to Alaska from Whittier to Vancouver aboard Seven Seas Explorer for 7-nights on Aug 05, 2026 with Regent Seven Seas Cruises."
    });
    assert(out.status === "resolved", out.status);
    assert(out.canonicalPortName === "Whittier", out.canonicalPortName);
  });

  await test("Crystal description resolves Seward instead of Alaska region", () => {
    const out = resolveDepartureFromSource({
      title: "Crystal Symphony - Seward (Anchorage, Alaska) to Tokyo | Transoceanic | Crystal Cruises",
      description:
        "Embark on an incredible 14-night voyage that crosses the Pacific Ocean from Alaska to Japan. Setting sail from Seward, we come to the quaint fishing harbor of Homer."
    });
    assert(out.status === "resolved", `${out.status}: ${out.reason}`);
    assert(out.canonicalPortName === "Seward", out.canonicalPortName);
  });

  await test("First itinerary stop is not used without embarkation evidence", () => {
    const candidates = extractDepartureCandidates({
      itineraryStops: [{ day: 2, name: "Juneau" }, { day: 3, name: "Skagway" }]
    });
    assert(!candidates.some((c) => /Juneau/i.test(c.value)), JSON.stringify(candidates));
  });

  await test("Explicit embarkation itinerary stop may be used", () => {
    const out = resolveDepartureFromSource({
      itineraryStops: [{ day: 1, role: "embarkation", name: "Seattle, Washington" }]
    });
    assert(out.status === "resolved", out.status);
    assert(out.canonicalPortName === "Seattle", out.canonicalPortName);
  });

  await test("Valid existing canonical port is not overwritten by invalid update", () => {
    const merged = mergeDeparturePortForUpsert(
      {
        departure_port: "Seattle",
        raw_extract: {
          departure_port_meta: { status: "resolved", canonicalPortName: "Seattle", confidence: "exact" }
        }
      },
      {
        departure_port: "Alaska",
        departure_port_meta: { status: "invalid", rawValue: "Alaska" }
      }
    );
    assert(merged.departure_port === "Seattle", merged.departure_port);
    assert(merged.blocked, "should block");
  });

  await test("Valid existing canonical port is not overwritten by null", () => {
    const merged = mergeDeparturePortForUpsert(
      {
        departure_port: "Seattle",
        raw_extract: {
          departure_port_meta: { status: "resolved", canonicalPortName: "Seattle", confidence: "exact" }
        }
      },
      {
        departure_port: null,
        departure_port_meta: { status: "missing" }
      }
    );
    assert(merged.departure_port === "Seattle", merged.departure_port);
  });

  await test("Higher-confidence valid canonical update may replace earlier valid value", () => {
    const merged = mergeDeparturePortForUpsert(
      {
        departure_port: "Seattle",
        raw_extract: {
          departure_port_meta: { status: "resolved", canonicalPortName: "Seattle", confidence: "alias" }
        }
      },
      {
        departure_port: "Seattle",
        departure_port_meta: { status: "resolved", canonicalPortName: "Seattle", confidence: "exact" }
      }
    );
    assert(merged.departure_port === "Seattle", merged.departure_port);
    assert(!merged.blocked, "should allow equal/higher confidence");
  });

  await test("Manual Admin correction is protected from automatic overwrite", () => {
    const merged = mergeDeparturePortForUpsert(
      {
        departure_port: "Vancouver",
        raw_extract: {
          departure_port_meta: {
            status: "resolved",
            canonicalPortName: "Vancouver",
            confidence: "exact",
            manual: true
          }
        }
      },
      {
        departure_port: "Seattle",
        departure_port_meta: { status: "resolved", canonicalPortName: "Seattle", confidence: "exact" }
      }
    );
    assert(merged.departure_port === "Vancouver", merged.departure_port);
    assert(merged.reason === "manual_correction_protected", merged.reason);
  });

  await test("Customer-ready validation blocks unresolved departures", () => {
    const reasons = validateCruise(
      baseCandidate({
        departure_port: null,
        departure_port_meta: { status: "missing" },
        raw_extract: { departure_port_meta: { status: "missing" } }
      })
    );
    assert(reasons.some((r) => /Missing departure port/i.test(r)), reasons.join("; "));
  });

  await test("Legacy extractor documented for Glacier Majesty false positive", () => {
    const legacy = legacyExtractDeparturePort(
      "A Grand Journey from Glacier Majesty to Japanese Grace\nJourney aboard EXPLORA III for 16 nights sailing from Vancouver"
    );
    assert(legacy === "Glacier Majesty", "legacy still false-positive for comparison");
  });

  await test("P&O Cruises Australia remains excluded from Finder", () => {
    assert(isExcludedCruiseLine("P&O Cruises Australia"), "P&O excluded");
  });

  await test("Discovery Admin API requires authentication boundary", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
    const handler = src.slice(src.indexOf("exports.handler"));
    assert(/requireAdmin\(event\)/.test(handler), "requireAdmin used in handler");
    assert(
      handler.indexOf("requireAdmin") < handler.indexOf("manual_resolve_departure_port"),
      "auth before manual_resolve_departure_port"
    );
    assert(
      handler.indexOf("requireAdmin") < handler.indexOf("list_departure_ports"),
      "auth before list_departure_ports"
    );
    assert(
      handler.indexOf("requireAdmin") < handler.indexOf("list_cruises"),
      "auth before list_cruises"
    );
  });

  await test("list_cruises uses explicit destinations foreign key embed", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
    assert(
      /destinations!discovered_cruises_destination_id_fkey\(name,slug\)/.test(src),
      "list_cruises must disambiguate destinations embed"
    );
    assert(!/destinations\(name,slug\)/.test(src), "ambiguous destinations embed must not remain");
  });

  await test("list_cruises uses compact departure audit fields only", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
    assert(/compactDepartureAudit/.test(src), "compact mapper used");
    assert(/departure_audit,/.test(src.replace(/\s+/g, " ")), "list returns departure_audit");
    assert(!/raw_extract,/.test(src.split("return {")[1] || ""), "raw_extract not included in list response object");
    const audit = compactDepartureAudit(
      {
        title: "Secret marketing title",
        description: "Secret body ".repeat(50),
        departure_port_meta: { status: "invalid", reason: "region", rawValue: "Alaska" },
        departure_port_merge: { blocked: true, reason: "valid_not_overwritten_by_unresolved" },
        discovery_11d2: { adapter: "generic", source_method: "brave_fallback" }
      },
      { departure_port: "Alaska", official_url: "https://example.com/cruise" }
    );
    assert(!Object.prototype.hasOwnProperty.call(audit, "title"), "no raw title");
    assert(!Object.prototype.hasOwnProperty.call(audit, "description"), "no raw description");
    assert(audit.validation_status === "invalid", audit.validation_status);
    assert(audit.source_provider === "generic", "provider included");
  });

  await test("Public search-current-cruises does not expose raw_extract or departure_port_meta", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/search-current-cruises.js"), "utf8");
    assert(!/raw_extract/.test(src), "no raw_extract reference");
    assert(!/departure_port_meta/.test(src), "no departure_port_meta reference");
  });

  await test("Public destination API does not expose raw_extract", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/public-destination.js"), "utf8");
    assert(!/raw_extract/.test(src), "no raw_extract in public destination API");
  });

  await test("Existing active rows are not auto-deactivated on reprocess", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-ops.js"), "utf8");
    assert(
      /prev\.status === "active" && status !== "active"/.test(src),
      "active preservation guard present"
    );
  });

  await test("Manual departure resolution merges Supabase ports catalogue", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
    assert(/loadSupabasePortsForMatching/.test(src), "loads Supabase ports for admin matching");
    assert(/mergePortCatalogues/.test(src), "merges CSV and Supabase catalogues");
    assert(/resolveAdminDeparturePort/.test(src), "admin resolver helper present");
    assert(/ports: mergedPorts/.test(src), "passes merged ports to resolveRawPortText");
  });

  await test("resolveRawPortText accepts injected ports catalogue", () => {
    const injected = [
      { canonical_name: "San Diego", display_name: "San Diego", country: "United States", aliases: [] }
    ];
    const resolved = resolveRawPortText("San Diego", { ports: injected });
    assert(resolved.status === "resolved", resolved.status);
    assert(resolved.canonicalPortName === "San Diego", resolved.canonicalPortName);
  });

  await test("hide_discovered_cruise action is admin-authenticated", () => {
    const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
    const handler = src.slice(src.indexOf("exports.handler"));
    assert(/hide_discovered_cruise/.test(src), "hide action registered");
    assert(
      handler.indexOf("requireAdmin") < handler.indexOf("hide_discovered_cruise"),
      "auth before hide_discovered_cruise"
    );
  });

  await test("Review Queue uses safe data-action buttons instead of fragile onclick", () => {
    const src = fs.readFileSync(path.join(root, "js/admin-cruise-discovery.js"), "utf8");
    assert(/data-cd-review-action/.test(src), "review action data attributes present");
    assert(/bindReviewQueueActions/.test(src), "delegated review click handler present");
    assert(!/resolveGroup\(\$\{groupIdJson\}/.test(src), "fragile inline resolveGroup onclick removed");
    assert(/match_destination/.test(src), "destination match action supported");
  });

  await test("Browse Active UI exposes Add port and Remove actions", () => {
    const src = fs.readFileSync(path.join(root, "js/admin-cruise-discovery.js"), "utf8");
    assert(/openAddPort/.test(src), "openAddPort helper present");
    assert(/removeCruise/.test(src), "removeCruise helper present");
    assert(/Add port/.test(src), "Add port button rendered");
    assert(/Remove/.test(src), "Remove button rendered");
  });

  await test("Remediation script imports resolveRawPortText from shared module", () => {
    const src = fs.readFileSync(
      path.join(root, "scripts/remediate-discovered-cruise-departures.mjs"),
      "utf8"
    );
    assert(
      /resolveRawPortText,\s*\n\s*loadPortsCatalogue/.test(src),
      "resolveRawPortText imported alongside shared helpers"
    );
    assert(
      /discovery-departure-port\.js/.test(src),
      "import sourced from discovery-departure-port.js"
    );
    assert(!/function resolveRawPortText/.test(src), "resolveRawPortText not redefined in script");
    const shared = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));
    assert(typeof shared.resolveRawPortText === "function", "shared module exports resolveRawPortText");
    assert(shared.resolveRawPortText("Sydney").status === "resolved", "resolveRawPortText usable from shared module");
  });

  await test("Remediation dry-run completes without ReferenceError", () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return;
    }
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/remediate-discovered-cruise-departures.mjs"), "--dry-run"],
      { encoding: "utf8", env: process.env }
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert(result.status === 0, `dry-run exit code ${result.status}: ${output}`);
    assert(!/ReferenceError.*resolveRawPortText/.test(output), "no resolveRawPortText ReferenceError");
    assert(/No database writes performed \(dry-run\)/.test(output), "dry-run remains read-only");
  });

  await test("Remediation apply manifest parsing completes without writes", () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return;
    }
    const manifestPath = path.join(
      root,
      "reports/departure-remediation-2026-08-02T02-06-05-790Z.json"
    );
    if (!fs.existsSync(manifestPath)) {
      return;
    }
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/remediate-discovered-cruise-departures.mjs"),
        "--apply",
        `--manifest=${manifestPath}`
      ],
      { encoding: "utf8", env: process.env }
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert(result.status === 0, `apply validation exit code ${result.status}: ${output}`);
    assert(!/ReferenceError.*resolveRawPortText/.test(output), "no resolveRawPortText ReferenceError");
    const updatedMatch = output.match(/"updated":\s*(\d+)/);
    assert(updatedMatch, "apply results include updated count");
    assert(Number(updatedMatch[1]) === 0, "apply must not write when before values no longer match manifest");
  });

  await test("Remediation apply mode requires approved manifest", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/remediate-discovered-cruise-departures.mjs"), "--apply"],
      { encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" } }
    );
    assert(result.status !== 0, "apply without manifest must fail");
    assert(
      /requires --manifest/.test(result.stderr || result.stdout || ""),
      "manifest requirement message"
    );
  });

  await test("Remediation dry-run remains read-only without Supabase credentials", () => {
    const result = spawnSync(process.execPath, [
      path.join(root, "scripts/remediate-discovered-cruise-departures.mjs"),
      "--dry-run"
    ], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" }
    });
    assert(result.status !== 0, "dry-run without credentials should fail safely without writes");
  });

  await test("Generated remediation reports are gitignored", () => {
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert(/reports\/departure-remediation-\*\.json/.test(ignore), "remediation json ignored");
    assert(/departure-remediation-rollback-\*\.json/.test(ignore), "rollback json ignored");
  });

  const failed = results.filter((r) => !r.ok);
  for (const row of results) {
    console.log(row.ok ? `✓ ${row.name}` : `✗ ${row.name}: ${row.error}`);
  }
  if (failed.length) {
    process.exitCode = 1;
    throw new Error(`${failed.length} test(s) failed`);
  }
  console.log(`\ntest-discovery-departure-port: ${results.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
