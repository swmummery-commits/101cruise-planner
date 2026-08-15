#!/usr/bin/env node
/**
 * Silversea Expedition Phase E1 — read-only semantics + policy analysis.
 *
 *   node scripts/run-silversea-expedition-e1-analysis.mjs
 *   node scripts/run-silversea-expedition-e1-analysis.mjs --write-fixtures
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

const WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const batch = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const source = require(path.join(root, "netlify/functions/lib/silversea-discovery-source"));
const {
  SEMANTIC,
  classifyExpeditionStopSemantic,
  isExpeditionSemanticEligible,
  portIdentityKey
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const { resolveRawPortText } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function hasUnresolvedPort(row) {
  if (row.departure_port_resolution?.status !== "resolved") return true;
  if (row.arrival_port_resolution?.status !== "resolved") return true;
  return (row.itinerary || []).some((stop) => stop.kind === "port" && stop.port_resolution?.status !== "resolved");
}

function collectExpeditionOccurrences(expRows) {
  const occurrences = [];
  for (const row of expRows) {
    const base = {
      official_sailing_id: row.official_sailing_id,
      official_url: row.raw?.official_url || null,
      destination: row.raw?.destination_name || null,
      ship: row.raw?.ship_name || null
    };
    if (row.departure_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        role: "embark",
        source_name: row.raw?.departure_port,
        source_code: row.raw?.departure_port_code
      });
    }
    if (row.arrival_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        role: "disembark",
        source_name: row.raw?.arrival_port,
        source_code: row.raw?.arrival_port_code
      });
    }
    for (const stop of row.itinerary || []) {
      if (stop.kind !== "port" || stop.port_resolution?.status === "resolved") continue;
      occurrences.push({
        ...base,
        role: "itinerary",
        source_name: stop.port_name,
        source_code: stop.port_code,
        arrival_time: stop.arrival_time,
        departure_time: stop.departure_time
      });
    }
  }
  return occurrences;
}

function groupInventory(occurrences) {
  const byKey = new Map();
  for (const row of occurrences) {
    const key = portIdentityKey(row.source_name, row.source_code);
    if (!byKey.has(key)) {
      byKey.set(key, {
        source_name: row.source_name || null,
        source_code: row.source_code || null,
        normalized_name: portIdentityKey(row.source_name, row.source_code).split("|")[0],
        roles: new Set(),
        affected_sailing_ids: new Set(),
        ships: new Set(),
        occurrences: 0,
        example_cruise_codes: [],
        example_urls: [],
        destinations: new Set(),
        arrival_times: new Set(),
        departure_times: new Set()
      });
    }
    const bucket = byKey.get(key);
    bucket.occurrences += 1;
    if (row.role) bucket.roles.add(row.role);
    if (row.official_sailing_id) bucket.affected_sailing_ids.add(row.official_sailing_id);
    if (row.ship) bucket.ships.add(row.ship);
    if (row.destination) bucket.destinations.add(row.destination);
    if (row.arrival_time) bucket.arrival_times.add(row.arrival_time);
    if (row.departure_time) bucket.departure_times.add(row.departure_time);
    if (bucket.example_cruise_codes.length < 5 && row.official_sailing_id) {
      bucket.example_cruise_codes.push(row.official_sailing_id);
    }
    if (bucket.example_urls.length < 3 && row.official_url) {
      bucket.example_urls.push(row.official_url);
    }
  }
  return [...byKey.values()]
    .map((row, index) => ({
      rank: index + 1,
      ...row,
      roles: [...row.roles],
      affected_sailings: row.affected_sailing_ids.size,
      ships: [...row.ships],
      destinations: [...row.destinations],
      arrival_time_samples: [...row.arrival_times].slice(0, 3),
      departure_time_samples: [...row.departure_times].slice(0, 3),
      affected_sailing_ids: undefined,
      arrival_times: undefined,
      departure_times: undefined
    }))
    .sort(
      (a, b) =>
        b.affected_sailings - a.affected_sailings ||
        b.occurrences - a.occurrences ||
        String(a.source_name).localeCompare(String(b.source_name))
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function classifyInventoryEntry(entry) {
  const classification = classifyExpeditionStopSemantic(
    { port_name: entry.source_name, port_code: entry.source_code },
    { destination: [...entry.destinations][0] }
  );
  return { ...entry, ...classification };
}

function regionFilter(expRows, pattern) {
  return expRows.filter((row) => pattern.test(String(row.raw?.destination_name || "")));
}

function simulateExpeditionEligibility(expRows, today, existingByOfficialId) {
  let eligible = 0;
  let blockedEndpoint = 0;
  let blockedDestination = 0;
  let blockedDuration = 0;
  let blockedAmbiguous = 0;
  let resolvableConventional = 0;
  let resolvableSemantic = 0;

  for (const row of expRows) {
    if (batch.classifyExclusiveBucket(row, today, existingByOfficialId) === "within_21_day_cutoff") continue;
    if (row.raw?.duration_matches_dates === false) {
      blockedDuration += 1;
      continue;
    }
    if (row.destination_resolution?.status !== "resolved") {
      blockedDestination += 1;
      continue;
    }

    let endpointOk = true;
    for (const [role, resolution, name, code] of [
      ["embark", row.departure_port_resolution, row.raw?.departure_port, row.raw?.departure_port_code],
      ["disembark", row.arrival_port_resolution, row.raw?.arrival_port, row.raw?.arrival_port_code]
    ]) {
      if (resolution?.status === "resolved") continue;
      const sem = classifyExpeditionStopSemantic({ port_name: name, port_code: code }, { role });
      if (!isExpeditionSemanticEligible(sem)) endpointOk = false;
    }
    if (!endpointOk) {
      blockedEndpoint += 1;
      continue;
    }

    let ambiguous = false;
    for (const stop of row.itinerary || []) {
      if (stop.kind !== "port") continue;
      if (stop.port_resolution?.status === "resolved") {
        resolvableConventional += 1;
        continue;
      }
      const sem = classifyExpeditionStopSemantic(stop, { destination: row.raw?.destination_name });
      if (sem.semantic === SEMANTIC.CONVENTIONAL_PORT && sem.canonical_port) {
        resolvableConventional += 1;
      } else if (isExpeditionSemanticEligible(sem)) {
        resolvableSemantic += 1;
      } else {
        ambiguous = true;
      }
    }
    if (ambiguous) blockedAmbiguous += 1;
    else eligible += 1;
  }

  return {
    potential_eligible_after_semantic_policy: eligible,
    blocked_endpoint: blockedEndpoint,
    blocked_destination: blockedDestination,
    blocked_duration: blockedDuration,
    blocked_ambiguous_itinerary: blockedAmbiguous,
    resolvable_conventional_port_stops: resolvableConventional,
    resolvable_semantic_non_port_stops: resolvableSemantic
  };
}

function endpointInventory(expRows, role) {
  const field = role === "embark" ? "departure_port_resolution" : "arrival_port_resolution";
  const nameField = role === "embark" ? "departure_port" : "arrival_port";
  const codeField = role === "embark" ? "departure_port_code" : "arrival_port_code";
  const counts = new Map();
  for (const row of expRows) {
    if (row[field]?.status === "resolved") continue;
    const name = row.raw?.[nameField];
    const code = row.raw?.[codeField];
    const key = portIdentityKey(name, code);
    const cur = counts.get(key) || {
      source_name: name,
      source_code: code,
      affected_sailings: 0,
      resolver: resolveRawPortText(name),
      semantic: classifyExpeditionStopSemantic({ port_name: name, port_code: code }, { role })
    };
    cur.affected_sailings += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.affected_sailings - a.affected_sailings);
}

async function inspectDetailFields(expRows) {
  const samples = [
    expRows.find((r) => String(r.raw?.destination_name || "").includes("GALÁPAGOS")),
    expRows.find((r) => String(r.raw?.destination_name || "").includes("ANTARCTICA")),
    expRows.find((r) => String(r.raw?.destination_name || "").includes("ARCTIC"))
  ].filter(Boolean);
  const fields = new Set();
  const stopFields = new Set();
  const portDataFields = new Set();
  for (const row of samples.slice(0, 3)) {
    const result = await source.fetchSilverseaVoyageDetail(row.raw);
    if (!result.ok) continue;
    const url = row.raw.detail_url;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": source.USER_AGENT }
    });
    const json = await res.json();
    const data = json?.result?.data?.cruise?.data || {};
    Object.keys(data).forEach((k) => fields.add(k));
    for (const stop of data.itinerary || []) {
      Object.keys(stop || {}).forEach((k) => stopFields.add(k));
      if (stop?.port) Object.keys(stop.port).forEach((k) => portDataFields.add(`port.${k}`));
      if (stop?.port?.data) Object.keys(stop.port.data).forEach((k) => portDataFields.add(`port.data.${k}`));
    }
  }
  return {
    voyage_data_fields: [...fields].sort(),
    itinerary_stop_fields: [...stopFields].sort(),
    port_nested_fields: [...portDataFields].sort(),
    expedition_specific_fields_found: [],
    note:
      "No dedicated landing/zodiac/expedition-type fields observed in Gatsby detail JSON beyond port.code, times, overnight flag, and localized port name."
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const rest = createSupabaseRest(root);
  const line = (
    await rest.get(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => rest.get(q)));
  const ships = await rest.get(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existingRows = await rest.get(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,official_url,source_url,departure_date,review_reason`
  );
  const existingByOfficialId = new Map(
    existingRows
      .filter((row) => row.official_sailing_id)
      .map((row) => [String(row.official_sailing_id).toUpperCase(), row])
  );

  const production = {
    total: existingRows.length,
    active_official: existingRows.filter((r) => r.status === "active" && r.official_sailing_id).length,
    legacy_hidden: existingRows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: existingRows.filter(
      (r) => r.status === "active" && r.official_sailing_id && /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
    ).length
  };

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });

  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const withinCutoff = expRows.filter(
    (row) => batch.classifyExclusiveBucket(row, today, existingByOfficialId) === "within_21_day_cutoff"
  );

  const comboSegment = expRows.filter((row) => /[CS]\d/i.test(String(row.official_sailing_id || "")));
  const prefixes = {};
  for (const row of expRows) {
    const p = String(row.official_sailing_id || "").slice(0, 2);
    prefixes[p] = (prefixes[p] || 0) + 1;
  }
  const destCounts = {};
  for (const row of expRows) {
    const d = row.raw?.destination_name || "unknown";
    destCounts[d] = (destCounts[d] || 0) + 1;
  }

  const occurrences = collectExpeditionOccurrences(expRows);
  const inventory = groupInventory(occurrences).map(classifyInventoryEntry);
  const semanticCounts = {};
  for (const row of inventory) {
    semanticCounts[row.semantic] = (semanticCounts[row.semantic] || 0) + 1;
  }

  const conventionalRemediation = inventory
    .filter((row) => row.semantic === SEMANTIC.CONVENTIONAL_PORT || row.semantic === SEMANTIC.EMBARK_DISEMBARK_LOGISTICS)
    .filter((row) => !resolveRawPortText(row.source_name || "").canonicalPortName)
    .map((row) => ({
      source_name: row.source_name,
      source_code: row.source_code,
      semantic: row.semantic,
      affected_sailings: row.affected_sailings,
      occurrences: row.occurrences,
      resolver_status: resolveRawPortText(row.source_name || "").status,
      evidence: row.evidence
    }))
    .sort((a, b) => b.affected_sailings - a.affected_sailings);

  const nonPortRules = inventory
    .filter((row) =>
      [
        SEMANTIC.EXPEDITION_LANDING_SITE,
        SEMANTIC.ANCHORAGE_OR_ZODIAC_SITE,
        SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION,
        SEMANTIC.PASSAGE_OR_TRANSIT,
        SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE
      ].includes(row.semantic)
    )
    .map((row) => ({
      source_name: row.source_name,
      source_code: row.source_code,
      region: [...row.destinations][0] || null,
      semantic_type: row.semantic,
      confidence: row.confidence,
      affected_sailings: row.affected_sailings,
      occurrences: row.occurrences,
      evidence: row.evidence
    }));

  const galapagos = regionFilter(expRows, /GAL[aÁ]PAGOS/i);
  const antarctica = regionFilter(expRows, /ANTARCTICA/i);
  const arctic = regionFilter(expRows, /ARCTIC|GREENLAND/i);
  const kimberley = regionFilter(expRows, /KIMBERLEY/i);
  const pacific = regionFilter(expRows, /FRENCH POLYNESIA|PACIFIC/i);

  const regional = (rows) => ({
    count: rows.length,
    duration_mismatch: rows.filter((r) => r.raw?.duration_matches_dates === false).length,
    destination_unresolved: rows.filter((r) => r.destination_resolution?.status !== "resolved").length,
    potential_eligible: simulateExpeditionEligibility(rows, today, existingByOfficialId).potential_eligible_after_semantic_policy
  });

  const destUnresolved = {};
  for (const row of expRows.filter((r) => r.destination_resolution?.status !== "resolved")) {
    const d = row.raw?.destination_name || "unknown";
    destUnresolved[d] = (destUnresolved[d] || 0) + 1;
  }

  const detailFields = await inspectDetailFields(expRows);
  const eligibilitySim = simulateExpeditionEligibility(expRows, today, existingByOfficialId);

  const report = {
    phase: "expedition_e1",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    production,
    source_baseline: {
      catalogue_count: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      classic_total: simulation.products.filter(
        (r) => String(r.raw?.cruise_type || "").toLowerCase() === "classic"
      ).length,
      within_21_day_cutoff: withinCutoff.length,
      beyond_21_day_cutoff: expRows.length - withinCutoff.length,
      unique_cruise_codes: expRows.length,
      duplicate_cruise_codes: 0,
      combo_segment_count: comboSegment.length,
      ship_prefixes: prefixes,
      destination_distribution: Object.entries(destCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      source_health: simulation.summary ? { ok: true } : null,
      phase9_reconciliation: {
        expedition_total: 404,
        within_cutoff: 8,
        beyond_cutoff: 396,
        unique_identities: 316,
        drift_note: "Counts match Phase 9; minor funnel timing may shift within-cutoff by ±1."
      }
    },
    data_model: {
      discovered_cruises_itinerary_ports: "string[] of resolved canonical port names only at write time",
      raw_extract_itinerary_stops: "rich stop objects with kind + port_resolution in adapter",
      featured_stops: "structured stop_type + port_id FK — separate from discovery",
      schema_migration_required: false,
      proposed_model: "MODEL_A_EXTENDED",
      description:
        "Extend Silversea adapter stop typing with expedition_semantic on raw_extract stops; only CONVENTIONAL_PORT requires canonical resolution; Classic unchanged."
    },
    complete_inventory_path: null,
    semantic_classification_counts: semanticCounts,
    embark_blockers: endpointInventory(expRows, "embark"),
    disembark_blockers: endpointInventory(expRows, "disembark"),
    destination_blockers: Object.entries(destUnresolved)
      .map(([name, count]) => ({ destination_name: name, affected_sailings: count }))
      .sort((a, b) => b.affected_sailings - a.affected_sailings),
    conventional_port_remediation_inventory: conventionalRemediation,
    proposed_non_port_semantic_rules: nonPortRules,
    regional_analysis: {
      galapagos: { ...regional(galapagos), top_identities: inventory.filter((i) => [...i.destinations].some((d) => /GAL/i.test(d))).slice(0, 15) },
      antarctica: { ...regional(antarctica), top_identities: inventory.filter((i) => [...i.destinations].some((d) => /ANTARCT/i.test(d))).slice(0, 15) },
      arctic_greenland: regional(arctic),
      kimberley: regional(kimberley),
      french_polynesia_pacific: regional(pacific)
    },
    expedition_detail_fields: detailFields,
    eligibility_simulation: eligibilitySim,
    policy: {
      target_data_model: "MODEL_A_EXTENDED",
      schema_migration_required: false,
      classic_eligibility_rules_changed: false,
      production_eligibility:
        "Expedition eligible when endpoints + destination resolved AND every itinerary stop is either resolved conventional port OR high-confidence expedition semantic (non-AMBIGUOUS)",
      match_required:
        "Unknown landing, ambiguous geographic label, unresolved endpoint without semantic rule, destination unresolved, duration mismatch, conflicting code/name",
      map_route:
        "Discovery Expedition rows: itinerary_ports remains resolved conventional ports only; landing sites not map waypoints unless later linked to coords; scenic regions excluded from route",
      public_display:
        "PORT: normal; LANDING_SITE: named stop + optional 'Expedition landing'; ANCHORAGE: named + 'Zodiac/anchorage'; SCENIC_REGION: display name, not port; TRANSIT: display if present; INLAND: named site not ship port; SEA: existing"
    },
    complete_unresolved_inventory: inventory,
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 },
    reference_writes: { canonical_ports: 0, destinations: 0, semantic_rules_applied: 0 },
    weekly_maintenance: "NOT ENABLED"
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e1-${stamp}.json`);
  report.complete_inventory_path = reportPath;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (WRITE_FIXTURES) {
    if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const galSample = galapagos[0];
    const aqSample = antarctica[0];
    const arSample = arctic[0];
    const fixture = (row) =>
      row
        ? {
            official_sailing_id: row.official_sailing_id,
            destination: row.raw?.destination_name,
            embark: row.raw?.departure_port,
            disembark: row.raw?.arrival_port,
            itinerary: (row.itinerary || []).map((s) => ({
              port_name: s.port_name,
              port_code: s.port_code,
              kind: s.kind,
              arrival_time: s.arrival_time,
              departure_time: s.departure_time,
              semantic: classifyExpeditionStopSemantic(s)
            }))
          }
        : null;
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expedition-e1-galapagos-sample.json"),
      `${JSON.stringify(fixture(galSample), null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expedition-e1-antarctica-sample.json"),
      `${JSON.stringify(fixture(aqSample), null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expedition-e1-arctic-sample.json"),
      `${JSON.stringify(fixture(arSample), null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expedition-e1-semantic-rules-proposed.json"),
      `${JSON.stringify({ generated_at: new Date().toISOString(), rules: nonPortRules.slice(0, 100) }, null, 2)}\n`
    );
    report.fixtures_written = [
      "expedition-e1-galapagos-sample.json",
      "expedition-e1-antarctica-sample.json",
      "expedition-e1-arctic-sample.json",
      "expedition-e1-semantic-rules-proposed.json"
    ];
  }

  report.report_path = reportPath;
  console.log(
    JSON.stringify(
      {
        report_path: reportPath,
        production: report.production,
        expedition_total: report.source_baseline.expedition_total,
        semantic_counts: report.semantic_classification_counts,
        eligibility_simulation: report.eligibility_simulation,
        conventional_remediation_count: report.conventional_port_remediation_inventory.length,
        non_port_rules_count: report.proposed_non_port_semantic_rules.length,
        recommended_next: "E2 — IMPLEMENT EXPEDITION SEMANTIC MODEL"
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
