#!/usr/bin/env node
/**
 * Apply official-evidence Crystal record corrections (narrow manifest).
 *
 *   node scripts/apply-crystal-record-correction.mjs --precheck
 *   node scripts/apply-crystal-record-correction.mjs --generate
 *   node scripts/apply-crystal-record-correction.mjs --apply
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

const RECORD_IDS = [
  "60f71bc7-af1f-429a-a4fa-85b3f6e0701c",
  "857fc5e4-0c7a-41aa-8400-2df2a01611f0"
];

const SYMPHONY_ID = "33de83d1-f680-4a07-973e-57503a4ad5bf";
const SERENITY_ID = "156d2dbb-0e24-4515-85c5-6cb64c8b142e";
const ALASKA_ID = "c8eb51fa-aeca-4d93-9bd9-bfe8ce66a83c";
const PACIFIC_COAST_ID = "a4e7162a-4d6f-43ac-bb16-672feef8fa3d";
const TRANSPACIFIC_ID = "f89a6b30-f5c3-4a70-bfc6-478955672cc2";

const MANIFEST_PATH = path.join(root, "reports/crystal-record-correction-2026-08-02.json");

const OFFICIAL_EVIDENCE = {
  "60f71bc7-af1f-429a-a4fa-85b3f6e0701c": {
    outcome: "A",
    outcome_label: "correct_in_place",
    official_url: "https://www.crystalcruises.com/cruises/none-csy-008-280625",
    official_voyage_id: "none-csy-008-280625",
    url_ship_code: "csy",
    ship_name: "Crystal Symphony",
    ship_id: SYMPHONY_ID,
    title: "Crystal Symphony - San Diego to Vancouver | North America & Canada | Crystal Cruises",
    departure_date: "2028-06-25",
    return_date: "2028-07-03",
    nights: 8,
    departure_port: "San Diego",
    arrival_port: "Vancouver",
    destination_id: PACIFIC_COAST_ID,
    destination_slug: "pacific-coast",
    itinerary:
      "San Diego, Santa Catalina Island, San Francisco, Astoria, Victoria, Nanaimo, Vancouver",
    hide_reason: null,
    evidence_notes:
      "Official page primary voyage: Symphony csy-008, Jun 25–Jul 3 2028, 8 nights. Stored May 2027/Serenity data came from unrelated preview card in scrape."
  },
  "857fc5e4-0c7a-41aa-8400-2df2a01611f0": {
    outcome: "A",
    outcome_label: "correct_in_place",
    official_url: "https://www.crystalcruises.com/cruises/none-csy-014-280918",
    official_voyage_id: "none-csy-014-280918",
    url_ship_code: "csy",
    ship_name: "Crystal Symphony",
    ship_id: SYMPHONY_ID,
    title: "Crystal Symphony - Seward (Anchorage, Alaska) to Tokyo | Transoceanic | Crystal Cruises",
    departure_date: "2028-09-18",
    return_date: "2028-10-03",
    nights: 14,
    departure_port: "Seward",
    arrival_port: "Tokyo",
    destination_id: TRANSPACIFIC_ID,
    destination_slug: "transpacific",
    itinerary: "Seward, Homer, Kodiak Island, Kushiro, Hakodate, Aomori, Sendai, Hitachinaka, Tokyo",
    hide_reason: null,
    evidence_notes:
      "Official page confirms Symphony csy-014, Seward embark Sep 18 2028, Tokyo disembark Oct 3 2028. Narrative mention of Serenity must not override URL/title/structured ship."
  }
};

function parseArgs(argv) {
  const args = { precheck: false, generate: false, apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--generate") args.generate = true;
    if (arg === "--apply") args.apply = true;
  }
  if (!args.precheck && !args.generate && !args.apply) args.precheck = true;
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function headCount(_sb, table) {
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
    "cruise_discovery_review_items",
    "cruise_ship_aliases",
    "destinations",
    "destination_ports",
    "cruise_discovery_resolution_audit"
  ];
  const out = {};
  for (const table of tables) out[table] = await headCount(sb, table);
  return out;
}

async function loadRows(sb) {
  const inList = RECORD_IDS.map(encodeURIComponent).join(",");
  return sb.get(
    `discovered_cruises?id=in.(${inList})&select=*,ci_cruise_ships(name),destinations!discovered_cruises_destination_id_fkey(name,slug)`
  );
}

async function findDuplicates(sb, row) {
  const hits = await sb.get(
    `discovered_cruises?official_url=eq.${encodeURIComponent(row.official_url)}&select=id,departure_date,status,ship_id,official_url`
  );
  return (hits || []).filter((h) => h.id !== row.id);
}

function buildProposedPatch(row, evidence, destinations) {
  if (evidence.outcome === "C") {
    return {
      status: "hidden",
      review_reason: evidence.hide_reason || "source_identity_mismatch",
      hidden_at: new Date().toISOString()
    };
  }

  const destResolve = resolveOperationalDestination({
    title: evidence.title,
    description: evidence.evidence_notes,
    departurePort: evidence.departure_port,
    arrivalPort: evidence.arrival_port,
    itinerary: evidence.itinerary,
    nights: evidence.nights,
    destinations
  });

  if (destResolve.destinationKey !== evidence.destination_slug) {
    throw new Error(
      `Resolver mismatch for ${row.id}: expected ${evidence.destination_slug}, got ${destResolve.destinationKey}`
    );
  }

  const raw = { ...(row.raw_extract || {}) };
  raw.title = evidence.title;
  raw.crystal_correction = {
    applied_at: new Date().toISOString(),
    official_voyage_id: evidence.official_voyage_id,
    official_url: evidence.official_url,
    outcome: evidence.outcome_label,
    resolver_version: DESTINATION_RESOLVER_VERSION
  };
  raw.ship_name_guesses = [evidence.ship_name];
  raw.ship_match_via = "crystal_official_evidence";
  delete raw.departure_port_meta;

  return {
    ship_id: evidence.ship_id,
    destination_id: evidence.destination_id,
    departure_date: evidence.departure_date,
    return_date: evidence.return_date,
    nights: evidence.nights,
    departure_port: evidence.departure_port,
    itinerary: evidence.itinerary,
    raw_extract: raw,
    status: "active",
    review_reason: null
  };
}

function buildEntry(row, evidence, destinations, duplicates) {
  const proposed = buildProposedPatch(row, evidence, destinations);
  const rollback = {
    ship_id: row.ship_id,
    destination_id: row.destination_id,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    itinerary: row.itinerary,
    status: row.status,
    review_reason: row.review_reason || null,
    raw_extract: row.raw_extract
  };

  return {
    discovered_cruise_id: row.id,
    outcome: evidence.outcome,
    outcome_label: evidence.outcome_label,
    official_evidence: evidence,
    duplicate_check: { count: duplicates.length, duplicates },
    before: {
      ship_id: row.ship_id,
      ship_name: row.ci_cruise_ships?.name,
      destination_id: row.destination_id,
      destination_name: row.destinations?.name,
      departure_date: row.departure_date,
      return_date: row.return_date,
      nights: row.nights,
      departure_port: row.departure_port,
      itinerary: row.itinerary,
      status: row.status,
      official_url: row.official_url
    },
    proposed,
    proposed_field_changes: Object.keys(proposed),
    updated_at: row.updated_at,
    rollback
  };
}

async function runPrecheck(sb, destinations) {
  const rows = await loadRows(sb);
  if (rows.length !== RECORD_IDS.length) {
    throw new Error(`Expected ${RECORD_IDS.length} rows, found ${rows.length}`);
  }
  const entries = [];
  for (const row of rows) {
    const evidence = OFFICIAL_EVIDENCE[row.id];
    if (!evidence) throw new Error(`Missing evidence for ${row.id}`);
    const duplicates = await findDuplicates(sb, row);
    if (duplicates.some((d) => d.status === "active")) {
      throw new Error(`Active duplicate for ${row.id}: ${JSON.stringify(duplicates)}`);
    }
    entries.push(buildEntry(row, evidence, destinations, duplicates));
  }
  return {
    phase: "precheck",
    resolver_version: DESTINATION_RESOLVER_VERSION,
    table_counts: await fetchCounts(sb),
    entries
  };
}

async function runGenerate(sb, destinations) {
  const pre = await runPrecheck(sb, destinations);
  const manifest = {
    generated_at: new Date().toISOString(),
    mode: "crystal_record_correction",
    writes_performed: false,
    resolver_version: DESTINATION_RESOLVER_VERSION,
    entries: pre.entries
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return { manifest_path: MANIFEST_PATH, entry_count: manifest.entries.length, manifest };
}

async function runApply(sb) {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const countsBefore = await fetchCounts(sb);
  const results = { updated: [], hidden: [], skipped: [], failed: [] };

  for (const entry of manifest.entries) {
    const currentRows = await sb.get(
      `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}&select=id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,updated_at,official_url,raw_extract,review_reason&limit=1`
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
    const verifyFields = [
      "ship_id",
      "destination_id",
      "departure_date",
      "return_date",
      "nights",
      "departure_port",
      "status",
      "official_url"
    ];
    let beforeOk = true;
    for (const field of verifyFields) {
      if (current[field] !== entry.before[field]) {
        results.skipped.push({
          id: entry.discovered_cruise_id,
          reason: "before_value_mismatch",
          field,
          expected: entry.before[field],
          actual: current[field]
        });
        beforeOk = false;
        break;
      }
    }
    if (!beforeOk) continue;

    const patchPath =
      `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}` +
      `&updated_at=eq.${encodeURIComponent(entry.updated_at)}`;
    try {
      const patched = await sb.patch(patchPath, entry.proposed);
      const row = Array.isArray(patched) ? patched[0] : patched;
      if (!row) {
        results.failed.push({ id: entry.discovered_cruise_id, error: "patch_no_match" });
        continue;
      }
      if (entry.proposed.status === "hidden") {
        results.hidden.push({ id: entry.discovered_cruise_id });
      } else {
        results.updated.push({ id: entry.discovered_cruise_id, fields: entry.proposed_field_changes });
      }
    } catch (err) {
      results.failed.push({ id: entry.discovered_cruise_id, error: err.message });
    }
  }

  if (results.failed.length) throw new Error(`Apply failures: ${JSON.stringify(results.failed)}`);

  const rollbackPath = path.join(root, `reports/crystal-record-correction-rollback-${timestampSlug()}.json`);
  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        apply_manifest: path.basename(MANIFEST_PATH),
        actions: manifest.entries.map((entry) => ({
          discovered_cruise_id: entry.discovered_cruise_id,
          updated_at_before_apply: entry.updated_at,
          rollback: entry.rollback
        }))
      },
      null,
      2
    )
  );

  return {
    phase: "apply",
    results,
    rollback_path: rollbackPath,
    table_counts_before: countsBefore,
    table_counts_after: await fetchCounts(sb)
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const destinations = await sb.get(
    "destinations?select=id,name,slug,status,classification_enabled&classification_enabled=eq.true"
  );

  let out;
  if (args.generate) out = await runGenerate(sb, destinations);
  else if (args.apply) out = await runApply(sb);
  else out = await runPrecheck(sb, destinations);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
