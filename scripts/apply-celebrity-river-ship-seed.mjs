#!/usr/bin/env node
/**
 * Apply approved Celebrity river ship catalogue seed + European River Cruises destination.
 *
 *   node scripts/apply-celebrity-river-ship-seed.mjs --precheck
 *   node scripts/apply-celebrity-river-ship-seed.mjs --apply
 *   node scripts/apply-celebrity-river-ship-seed.mjs --verify
 *   node scripts/apply-celebrity-river-ship-seed.mjs --all
 *
 * No Celebrity cruise inventory writes. No alias writes.
 */

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MANIFEST_PATH = path.join(root, "reports/celebrity-river-ship-seed-manifest-2026-08-03.json");
const CELEBRITY_LINE_ID = "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec";
const EXPECTED_SHIP_INSERTS = 5;

function parseArgs(argv) {
  const args = { precheck: false, apply: false, verify: false, all: false, rollback: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--all") args.all = true;
    if (arg === "--rollback") args.rollback = true;
  }
  if (args.all) {
    args.precheck = true;
    args.apply = true;
    args.verify = true;
  }
  if (!args.precheck && !args.apply && !args.verify && !args.rollback) args.precheck = true;
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normaliseShipName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.cruise_line_id !== CELEBRITY_LINE_ID) {
    throw new Error(`Celebrity line id mismatch: ${manifest.cruise_line_id}`);
  }
  if ((manifest.ships || []).length !== EXPECTED_SHIP_INSERTS) {
    throw new Error(`Expected ${EXPECTED_SHIP_INSERTS} ships in manifest`);
  }
  return manifest;
}

async function headCount(sb, table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
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

async function fetchDbCounts(sb) {
  const lineFilter = `cruise_line_id=eq.${encodeURIComponent(CELEBRITY_LINE_ID)}`;
  return {
    cruise_lines: await headCount(sb, "ci_cruise_lines"),
    canonical_cruise_ships: await headCount(sb, "ci_cruise_ships"),
    celebrity_ships: await headCount(sb, "ci_cruise_ships", lineFilter),
    operational_destinations: await headCount(sb, "destinations"),
    discovered_cruises: await headCount(sb, "discovered_cruises"),
    active_cruises: await headCount(sb, "discovered_cruises", "status=eq.active"),
    pending_review_items: await headCount(sb, "cruise_discovery_review_items", "status=eq.pending"),
    total_review_items: await headCount(sb, "cruise_discovery_review_items"),
    ship_aliases: await headCount(sb, "cruise_ship_aliases"),
    destination_aliases: await headCount(sb, "cruise_destination_aliases"),
    destination_ports: await headCount(sb, "destination_ports"),
    discovery_runs: await headCount(sb, "cruise_discovery_runs")
  };
}

async function fetchCelebrityShips(sb) {
  return sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(CELEBRITY_LINE_ID)}&select=*&order=name.asc`
  );
}

async function fetchShipAliases(sb, shipIds) {
  if (!shipIds.length) return [];
  const inList = shipIds.map((id) => encodeURIComponent(id)).join(",");
  return sb.get(`cruise_ship_aliases?ship_id=in.(${inList})&select=*`).catch(() => []);
}

function matchExistingShip(entry, celebrityShips, allShipsByName) {
  const code = String(entry.official_line_ship_id || "").toUpperCase();
  const normName = normaliseShipName(entry.name);

  for (const ship of celebrityShips) {
    if (String(ship.official_line_ship_id || "").toUpperCase() === code) {
      return { ship, method: "cruise_line_id_plus_official_code" };
    }
    if (normaliseShipName(ship.name) === normName) {
      return { ship, method: "cruise_line_id_plus_normalised_name" };
    }
  }

  const crossLine = allShipsByName.get(normName);
  if (crossLine && crossLine.cruise_line_id !== CELEBRITY_LINE_ID) {
    return { conflict: true, ship: crossLine, method: "cross_line_name_conflict" };
  }
  return null;
}

function buildShipRow(entry) {
  return {
    cruise_line_id: CELEBRITY_LINE_ID,
    name: entry.name,
    slug: entry.slug,
    status: entry.status,
    active: entry.active === true,
    official_line_ship_id: entry.official_line_ship_id,
    ship_class: entry.ship_class || null,
    official_ship_url: entry.official_ship_url || null,
    source_name: entry.source_name || null,
    source_url: entry.source_url || null,
    review_notes: entry.vessel_type ? `vessel_type=${entry.vessel_type}` : null
  };
}

function shipNeedsUpdate(existing, entry) {
  const desired = buildShipRow(entry);
  const fields = [
    "official_line_ship_id",
    "status",
    "active",
    "ship_class",
    "official_ship_url",
    "source_name",
    "source_url",
    "review_notes"
  ];
  const missing = [];
  for (const field of fields) {
    const current = existing[field];
    const next = desired[field];
    if (next != null && (current == null || current === "")) missing.push(field);
  }
  return missing;
}

async function runPrecheck(sb, manifest) {
  const celebrityShips = await fetchCelebrityShips(sb);
  const allShips = await sb.get("ci_cruise_ships?select=id,name,cruise_line_id,official_line_ship_id,slug,active,status");
  const allShipsByName = new Map(allShips.map((s) => [normaliseShipName(s.name), s]));
  const line = (await sb.get(`ci_cruise_lines?id=eq.${CELEBRITY_LINE_ID}&select=id,name,slug&limit=1`))?.[0];
  const dest = (
    await sb.get("destinations?slug=eq.european-river-cruises&select=id,name,slug,status,classification_enabled&limit=1")
  )?.[0];

  const shipPlans = [];
  for (const entry of manifest.ships) {
    const match = matchExistingShip(entry, celebrityShips, allShipsByName);
    if (match?.conflict) {
      shipPlans.push({ ...entry, proposed_action: "conflict_stop", conflict: match });
      continue;
    }
    if (match?.ship) {
      const missing = shipNeedsUpdate(match.ship, entry);
      shipPlans.push({
        ...entry,
        proposed_action: missing.length ? "update_existing_missing_fields" : "unchanged",
        existing_id: match.ship.id,
        match_method: match.method,
        missing_fields: missing
      });
    } else {
      shipPlans.push({ ...entry, proposed_action: "insert" });
    }
  }

  if (shipPlans.some((p) => p.proposed_action === "conflict_stop")) {
    throw new Error(`Cross-line ship name conflicts: ${JSON.stringify(shipPlans.filter((p) => p.conflict))}`);
  }

  const report = {
    phase: "precheck",
    cruise_line: line,
    celebrity_ship_count: celebrityShips.length,
    european_river_cruises_exists: Boolean(dest),
    ship_plans: shipPlans,
    destination_plan: dest
      ? { proposed_action: "unchanged", id: dest.id, status: dest.status }
      : { proposed_action: "insert", ...manifest.destination },
    table_counts: await fetchDbCounts(sb)
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function createBackup(sb, manifestChecksum, manifest) {
  const celebrityShips = await fetchCelebrityShips(sb);
  const line = (await sb.get(`ci_cruise_lines?id=eq.${CELEBRITY_LINE_ID}&select=*&limit=1`))?.[0];
  const dest = (
    await sb.get("destinations?slug=eq.european-river-cruises&select=*&limit=1")
  )?.[0];
  const codeMatches = [];
  for (const code of ["RC", "RS", "RB", "RR", "RW"]) {
    const hit = celebrityShips.find((s) => String(s.official_line_ship_id || "").toUpperCase() === code);
    if (hit) codeMatches.push(hit);
  }
  const nameMatches = celebrityShips.filter((s) =>
    manifest.ships.some((e) => normaliseShipName(e.name) === normaliseShipName(s.name))
  );

  const backup = {
    created_at: new Date().toISOString(),
    seed_manifest_path: path.basename(MANIFEST_PATH),
    seed_manifest_sha256: manifestChecksum,
    celebrity_cruise_line: line,
    celebrity_ships: celebrityShips,
    possible_code_matches: codeMatches,
    possible_name_matches: nameMatches,
    european_river_cruises: dest || null,
    table_counts: await fetchDbCounts(sb)
  };

  const outPath = path.join(root, `reports/celebrity-river-ship-backup-${timestampSlug()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));
  return { backup_path: outPath, backup };
}

async function applySeed(sb, manifest) {
  const celebrityShips = await fetchCelebrityShips(sb);
  const allShips = await sb.get("ci_cruise_ships?select=id,name,cruise_line_id,official_line_ship_id,slug,active,status,ship_class,official_ship_url,source_name,source_url,review_notes");
  const allShipsByName = new Map(allShips.map((s) => [normaliseShipName(s.name), s]));
  const shipIds = celebrityShips.map((s) => s.id);
  const aliasesBefore = await fetchShipAliases(sb, shipIds);

  const result = {
    phase: "seed_apply",
    inserted_ships: [],
    updated_ships: [],
    unchanged_ships: [],
    destination_inserted: null,
    destination_unchanged: null,
    failures: []
  };

  for (const entry of manifest.ships) {
    const match = matchExistingShip(entry, celebrityShips, allShipsByName);
    if (match?.conflict) {
      throw new Error(`Cross-line conflict for ${entry.name}`);
    }

    if (match?.ship) {
      const missing = shipNeedsUpdate(match.ship, entry);
      if (!missing.length) {
        result.unchanged_ships.push({ id: match.ship.id, name: match.ship.name, slug: match.ship.slug });
        continue;
      }
      const before = {};
      const patch = {};
      for (const field of missing) {
        before[field] = match.ship[field];
        patch[field] = buildShipRow(entry)[field];
      }
      try {
        const updated = await sb.patch(`ci_cruise_ships?id=eq.${encodeURIComponent(match.ship.id)}`, patch);
        const row = Array.isArray(updated) ? updated[0] : updated;
        result.updated_ships.push({ id: match.ship.id, name: entry.name, before, after: patch, row });
        Object.assign(match.ship, patch);
      } catch (err) {
        result.failures.push({ name: entry.name, error: err.message });
      }
      continue;
    }

    try {
      const inserted = await sb.post("ci_cruise_ships", buildShipRow(entry), { prefer: "return=representation" });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      result.inserted_ships.push({ id: row?.id, name: entry.name, slug: entry.slug, official_line_ship_id: entry.official_line_ship_id });
      if (row) celebrityShips.push(row);
    } catch (err) {
      result.failures.push({ name: entry.name, error: err.message });
    }
  }

  const destExisting = (
    await sb.get("destinations?slug=eq.european-river-cruises&select=id,name,slug,status,classification_enabled&limit=1")
  )?.[0];
  if (destExisting) {
    result.destination_unchanged = destExisting;
  } else {
    const destRow = {
      name: manifest.destination.canonical_name,
      slug: manifest.destination.slug,
      status: manifest.destination.status,
      classification_enabled: manifest.destination.classification_enabled === true,
      primary_region: manifest.destination.primary_region || null,
      display_order: manifest.destination.display_order ?? 110
    };
    try {
      const inserted = await sb.post("destinations", destRow, { prefer: "return=representation" });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      result.destination_inserted = row;
    } catch (err) {
      result.failures.push({ destination: manifest.destination.slug, error: err.message });
    }
  }

  const aliasesAfter = await fetchShipAliases(sb, (await fetchCelebrityShips(sb)).map((s) => s.id));
  result.alias_count_before = aliasesBefore.length;
  result.alias_count_after = aliasesAfter.length;
  result.alias_writes_performed = aliasesAfter.length !== aliasesBefore.length;

  if (result.failures.length) throw new Error(`Seed failures: ${JSON.stringify(result.failures)}`);
  if (result.alias_writes_performed) throw new Error("Unexpected ship alias writes during seed apply");

  return result;
}

function createRollbackManifest(backup, seedResult, manifestChecksum) {
  const rollback = {
    created_at: new Date().toISOString(),
    apply_timestamp: new Date().toISOString(),
    source_manifest_checksum: manifestChecksum,
    backup_reference: path.basename(backup.backup_path),
    actions: [],
    note: "Execute only if post-seed verification fails and rollback is explicitly approved."
  };

  for (const row of seedResult.inserted_ships) {
    rollback.actions.push({
      action: "delete_ship",
      id: row.id,
      name: row.name,
      reason: "seed_inserted_row"
    });
  }
  for (const row of seedResult.updated_ships) {
    rollback.actions.push({
      action: "restore_ship_fields",
      id: row.id,
      before: row.before,
      reason: "seed_updated_row"
    });
  }
  if (seedResult.destination_inserted?.id) {
    rollback.actions.push({
      action: "delete_destination",
      id: seedResult.destination_inserted.id,
      slug: seedResult.destination_inserted.slug,
      reason: "seed_inserted_row"
    });
  }

  const rollbackPath = path.join(root, `reports/celebrity-river-ship-seed-rollback-${timestampSlug()}.json`);
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));
  return rollbackPath;
}

async function runVerify(sb, manifest) {
  const celebrityShips = await fetchCelebrityShips(sb);
  const riverCodes = new Set(manifest.ships.map((s) => String(s.official_line_ship_id).toUpperCase()));
  const riverShips = celebrityShips.filter((s) => riverCodes.has(String(s.official_line_ship_id || "").toUpperCase()));

  const dest = (
    await sb.get("destinations?slug=eq.european-river-cruises&select=id,name,slug,status,classification_enabled&limit=1")
  )?.[0];

  const report = {
    phase: "post_seed_verify",
    celebrity_ship_count: celebrityShips.length,
    river_ship_count: riverShips.length,
    river_ships: riverShips.map((s) => ({
      id: s.id,
      name: s.name,
      official_line_ship_id: s.official_line_ship_id,
      active: s.active,
      status: s.status,
      ship_class: s.ship_class
    })),
    all_river_active: riverShips.every((s) => s.active === true),
    all_river_codes_present: riverShips.length === EXPECTED_SHIP_INSERTS,
    european_river_cruises: dest,
    destination_is_draft: dest?.status === "draft",
    destination_classification_enabled: dest?.classification_enabled === true,
    table_counts: await fetchDbCounts(sb)
  };

  if (riverShips.length !== EXPECTED_SHIP_INSERTS) {
    throw new Error(`Expected ${EXPECTED_SHIP_INSERTS} river ships, found ${riverShips.length}`);
  }
  if (!report.all_river_active) throw new Error("Not all river ships are active");
  if (!dest) throw new Error("European River Cruises destination missing");
  if (dest.status !== "draft") throw new Error("European River Cruises must remain draft");
  if (dest.classification_enabled !== true) throw new Error("classification_enabled must be true");

  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const manifest = loadManifest();
  const manifestChecksum = sha256File(MANIFEST_PATH);
  console.log("Manifest checksum:", manifestChecksum);

  let countsBefore = null;
  if (args.precheck || args.apply) countsBefore = await fetchDbCounts(sb);

  if (args.precheck) {
    await runPrecheck(sb, manifest);
    if (countsBefore) console.log("Table counts (before):", JSON.stringify(countsBefore));
  }

  if (args.apply) {
    await runPrecheck(sb, manifest);
    const backup = await createBackup(sb, manifestChecksum, manifest);
    console.log("Backup written:", backup.backup_path);
    const seedResult = await applySeed(sb, manifest);
    console.log(JSON.stringify(seedResult, null, 2));
    const rollbackPath = createRollbackManifest(backup, seedResult, manifestChecksum);
    console.log("Rollback manifest:", rollbackPath);
    await runVerify(sb, manifest);
  }

  if (args.verify) {
    await runVerify(sb, manifest);
    const countsAfter = await fetchDbCounts(sb);
    console.log("Table counts (after):", JSON.stringify(countsAfter));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
