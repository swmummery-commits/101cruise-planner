#!/usr/bin/env node
/**
 * Silversea Phase 4A — create approved canonical ports in CSV + Supabase.
 *
 *   node scripts/apply-silversea-canonical-port-batch.mjs --dry-run
 *   node scripts/apply-silversea-canonical-port-batch.mjs --apply
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  PHASE4A_CANONICAL_PORT_CREATES,
  assertManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-canonical-port-batch"));
const { resetPortsCache, resolveRawPortText } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const PORTS_CSV = path.join(root, "data/ports/ports-catalogue.csv");
const REPORT_DIR = path.join(root, "reports");

function buildMatchKey(name, country) {
  const n = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const c = String(country || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return c ? `${n}|${c}` : `${n}|`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function specToCsvLine(spec) {
  const lat = spec.latitude != null ? spec.latitude : "";
  const lng = spec.longitude != null ? spec.longitude : "";
  const aliases = (spec.aliases || []).join("|");
  return [
    csvEscape(spec.canonical_name),
    csvEscape(spec.display_name),
    csvEscape(spec.city),
    csvEscape(spec.country),
    csvEscape(spec.country_code),
    csvEscape(spec.region),
    lat,
    lng,
    csvEscape(aliases)
  ].join(",");
}

async function findByMatchKey(rest, matchKey) {
  const rows = await rest.get(
    `ports?select=id,canonical_name,country,match_key,aliases&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function findAlternate(rest, spec) {
  for (const name of [spec.canonical_name, ...(spec.aliases || [])]) {
    const rows = await rest.get(
      `ports?select=id,canonical_name,country,match_key,aliases&canonical_name=eq.${encodeURIComponent(name)}&limit=5`
    );
    if (!Array.isArray(rows)) continue;
    const hit = rows.find(
      (row) => String(row.country || "").toLowerCase() === String(spec.country || "").toLowerCase()
    );
    if (hit) return hit;
  }
  return null;
}

function csvHasCanonical(text, canonicalName) {
  const needle = `\n${canonicalName},`;
  return text.includes(needle) || text.startsWith(`${canonicalName},`);
}

function runId() {
  return `silversea-phase4a-canonical-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function verifyResolutions(specs) {
  resetPortsCache();
  const checks = [];
  for (const spec of specs) {
    for (const alias of [spec.silversea_source_name, ...(spec.aliases || [])]) {
      const resolution = resolveRawPortText(alias);
      checks.push({
        alias,
        canonical_name: spec.canonical_name,
        status: resolution.status,
        resolved_name: resolution.canonicalPortName || null,
        ok: resolution.status === "resolved" && resolution.canonicalPortName === spec.canonical_name
      });
    }
  }
  return checks;
}

async function main() {
  assertManifestWithinLimit();
  const id = runId();
  const beforeCsv = fs.readFileSync(PORTS_CSV, "utf8");
  const rest = createSupabaseRest(root);
  const proposed = [];
  const skipped = [];

  const csvSyncOnly = [];

  for (const [index, spec] of PHASE4A_CANONICAL_PORT_CREATES.entries()) {
    const matchKey = buildMatchKey(spec.canonical_name, spec.country);
    const csvExists = csvHasCanonical(beforeCsv, spec.canonical_name);
    const supabaseExisting = (await findByMatchKey(rest, matchKey)) || (await findAlternate(rest, spec));
    if (csvExists && supabaseExisting) {
      skipped.push({
        sequence: index + 1,
        canonical_name: spec.canonical_name,
        reason: "csv_and_supabase_exists",
        supabase_id: supabaseExisting.id
      });
      continue;
    }
    if (csvExists) {
      skipped.push({
        sequence: index + 1,
        canonical_name: spec.canonical_name,
        reason: "csv_exists",
        supabase_id: supabaseExisting?.id || null
      });
      continue;
    }
    if (supabaseExisting) {
      csvSyncOnly.push({
        sequence: index + 1,
        ...spec,
        match_key: matchKey,
        csv_line: specToCsvLine(spec),
        supabase_id: supabaseExisting.id,
        supabase_aliases: supabaseExisting.aliases || []
      });
      continue;
    }
    proposed.push({
      sequence: index + 1,
      ...spec,
      match_key: matchKey,
      csv_line: specToCsvLine(spec)
    });
  }

  if (proposed.length + csvSyncOnly.length > 25) {
    throw new Error(
      `Proposed creates ${proposed.length} + csv sync ${csvSyncOnly.length} exceed Phase 4A limit of 25`
    );
  }

  const report = {
    run_id: id,
    mode: APPLY ? "apply" : "dry-run",
    started_at: new Date().toISOString(),
    proposed_count: proposed.length,
    csv_sync_count: csvSyncOnly.length,
    skipped_count: skipped.length,
    proposed,
    csv_sync_only: csvSyncOnly,
    skipped,
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 }
  };

  const writes = [];
  const aliasUpdates = [];
  let nextCsv = beforeCsv.trimEnd();

  if (APPLY && (proposed.length || csvSyncOnly.length)) {
    const lines = [...proposed, ...csvSyncOnly].map((p) => p.csv_line);
    nextCsv = `${nextCsv}\n${lines.join("\n")}\n`;
    if (!nextCsv.startsWith("\uFEFF") && beforeCsv.startsWith("\uFEFF")) {
      nextCsv = `\uFEFF${nextCsv}`;
    }
    fs.writeFileSync(PORTS_CSV, nextCsv);
    resetPortsCache();

    for (const spec of proposed) {
      const payload = {
        canonical_name: spec.canonical_name,
        display_name: spec.display_name,
        city: spec.city,
        country: spec.country,
        country_code: spec.country_code,
        region: spec.region,
        latitude: spec.latitude,
        longitude: spec.longitude,
        aliases: spec.aliases,
        status: "verified",
        source: "silversea:phase4a_canonical_ports",
        match_key: spec.match_key
      };
      const inserted = await rest.request("ports", {
        method: "POST",
        body: payload,
        prefer: "return=representation"
      });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      writes.push({ table: "ports", action: "insert", canonical_name: spec.canonical_name, id: row?.id, payload });
    }

    for (const spec of csvSyncOnly) {
      const mergedAliases = Array.from(
        new Set([...(spec.supabase_aliases || []), ...(spec.aliases || [])].filter(Boolean))
      );
      if (mergedAliases.length !== (spec.supabase_aliases || []).length) {
        await rest.patch(`ports?id=eq.${spec.supabase_id}`, { aliases: mergedAliases });
        aliasUpdates.push({
          table: "ports",
          action: "patch_aliases",
          canonical_name: spec.canonical_name,
          id: spec.supabase_id,
          aliases: mergedAliases
        });
      }
    }
  }

  report.actual_creates = APPLY ? writes : [];
  report.csv_sync_applied = APPLY ? csvSyncOnly.map((s) => s.canonical_name) : [];
  report.alias_updates = APPLY ? aliasUpdates : [];
  if (APPLY && (proposed.length || csvSyncOnly.length)) {
    report.verification = verifyResolutions(PHASE4A_CANONICAL_PORT_CREATES);
    report.all_verified = report.verification.every((c) => c.ok);
  } else {
    report.verification = [];
    report.all_verified = null;
  }
  report.rollback_manifest = {
    run_id: id,
    csv_file: "data/ports/ports-catalogue.csv",
    before_sha256: crypto.createHash("sha256").update(beforeCsv).digest("hex"),
    before_content: beforeCsv,
    created_ports: [...proposed, ...csvSyncOnly].map((p) => ({
      canonical_name: p.canonical_name,
      match_key: p.match_key,
      csv_line: p.csv_line,
      supabase_id: writes.find((w) => w.canonical_name === p.canonical_name)?.id || p.supabase_id || null,
      csv_sync_only: Boolean(p.supabase_id && !writes.find((w) => w.canonical_name === p.canonical_name))
    }))
  };
  report.ended_at = new Date().toISOString();

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${id}.json`);
  const rollbackPath = path.join(REPORT_DIR, `silversea-phase4a-canonical-rollback-${id}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(rollbackPath, `${JSON.stringify(report.rollback_manifest, null, 2)}\n`);

  console.log(JSON.stringify({ ...report, report_path: reportPath, rollback_path: rollbackPath }, null, 2));
  if (APPLY && (proposed.length || csvSyncOnly.length) && !report.all_verified) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
