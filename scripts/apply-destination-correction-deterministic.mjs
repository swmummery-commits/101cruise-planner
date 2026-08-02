#!/usr/bin/env node
/**
 * Apply narrow deterministic destination corrections (Transpacific only).
 *
 *   node scripts/apply-destination-correction-deterministic.mjs --precheck
 *   node scripts/apply-destination-correction-deterministic.mjs --generate
 *   node scripts/apply-destination-correction-deterministic.mjs --apply
 *   node scripts/apply-destination-correction-deterministic.mjs --investigate
 *
 * Approved writes: b78df16b… and ba81d07e… → Transpacific destination_id only.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { resolveOperationalDestination, DESTINATION_RESOLVER_VERSION } = require(
  path.join(root, "netlify/functions/lib/discovery-destination-resolver")
);

const ALASKA_ID = "c8eb51fa-aeca-4d93-9bd9-bfe8ce66a83c";
const APPROVED_CORRECTION_IDS = [
  "b78df16b-d81e-42de-a012-22a615c28bb0",
  "ba81d07e-9a1b-44e0-9850-e5ea372b12b4"
];
const INVESTIGATE_IDS = [
  "60f71bc7-af1f-429a-a4fa-85b3f6e0701c",
  "857fc5e4-0c7a-41aa-8400-2df2a01611f0"
];
const ALASKA_CONFIRM_IDS = [
  "2b775aec-32ec-4a4a-97b3-03a16d2ed2f8",
  "1ded636b-e397-49b8-9084-6dd31de5e5f2",
  "d3197a12-3c5e-4921-aa11-fdc31c5f1311",
  "408898c0-9353-4029-9ce2-054638e1eb46"
];
const MANIFEST_PATH = path.join(root, "reports/destination-correction-deterministic-2026-08-02.json");

function parseArgs(argv) {
  const args = { precheck: false, generate: false, apply: false, investigate: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--generate") args.generate = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--investigate") args.investigate = true;
  }
  if (!args.precheck && !args.generate && !args.apply && !args.investigate) {
    args.precheck = true;
  }
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArrivalFromTitle(title) {
  const t = String(title || "");
  const m = t.match(/\bto\s+([^|]+?)(?:\s*\||\s+on\s|\s*$)/i);
  return m ? m[1].replace(/\([^)]*\)/g, "").trim() : null;
}

function parseDepartureFromTitle(title) {
  const t = String(title || "");
  const m = t.match(/(?:^|[\s-])([A-Za-z\s]+?)\s+to\s+/i);
  return m ? m[1].trim() : null;
}

function parseRouteEndpoints(title, description) {
  const t = String(title || "");
  const routeMatch = t.match(/([A-Za-z][A-Za-z\s]{2,30}?)\s+to\s+([A-Za-z][A-Za-z\s]{2,30}?)(?:\s*\||\s+on\s|\s*$)/i);
  if (routeMatch) {
    return {
      departure: routeMatch[1].replace(/\([^)]*\)/g, "").trim(),
      arrival: routeMatch[2].replace(/\([^)]*\)/g, "").trim()
    };
  }
  return { departure: null, arrival: null };
}

function assessIssues(row) {
  const raw = row.raw_extract || {};
  const title = raw.title || "";
  const route = parseRouteEndpoints(title, raw.description);
  const otherIssues = [];
  if (row.id === "60f71bc7-af1f-429a-a4fa-85b3f6e0701c") {
    if (!row.departure_port && !route.departure) otherIssues.push("missing_departure_port");
    if (/crystal symphony/i.test(title) && /crystal serenity/i.test(row.ci_cruise_ships?.name || "")) {
      otherIssues.push("voyage_identity_mismatch_crystal_symphony_vs_serenity");
    }
    if (/none-csy-/i.test(row.official_url || "")) otherIssues.push("ship_guess_noise_from_url_slug");
  }
  if (row.id === "857fc5e4-0c7a-41aa-8400-2df2a01611f0") {
    if (/seward/i.test(title) && row.departure_port && !/seward/i.test(row.departure_port)) {
      otherIssues.push("departure_port_conflicts_with_title_route");
    }
    if (/crystal symphony/i.test(title) && /crystal serenity/i.test(row.ci_cruise_ships?.name || "")) {
      otherIssues.push("voyage_identity_mismatch_crystal_symphony_vs_serenity");
    }
    if (/none-csy-/i.test(row.official_url || "")) otherIssues.push("ship_guess_noise_from_url_slug");
  }
  if (raw.ship_name_guesses?.some((g) => /none csy|none cse/.test(String(g)))) {
    if (!otherIssues.includes("ship_guess_noise_from_url_slug")) {
      otherIssues.push("ship_guess_noise_from_url_slug");
    }
  }
  return otherIssues;
}

function reassessRow(row, destinations) {
  const raw = row.raw_extract || {};
  const title = raw.title || "";
  const description = raw.description || "";
  const route = parseRouteEndpoints(title, description);
  const arrival = route.arrival || parseArrivalFromTitle(title);
  let departurePort = row.departure_port || route.departure || parseDepartureFromTitle(title);
  const result = resolveOperationalDestination({
    title,
    description,
    itinerary: row.itinerary,
    departurePort,
    arrivalPort: arrival,
    nights: row.nights,
    destinations
  });
  const currentName = row.destinations?.name || "Alaska";
  const otherIssues = assessIssues(row);
  const transpacificDest = destinations.find((d) => d.slug === "transpacific");
  const proposedId =
    result.destinationKey === "transpacific" ? transpacificDest?.id || null : result.destinationId;

  return {
    discovered_cruise_id: row.id,
    cruise_line: row.ci_cruise_lines?.name || null,
    ship: row.ci_cruise_ships?.name || null,
    source_url: row.official_url,
    voyage_title: title,
    departure_date: row.departure_date,
    departure_port: departurePort,
    arrival_port: arrival,
    duration_nights: row.nights,
    itinerary_evidence: row.itinerary,
    raw_destination_evidence: raw.destination || null,
    status: row.status,
    current_destination_id: row.destination_id,
    current_destination_name: currentName,
    proposed_destination_id: proposedId,
    proposed_destination_name: result.destinationName || result.destinationKey,
    proposed_destination_key: result.destinationKey,
    resolver_status: result.status,
    confidence: result.confidence,
    evidence_summary: result.evidence?.slice(0, 8) || [],
    resolver_version: result.resolverVersion || DESTINATION_RESOLVER_VERSION,
    updated_at: row.updated_at,
    other_issues: otherIssues,
    before: {
      destination_id: row.destination_id,
      updated_at: row.updated_at,
      status: row.status
    },
    rollback: {
      destination_id: row.destination_id,
      destination_name: currentName,
      updated_at: row.updated_at
    }
  };
}

function isDeterministicCorrection(entry) {
  return (
    APPROVED_CORRECTION_IDS.includes(entry.discovered_cruise_id) &&
    entry.current_destination_id === ALASKA_ID &&
    entry.proposed_destination_key === "transpacific" &&
    entry.resolver_status === "resolved" &&
    entry.confidence === "high" &&
    entry.proposed_destination_id &&
    !entry.other_issues.some((i) =>
      ["departure_port_conflicts_with_title_route", "voyage_identity_mismatch_crystal_symphony_vs_serenity"].includes(i)
    )
  );
}

async function headCount(sb, table) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const { url, key } = getSupabaseConfig(root);
    const u = new URL(`${url}/rest/v1/${table}?select=id`);
    const req = https.request(
      u,
      { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
      (res) => {
        const range = res.headers["content-range"] || "";
        const m = range.match(/\/(\d+)/);
        resolve(m ? Number(m[1]) : 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchCounts(sb) {
  const tables = [
    "discovered_cruises",
    "discovered_cruise_destinations",
    "cruise_discovery_review_items",
    "destinations",
    "destination_ports",
    "cruise_destination_aliases",
    "cruise_ship_aliases",
    "cruise_discovery_resolution_audit"
  ];
  const out = {};
  for (const table of tables) out[table] = await headCount(sb, table);
  return out;
}

async function loadRows(sb, ids) {
  const inList = ids.map((id) => encodeURIComponent(id)).join(",");
  return sb.get(
    `discovered_cruises?id=in.(${inList})&select=*,ci_cruise_lines(name),ci_cruise_ships(name),destinations!discovered_cruises_destination_id_fkey(id,name,slug)`
  );
}

async function verifyTranspacific(sb) {
  const rows = await sb.get(
    "destinations?slug=eq.transpacific&select=id,name,slug,status,classification_enabled&limit=1"
  );
  const tp = rows?.[0];
  if (!tp) throw new Error("Transpacific destination missing");
  if (tp.status === "hidden") throw new Error("Transpacific is hidden");
  if (tp.classification_enabled !== true) throw new Error("Transpacific classification disabled");
  if (tp.status === "published") throw new Error("Transpacific unexpectedly published");
  return tp;
}

async function runPrecheck(sb, destinations, transpacific) {
  const allIds = [...APPROVED_CORRECTION_IDS, ...INVESTIGATE_IDS, ...ALASKA_CONFIRM_IDS];
  const rows = await loadRows(sb, allIds);
  const assessed = rows.map((row) => reassessRow(row, destinations));
  const corrections = assessed.filter((e) => APPROVED_CORRECTION_IDS.includes(e.discovered_cruise_id));
  const deterministic = corrections.filter(isDeterministicCorrection);
  if (deterministic.length !== APPROVED_CORRECTION_IDS.length) {
    throw new Error(
      `Deterministic correction count ${deterministic.length} !== ${APPROVED_CORRECTION_IDS.length}: ${JSON.stringify(
        corrections.map((c) => ({
          id: c.discovered_cruise_id,
          ok: isDeterministicCorrection(c),
          key: c.proposed_destination_key,
          issues: c.other_issues
        }))
      )}`
    );
  }
  return {
    phase: "precheck",
    transpacific,
    table_counts: await fetchCounts(sb),
    corrections: deterministic,
    investigate: assessed.filter((e) => INVESTIGATE_IDS.includes(e.discovered_cruise_id)),
    alaska_confirm: assessed.filter((e) => ALASKA_CONFIRM_IDS.includes(e.discovered_cruise_id))
  };
}

async function runGenerate(sb, destinations, transpacific) {
  const pre = await runPrecheck(sb, destinations, transpacific);
  const manifest = {
    generated_at: new Date().toISOString(),
    mode: "destination_correction_deterministic",
    writes_performed: false,
    resolver_version: DESTINATION_RESOLVER_VERSION,
    alaska_id: ALASKA_ID,
    transpacific_id: transpacific.id,
    entries: pre.corrections.map((entry) => ({
      ...entry,
      proposed_destination_id: transpacific.id,
      proposed_destination_name: "Transpacific"
    }))
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return { manifest_path: MANIFEST_PATH, entry_count: manifest.entries.length, manifest };
}

async function runApply(sb) {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const countsBefore = await fetchCounts(sb);
  const results = { updated: [], skipped: [], failed: [] };

  for (const entry of manifest.entries) {
    const currentRows = await sb.get(
      `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}&select=id,destination_id,updated_at,status,departure_port,itinerary,official_url,ship_id,departure_date,return_date,nights,raw_extract&limit=1`
    );
    const current = currentRows?.[0];
    if (!current) {
      results.failed.push({ id: entry.discovered_cruise_id, error: "row_missing" });
      continue;
    }
    if (current.updated_at !== entry.updated_at) {
      results.skipped.push({
        id: entry.discovered_cruise_id,
        reason: "updated_at_changed",
        expected: entry.updated_at,
        actual: current.updated_at
      });
      continue;
    }
    if (current.destination_id !== entry.current_destination_id) {
      results.skipped.push({
        id: entry.discovered_cruise_id,
        reason: "destination_id_changed",
        expected: entry.current_destination_id,
        actual: current.destination_id
      });
      continue;
    }
    if (current.destination_id === entry.proposed_destination_id) {
      results.skipped.push({ id: entry.discovered_cruise_id, reason: "already_correct" });
      continue;
    }
    if (current.destination_id !== entry.current_destination_id && current.destination_id === entry.proposed_destination_id) {
      results.skipped.push({ id: entry.discovered_cruise_id, reason: "already_applied" });
      continue;
    }

    const patchPath =
      `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}` +
      `&updated_at=eq.${encodeURIComponent(entry.updated_at)}`;
    try {
      const patched = await sb.patch(patchPath, { destination_id: entry.proposed_destination_id });
      const row = Array.isArray(patched) ? patched[0] : patched;
      if (!row || row.destination_id !== entry.proposed_destination_id) {
        results.failed.push({ id: entry.discovered_cruise_id, error: "patch_no_match_or_failed" });
        continue;
      }
      results.updated.push({
        id: entry.discovered_cruise_id,
        from: entry.current_destination_id,
        to: entry.proposed_destination_id
      });
    } catch (err) {
      results.failed.push({ id: entry.discovered_cruise_id, error: err.message });
    }
  }

  if (results.failed.length) throw new Error(`Apply failures: ${JSON.stringify(results.failed)}`);

  const rollbackPath = path.join(root, `reports/destination-correction-rollback-${timestampSlug()}.json`);
  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        apply_manifest: path.basename(MANIFEST_PATH),
        apply_timestamp: new Date().toISOString(),
        actions: manifest.entries.map((entry) => ({
          discovered_cruise_id: entry.discovered_cruise_id,
          previous_destination_id: entry.current_destination_id,
          new_destination_id: entry.proposed_destination_id,
          previous_updated_at: entry.updated_at,
          rollback_destination_id: entry.current_destination_id
        }))
      },
      null,
      2
    )
  );

  const verified = [];
  for (const entry of manifest.entries) {
    const row = (
      await sb.get(
        `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}&select=id,destination_id,status,departure_port,itinerary,official_url,ship_id,departure_date,return_date,nights,updated_at,destinations!discovered_cruises_destination_id_fkey(name)&limit=1`
      )
    )?.[0];
    verified.push({
      id: row.id,
      destination: row.destinations?.name,
      destination_id: row.destination_id,
      status: row.status,
      departure_port: row.departure_port,
      official_url: row.official_url,
      ship_id: row.ship_id,
      departure_date: row.departure_date,
      nights: row.nights
    });
  }

  return {
    phase: "apply",
    results,
    rollback_path: rollbackPath,
    verified,
    table_counts_before: countsBefore,
    table_counts_after: await fetchCounts(sb)
  };
}

async function findDuplicates(sb, row) {
  const keys = [];
  if (row.official_url) keys.push(`official_url=eq.${encodeURIComponent(row.official_url)}`);
  if (row.external_key) keys.push(`external_key=eq.${encodeURIComponent(row.external_key)}`);
  const out = [];
  for (const filter of keys) {
    const hits = await sb.get(`discovered_cruises?${filter}&select=id,ship_id,departure_date,official_url,external_key,status,destination_id`);
    out.push(...(hits || []));
  }
  const byId = Object.fromEntries(out.map((h) => [h.id, h]));
  return Object.values(byId).filter((h) => h.id !== row.id);
}

async function runInvestigate(sb, destinations) {
  const rows = await loadRows(sb, INVESTIGATE_IDS);
  const findings = [];
  for (const row of rows) {
    const assessed = reassessRow(row, destinations);
    const duplicates = await findDuplicates(sb, row);
    const raw = row.raw_extract || {};
    findings.push({
      discovered_cruise_id: row.id,
      cruise_line: assessed.cruise_line,
      ship: assessed.ship,
      official_url: row.official_url,
      external_key: row.external_key,
      voyage_title: raw.title,
      description_excerpt: String(raw.description || "").slice(0, 400),
      departure_date: row.departure_date,
      stored_departure_port: row.departure_port,
      title_route: parseRouteEndpoints(raw.title, raw.description),
      resolver: {
        proposed_key: assessed.proposed_destination_key,
        confidence: assessed.confidence,
        status: assessed.resolver_status
      },
      other_issues: assessed.other_issues,
      ship_name_guesses: raw.ship_name_guesses || [],
      duplicates,
      recommended_outcome: recommendOutcome(row, assessed, duplicates)
    });
  }
  return { phase: "investigate", findings };
}

function recommendOutcome(row, assessed, duplicates) {
  if (row.id === "60f71bc7-af1f-429a-a4fa-85b3f6e0701c") {
    if (assessed.other_issues.includes("voyage_identity_mismatch_crystal_symphony_vs_serenity")) {
      return {
        code: "D",
        label: "Source URL and record identity are mismatched",
        next_action: "Re-fetch official Crystal page for cse/csy slug; reconcile ship + voyage id before any destination write"
      };
    }
    if (assessed.proposed_destination_key === "pacific-coast" && assessed.confidence === "high") {
      return {
        code: "A",
        label: "Valid sailing may require Pacific Coast once voyage identity is confirmed",
        next_action: "Hold until source-data correction confirms San Diego→Vancouver on correct ship"
      };
    }
    return { code: "F", label: "Insufficient official evidence", next_action: "Manual source review" };
  }
  if (row.id === "857fc5e4-0c7a-41aa-8400-2df2a01611f0") {
    if (assessed.other_issues.includes("departure_port_conflicts_with_title_route")) {
      return {
        code: "A",
        label: "Correct departure port (likely Seward) then classify Transpacific",
        next_action: "Source-data correction HOLD: fix embarkation port from official Crystal page before destination write"
      };
    }
    if (assessed.other_issues.includes("voyage_identity_mismatch_crystal_symphony_vs_serenity")) {
      return {
        code: "C",
        label: "Source URL appears mismatched to stored ship",
        next_action: "Verify official voyage csy-014 vs cse product code"
      };
    }
    if (duplicates.length) {
      return { code: "D", label: "Possible duplicate", next_action: "Compare duplicate rows before correction" };
    }
    return {
      code: "B",
      label: "Transpacific likely once port identity agrees",
      next_action: "Investigate official structured departure before write"
    };
  }
  return { code: "F", label: "Insufficient evidence", next_action: "Manual review" };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const destinations = await sb.get("destinations?select=id,name,slug,status,primary_region,classification_enabled");
  const transpacific = await verifyTranspacific(sb);

  if (args.precheck) {
    console.log(JSON.stringify(await runPrecheck(sb, destinations, transpacific), null, 2));
  }
  if (args.generate) {
    console.log(JSON.stringify(await runGenerate(sb, destinations, transpacific), null, 2));
  }
  if (args.apply) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      await runGenerate(sb, destinations, transpacific);
    }
    console.log(JSON.stringify(await runApply(sb), null, 2));
  }
  if (args.investigate) {
    console.log(JSON.stringify(await runInvestigate(sb, destinations), null, 2));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
