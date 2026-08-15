#!/usr/bin/env node
/**
 * Apply approved Silversea Classic port reference-data alias writes to ports-catalogue.csv.
 *
 *   node scripts/apply-silversea-port-reference-data.mjs --dry-run
 *   node scripts/apply-silversea-port-reference-data.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { APPROVED_CATALOGUE_ALIAS_WRITES } = require(path.join(
  root,
  "netlify/functions/lib/silversea-port-remediation"
));
const { resetPortsCache, resolveRawPortText } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));

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
      } else {
        inQuotes = !inQuotes;
      }
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
  return `\uFEFF${lines.join("\n")}\n`;
}

function runId() {
  return `silversea-phase4-port-ref-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function buildPlan(csvText) {
  const { headers, rows } = splitCsv(csvText);
  const writes = [];
  const skipped = [];

  for (const spec of APPROVED_CATALOGUE_ALIAS_WRITES) {
    const row = rows.find((r) => r.canonical_name === spec.canonical_name);
    if (!row) {
      skipped.push({ ...spec, reason: "canonical_port_not_found" });
      continue;
    }
    const existing = String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    const toAdd = spec.aliases.filter((alias) => !existing.includes(alias));
    if (!toAdd.length) {
      skipped.push({ ...spec, reason: "aliases_already_present", existing_aliases: existing });
      continue;
    }
    const beforeAliases = [...existing];
    const afterAliases = [...existing, ...toAdd];
    writes.push({
      source: "Silversea",
      canonical_name: spec.canonical_name,
      source_port_name: spec.aliases.join(" | "),
      source_port_code: spec.source_port_code || null,
      canonical_port_id: `csv:${spec.canonical_name}`,
      country: spec.country,
      aliases_added: toAdd,
      before_aliases: beforeAliases,
      after_aliases: afterAliases,
      evidence: spec.evidence,
      confidence: spec.confidence,
      affected_classic_sailings_estimate: spec.affected_classic_sailings_estimate
    });
    row.aliases = afterAliases.join("|");
  }

  return {
    headers,
    rows,
    nextCsv: serializeCsv(headers, rows),
    writes,
    skipped
  };
}

function verifyAliases(writes) {
  resetPortsCache();
  const checks = [];
  for (const write of writes) {
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
  return checks;
}

async function main() {
  const id = runId();
  const beforeCsv = fs.readFileSync(PORTS_CSV, "utf8");
  const plan = buildPlan(beforeCsv);
  const report = {
    run_id: id,
    mode: APPLY ? "apply" : "dry-run",
    started_at: new Date().toISOString(),
    source: "Silversea",
    proposed_writes: plan.writes,
    skipped: plan.skipped,
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 }
  };

  if (APPLY && plan.writes.length) {
    fs.writeFileSync(PORTS_CSV, plan.nextCsv);
    resetPortsCache();
  }

  report.verification = verifyAliases(plan.writes);
  report.all_verified = report.verification.every((row) => row.ok);
  report.rollback_manifest = {
    run_id: id,
    file: "data/ports/ports-catalogue.csv",
    before_sha256: crypto.createHash("sha256").update(beforeCsv).digest("hex"),
    before_content: beforeCsv,
    writes: plan.writes.map((w) => ({
      canonical_name: w.canonical_name,
      aliases_added: w.aliases_added,
      before_aliases: w.before_aliases
    }))
  };
  report.actual_writes = APPLY ? plan.writes : [];
  report.ended_at = new Date().toISOString();

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${id}.json`);
  const rollbackPath = path.join(REPORT_DIR, `silversea-phase4-port-ref-rollback-${id}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(rollbackPath, `${JSON.stringify(report.rollback_manifest, null, 2)}\n`);

  console.log(JSON.stringify({ ...report, report_path: reportPath, rollback_path: rollbackPath }, null, 2));
  if (APPLY && !report.all_verified) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
