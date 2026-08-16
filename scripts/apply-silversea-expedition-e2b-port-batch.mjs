#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2b — apply canonical ports + aliases + logistics mappings.
 *
 *   node scripts/apply-silversea-phase4d-port-batch.mjs --dry-run
 *   node scripts/apply-silversea-phase4d-port-batch.mjs --apply
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
  E2B_CANONICAL_PORT_CREATES,
  E2B_EXISTING_PORT_ALIASES,
  E2B_SILVERSEA_ADAPTER_ALIASES,
  E2B_LOGISTICS_GATEWAY_MAPPINGS,
  assertE2bManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2b-port-batch"));
const { resolveExpeditionLogisticsGateway } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-endpoint-resolution"
));
const { resetPortsCache, resolveRawPortText } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const PORTS_CSV = path.join(root, "data/ports/ports-catalogue.csv");
const REPORT_DIR = path.join(root, "reports");

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function splitCsv(text) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] == null ? "" : cols[i];
    });
    return row;
  });
  return { headers, rows };
}

function serializeCsv(headers, rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  const body = lines.join("\n");
  return body.startsWith("\uFEFF") ? `${body}\n` : `\uFEFF${body}\n`;
}

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

function csvHasCanonical(text, canonicalName) {
  const needle = `\n${canonicalName},`;
  return text.includes(needle) || text.startsWith(`${canonicalName},`);
}

function runId() {
  return `silversea-expedition-e2b-port-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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

function planAliasWrites(csvText) {
  const { headers, rows } = splitCsv(csvText);
  const writes = [];
  const skipped = [];
  for (const spec of E2B_EXISTING_PORT_ALIASES) {
    const row = rows.find((r) => r.canonical_name === spec.canonical_name);
    if (!row) {
      skipped.push({ ...spec, reason: "canonical_port_not_found_in_csv" });
      continue;
    }
    const existing = String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    const toAdd = spec.aliases.filter((alias) => !existing.includes(alias));
    if (!toAdd.length) {
      skipped.push({ ...spec, reason: "aliases_already_present" });
      continue;
    }
    const afterAliases = [...existing, ...toAdd];
    writes.push({
      canonical_name: spec.canonical_name,
      aliases_added: toAdd,
      before_aliases: existing,
      after_aliases: afterAliases,
      silversea_source_name: spec.silversea_source_name,
      silversea_port_code: spec.silversea_port_code,
      evidence: spec.evidence
    });
    row.aliases = afterAliases.join("|");
  }
  return { headers, rows, writes, skipped, nextCsv: serializeCsv(headers, rows) };
}

function resolveForVerification(alias, spec) {
  let resolution = resolveRawPortText(alias);
  if (resolution.status !== "resolved") {
    resolution = adapter.resolveSilverseaPort(alias, "silversea_e2b_verify", {
      cruiseType: "Expedition",
      portCode: spec.silversea_port_code
    });
  }
  return resolution;
}

function verifyAll(specs, aliasWrites) {
  resetPortsCache();
  const checks = [];
  for (const spec of specs) {
    for (const alias of [spec.silversea_source_name, ...(spec.aliases || [])]) {
      const resolution = resolveForVerification(alias, spec);
      checks.push({
        alias,
        canonical_name: spec.canonical_name,
        status: resolution.status,
        resolved_name: resolution.canonicalPortName || null,
        ok: resolution.status === "resolved" && resolution.canonicalPortName === spec.canonical_name
      });
    }
  }
  for (const write of aliasWrites) {
    for (const alias of write.aliases_added) {
      const resolution = resolveRawPortText(alias);
      checks.push({
        alias,
        canonical_name: write.canonical_name,
        status: resolution.status,
        resolved_name: resolution.canonicalPortName || null,
        ok: resolution.status === "resolved" && resolution.canonicalPortName === write.canonical_name
      });
    }
  }
  for (const mapping of E2B_SILVERSEA_ADAPTER_ALIASES) {
    const resolution = adapter.resolveSilverseaPort(mapping.source_label, "silversea_e2b_verify", {
      cruiseType: "Expedition",
      portCode: mapping.silversea_port_code
    });
    checks.push({
      alias: mapping.source_label,
      canonical_name: mapping.target_canonical,
      status: resolution.status,
      resolved_name: resolution.canonicalPortName || null,
      ok: resolution.status === "resolved" && resolution.canonicalPortName === mapping.target_canonical,
      via: "silversea_adapter"
    });
  }
  return checks;
}

async function main() {
  assertE2bManifestWithinLimit();
  const id = runId();
  const beforeCsv = fs.readFileSync(PORTS_CSV, "utf8");
  const rest = createSupabaseRest(root);

  const aliasPlan = planAliasWrites(beforeCsv);
  let workingCsv = aliasPlan.writes.length ? aliasPlan.nextCsv : beforeCsv;
  const aliasSupabasePatches = [];

  const proposed = [];
  const csvSyncOnly = [];
  const skipped = [];

  for (const [index, spec] of E2B_CANONICAL_PORT_CREATES.entries()) {
    const matchKey = buildMatchKey(spec.canonical_name, spec.country);
    const csvExists = csvHasCanonical(workingCsv, spec.canonical_name);
    const supabaseExisting = (await findByMatchKey(rest, matchKey)) || (await findAlternate(rest, spec));
    if (csvExists && supabaseExisting) {
      skipped.push({ sequence: index + 1, canonical_name: spec.canonical_name, reason: "csv_and_supabase_exists" });
      continue;
    }
    if (csvExists) {
      skipped.push({ sequence: index + 1, canonical_name: spec.canonical_name, reason: "csv_exists" });
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

  if (proposed.length > 10) {
    throw new Error(`Proposed new canonical ports ${proposed.length} exceed E2b limit of 10`);
  }

  const report = {
    run_id: id,
    mode: APPLY ? "apply" : "dry-run",
    started_at: new Date().toISOString(),
    proposed_new_canonical_count: proposed.length,
    csv_sync_count: csvSyncOnly.length,
    alias_write_count: aliasPlan.writes.length,
    silversea_adapter_mappings: E2B_SILVERSEA_ADAPTER_ALIASES,
    logistics_gateway_mappings: E2B_LOGISTICS_GATEWAY_MAPPINGS,
    skipped_count: skipped.length,
    proposed,
    csv_sync_only: csvSyncOnly,
    alias_writes: aliasPlan.writes,
    alias_skipped: aliasPlan.skipped,
    skipped,
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 }
  };

  const writes = [];
  const aliasUpdates = [];
  let nextCsv = workingCsv.trimEnd();

  if (APPLY && (aliasPlan.writes.length || proposed.length || csvSyncOnly.length)) {
    if (aliasPlan.writes.length) {
      fs.writeFileSync(PORTS_CSV, aliasPlan.nextCsv);
      nextCsv = aliasPlan.nextCsv.trimEnd();
      resetPortsCache();
      for (const write of aliasPlan.writes) {
        const row =
          (await rest.get(
            `ports?select=id,aliases&canonical_name=eq.${encodeURIComponent(write.canonical_name)}&limit=1`
          ))?.[0] || null;
        if (!row?.id) continue;
        const merged = Array.from(new Set([...(row.aliases || []), ...write.aliases_added]));
        await rest.patch(`ports?id=eq.${row.id}`, { aliases: merged });
        aliasSupabasePatches.push({ id: row.id, canonical_name: write.canonical_name, aliases: merged });
        aliasUpdates.push({ table: "ports", action: "patch_aliases", canonical_name: write.canonical_name, id: row.id });
      }
    }

    const lines = [...proposed, ...csvSyncOnly].map((p) => p.csv_line);
    if (lines.length) {
      nextCsv = `${nextCsv}\n${lines.join("\n")}\n`;
      if (!nextCsv.startsWith("\uFEFF") && beforeCsv.startsWith("\uFEFF")) {
        nextCsv = `\uFEFF${nextCsv}`;
      }
      fs.writeFileSync(PORTS_CSV, nextCsv);
      resetPortsCache();
    }

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
        source: "silversea:expedition_e2b_canonical_ports",
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
  report.alias_supabase_patches = APPLY ? aliasSupabasePatches : [];
  report.alias_updates = APPLY ? aliasUpdates : [];
  if (APPLY) {
    report.verification = verifyAll(E2B_CANONICAL_PORT_CREATES, aliasPlan.writes);
    report.logistics_gateway_checks = E2B_LOGISTICS_GATEWAY_MAPPINGS.map((row) => {
      const resolution = resolveExpeditionLogisticsGateway({
        sourceName: row.gateway_name,
        portCode: row.silversea_port_code
      });
      return {
        ...row,
        ok: resolution?.status === "resolved" && resolution.expedition_logistics_gateway === true
      };
    });
    report.all_verified =
      report.verification.every((c) => c.ok) && report.logistics_gateway_checks.every((c) => c.ok);
  }
  report.rollback_manifest = {
    run_id: id,
    phase: "expedition_e2b",
    csv_file: "data/ports/ports-catalogue.csv",
    before_sha256: crypto.createHash("sha256").update(beforeCsv).digest("hex"),
    before_content: beforeCsv,
    alias_writes: aliasPlan.writes,
    silversea_adapter_mappings: E2B_SILVERSEA_ADAPTER_ALIASES,
    logistics_gateway_mappings: E2B_LOGISTICS_GATEWAY_MAPPINGS,
    created_ports: [...proposed, ...csvSyncOnly].map((p) => ({
      canonical_name: p.canonical_name,
      match_key: p.match_key,
      csv_line: p.csv_line,
      supabase_id: writes.find((w) => w.canonical_name === p.canonical_name)?.id || p.supabase_id || null
    }))
  };
  report.ended_at = new Date().toISOString();

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${id}.json`);
  const rollbackPath = path.join(REPORT_DIR, `silversea-expedition-e2b-port-rollback-${id}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(rollbackPath, `${JSON.stringify(report.rollback_manifest, null, 2)}\n`);

  console.log(JSON.stringify({ ...report, report_path: reportPath, rollback_path: rollbackPath }, null, 2));
  if (APPLY && !report.all_verified) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
