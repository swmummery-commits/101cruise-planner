#!/usr/bin/env node
/**
 * P3J: freeze the 30 Disney inserts created during the stale Thursday run.
 * ZERO writes.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);

const RUN_STARTED = "2026-09-16T19:00:37.442Z";
const INSERT_FROM = "2026-09-16T19:12:32.000Z";
const INSERT_TO = "2026-09-16T19:13:09.999Z";

function canonicalRow(row) {
  return {
    uuid: row.id,
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    identity_key: row.identity_key,
    ship_id: row.ship_id,
    destination_id: row.destination_id,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    itinerary: row.itinerary,
    source_url: row.source_url,
    official_url: row.official_url,
    created_at: row.created_at,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    raw_extract: row.raw_extract,
    status: row.status
  };
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.disney-cruise-line&select=id,slug&limit=1"))[0];
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${line.id}&created_at=gte.${INSERT_FROM}&created_at=lte.${INSERT_TO}&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,source_url,official_url,created_at,first_seen_at,last_seen_at,last_changed_at,updated_at,raw_extract,status,cruise_line_id&order=created_at.asc`
  );
  const frozen = (rows || []).map(canonicalRow);
  const freezeHash = crypto.createHash("sha256").update(stableStringify(frozen)).digest("hex");
  const official = frozen.map((r) => r.official_sailing_id);
  const report = {
    generated_at: new Date().toISOString(),
    incident_run_record_id: "72c1e384-9369-4d70-b690-81db79b9055d",
    incident_run_id: "disney-cruise-line-weekly-2026-09-16T19-00-34-516Z",
    run_started_at: RUN_STARTED,
    insert_window: { from: INSERT_FROM, to: INSERT_TO },
    row_count: frozen.length,
    freeze_hash_sha256: freezeHash,
    distinct_official_sailing_id: new Set(official).size,
    distinct_external_key: new Set(frozen.map((r) => r.external_key)).size,
    distinct_identity_key: new Set(frozen.map((r) => r.identity_key)).size,
    missing_ship: frozen.filter((r) => !r.ship_id).length,
    missing_destination: frozen.filter((r) => !r.destination_id).length,
    missing_departure_port: frozen.filter((r) => !r.departure_port).length,
    all_active: frozen.every((r) => r.status === "active"),
    official_sailing_ids: official,
    rows: frozen
  };
  const file = path.join(root, "reports", "disney-p3j-partial-write-30-freeze-2026-09-17.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        row_count: report.row_count,
        freeze_hash_sha256: freezeHash,
        all_active: report.all_active,
        distinct_official: report.distinct_official_sailing_id,
        missing_ship: report.missing_ship,
        missing_destination: report.missing_destination,
        missing_departure_port: report.missing_departure_port,
        first_created: frozen[0]?.created_at,
        last_created: frozen[frozen.length - 1]?.created_at
      },
      null,
      2
    )
  );
  if (frozen.length !== 30) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
