#!/usr/bin/env node
/**
 * Disney Phase 2C — apply approved port reference-data to ports-catalogue.csv.
 *
 *   node scripts/apply-disney-port-reference-data.mjs --precheck
 *   node scripts/apply-disney-port-reference-data.mjs --apply
 *   node scripts/apply-disney-port-reference-data.mjs --verify
 *   node scripts/apply-disney-port-reference-data.mjs --all
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  DISNEY_CANONICAL_PORT_CREATES,
  DISNEY_EXISTING_PORT_ALIASES
} = require(path.join(root, "netlify/functions/lib/disney-phase2c-port-batch"));
const { resetPortsCache, resolveRawPortText } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));

const PORTS_CSV = path.join(root, "data/ports/ports-catalogue.csv");
const MANIFEST_PATH = path.join(root, "reports/disney-phase2c-port-reference-manifest.json");

const mode = {
  precheck: process.argv.includes("--precheck"),
  apply: process.argv.includes("--apply"),
  verify: process.argv.includes("--verify"),
  all: process.argv.includes("--all")
};

function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cols = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') {
        q = !q;
        continue;
      }
      if (ch === "," && !q) {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

function serializeRow(headers, row) {
  return headers
    .map((h) => {
      const v = String(row[h] ?? "");
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
}

function loadCatalogue() {
  return parseCsv(fs.readFileSync(PORTS_CSV, "utf8"));
}

function buildPlan(catalogue) {
  const before = JSON.parse(JSON.stringify(catalogue));
  const changes = [];
  const rows = [...catalogue.rows];
  const canonicalSet = new Set(rows.map((r) => r.canonical_name));

  for (const spec of DISNEY_CANONICAL_PORT_CREATES) {
    if (canonicalSet.has(spec.canonical_name)) {
      changes.push({ action: "skip_existing", canonical_name: spec.canonical_name });
      continue;
    }
    rows.push({
      canonical_name: spec.canonical_name,
      display_name: spec.display_name,
      city: spec.city,
      country: spec.country,
      country_code: spec.country_code,
      region: spec.region,
      latitude: String(spec.latitude),
      longitude: String(spec.longitude),
      aliases: spec.aliases.join("|")
    });
    canonicalSet.add(spec.canonical_name);
    changes.push({ action: "insert", canonical_name: spec.canonical_name, spec });
  }

  for (const aliasSpec of DISNEY_EXISTING_PORT_ALIASES) {
    const row = rows.find((r) => r.canonical_name === aliasSpec.canonical_name);
    if (!row) {
      changes.push({ action: "missing_existing", canonical_name: aliasSpec.canonical_name });
      continue;
    }
    const existingAliases = new Set(String(row.aliases || "").split("|").filter(Boolean));
    const added = [];
    for (const alias of aliasSpec.add_aliases) {
      if (!existingAliases.has(alias)) {
        existingAliases.add(alias);
        added.push(alias);
      }
    }
    if (added.length) {
      row.aliases = [...existingAliases].join("|");
      changes.push({ action: "alias_append", canonical_name: aliasSpec.canonical_name, added });
    }
  }

  return { before, after: { headers: catalogue.headers, rows }, changes };
}

function runPrecheck(plan) {
  const failures = [];
  for (const spec of DISNEY_CANONICAL_PORT_CREATES) {
    const dup = plan.after.rows.filter((r) => r.canonical_name === spec.canonical_name);
    if (dup.length > 1) failures.push(`duplicate canonical ${spec.canonical_name}`);
  }
  return { passed: failures.length === 0, failures, changes: plan.changes };
}

function runVerify() {
  resetPortsCache();
  const results = [];
  for (const spec of DISNEY_CANONICAL_PORT_CREATES) {
    const resolved = resolveRawPortText(spec.disney_source_name, { sourceField: "disney_verify" });
    results.push({
      source: spec.disney_source_name,
      canonical_name: spec.canonical_name,
      resolved: resolved.status === "resolved",
      matched: resolved.canonicalPortName || null
    });
  }
  for (const aliasSpec of DISNEY_EXISTING_PORT_ALIASES) {
    for (const alias of aliasSpec.add_aliases) {
      const resolved = resolveRawPortText(alias, { sourceField: "disney_verify" });
      results.push({
        source: alias,
        canonical_name: aliasSpec.canonical_name,
        resolved: resolved.status === "resolved",
        matched: resolved.canonicalPortName || null
      });
    }
  }
  const passed = results.every((r) => r.resolved);
  return { passed, results };
}

function main() {
  const catalogue = loadCatalogue();
  const plan = buildPlan(catalogue);
  const report = { phase: "2C", mutations_performed: [] };

  if (mode.precheck || mode.all) {
    report.precheck = runPrecheck(plan);
    console.log(JSON.stringify({ step: "precheck", ...report.precheck }, null, 2));
    if (!report.precheck.passed) process.exit(1);
  }

  if (mode.apply || mode.all) {
    const lines = [plan.after.headers.join(",")];
    for (const row of plan.after.rows) lines.push(serializeRow(plan.after.headers, row));
    fs.writeFileSync(PORTS_CSV, `${lines.join("\n")}\n`);
    resetPortsCache();
    report.mutations_performed = plan.changes.filter((c) => c.action === "insert" || c.action === "alias_append");
    console.log(JSON.stringify({ step: "apply", changed: report.mutations_performed.length }, null, 2));
  }

  if (mode.verify || mode.all) {
    resetPortsCache();
    report.verify = runVerify();
    console.log(JSON.stringify({ step: "verify", ...report.verify }, null, 2));
    if (!report.verify.passed) process.exit(1);
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

main();
