#!/usr/bin/env node
/**
 * Apply verified priority cruise_search_url configuration.
 *
 *   node scripts/apply-priority-discovery-sources.mjs --generate --verification=reports/priority-source-verification.json
 *   node scripts/apply-priority-discovery-sources.mjs --precheck --manifest=reports/priority-source-config-manifest.json
 *   node scripts/apply-priority-discovery-sources.mjs --apply --manifest=reports/priority-source-config-manifest.json
 *
 * Requires .env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. No SQL.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function parseArgs(argv) {
  const args = {
    generate: false,
    precheck: false,
    apply: false,
    verification: path.join(root, "reports/priority-source-verification.json"),
    manifest: path.join(root, "reports/priority-source-config-manifest.json")
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--generate") args.generate = true;
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--verification=")) args.verification = arg.slice("--verification=".length);
    if (arg.startsWith("--manifest=")) args.manifest = arg.slice("--manifest=".length);
  }
  return args;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildManifestEntry(lineReport) {
  return {
    cruise_line_id: lineReport.cruise_line_id,
    cruise_line_name: lineReport.cruise_line_name,
    slug: lineReport.slug,
    website_url: lineReport.website_url,
    current_cruise_search_url: lineReport.current_cruise_search_url,
    proposed_cruise_search_url: lineReport.recommended_cruise_search_url,
    source_type: lineReport.recommended_source_type,
    adapter_id: lineReport.adapter_id,
    category: lineReport.category,
    verification_evidence: {
      fetch_ok: lineReport.recommended_fetch_ok,
      sailing_links: lineReport.recommended_sailing_links,
      structured_voyages: lineReport.recommended_structured_voyages,
      likely_sailing_pages: lineReport.recommended_likely_pages,
      expected_extraction_method: lineReport.expected_extraction_method,
      rejection_reason: lineReport.rejection_reason,
      candidates_probed: (lineReport.candidates_probed || []).map((c) => ({
        url: c.url,
        fetch_ok: c.fetch_ok,
        likely_sailing_pages: c.likely_sailing_pages,
        official_domain_ok: c.official_domain_ok
      }))
    },
    rollback_cruise_search_url: lineReport.current_cruise_search_url
  };
}

async function loadLinesById(sb, entries) {
  const ids = entries.map((e) => e.cruise_line_id);
  const rows = await sb.get(
    `ci_cruise_lines?id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,slug,website_url,cruise_search_url`
  );
  return Object.fromEntries((rows || []).map((r) => [r.id, r]));
}

async function generateManifest(args) {
  const verification = JSON.parse(fs.readFileSync(args.verification, "utf8"));
  const entries = (verification.per_line || [])
    .filter((line) => line.recommended_cruise_search_url)
    .map(buildManifestEntry);

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: "priority_source_configuration",
    writes_performed: false,
    line_count: entries.length,
    entries
  };

  fs.mkdirSync(path.dirname(args.manifest), { recursive: true });
  fs.writeFileSync(args.manifest, JSON.stringify(manifest, null, 2));
  console.log(`Generated manifest with ${entries.length} lines: ${args.manifest}`);
  return manifest;
}

async function precheckManifest(sb, manifest) {
  const live = await loadLinesById(sb, manifest.entries || []);
  const issues = [];
  for (const entry of manifest.entries || []) {
    const row = live[entry.cruise_line_id];
    if (!row) issues.push(`${entry.cruise_line_name}: line not found`);
    else if ((row.cruise_search_url || null) !== (entry.current_cruise_search_url || null)) {
      issues.push(
        `${entry.cruise_line_name}: current cruise_search_url mismatch (live=${row.cruise_search_url || "null"}, manifest=${entry.current_cruise_search_url || "null"})`
      );
    }
    if (!entry.proposed_cruise_search_url) {
      issues.push(`${entry.cruise_line_name}: missing proposed URL`);
    }
  }
  return { ok: issues.length === 0, issues, live };
}

async function applyManifest(sb, manifest) {
  const { ok, issues, live } = await precheckManifest(sb, manifest);
  if (!ok) {
    throw new Error(`Precheck failed:\n${issues.join("\n")}`);
  }

  const applied = [];
  for (const entry of manifest.entries || []) {
    await sb.patch(`ci_cruise_lines?id=eq.${encodeURIComponent(entry.cruise_line_id)}`, {
      cruise_search_url: entry.proposed_cruise_search_url
    });
    applied.push({
      cruise_line_id: entry.cruise_line_id,
      cruise_line_name: entry.cruise_line_name,
      previous_cruise_search_url: live[entry.cruise_line_id]?.cruise_search_url || null,
      applied_cruise_search_url: entry.proposed_cruise_search_url
    });
  }

  const rollbackPath = path.join(root, "reports", `priority-source-config-rollback-${stamp()}.json`);
  const rollback = {
    generated_at: new Date().toISOString(),
    applied_from_manifest: path.basename(manifest.source_manifest || "priority-source-config-manifest.json"),
    entries: applied.map((a, i) => ({
      ...manifest.entries[i],
      rollback_cruise_search_url: a.previous_cruise_search_url
    }))
  };
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));

  return { applied, rollbackPath };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);

  if (args.generate) {
    await generateManifest(args);
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  manifest.source_manifest = path.basename(args.manifest);

  if (args.precheck) {
    const result = await precheckManifest(sb, manifest);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (args.apply) {
    const result = await applyManifest(sb, manifest);
    console.log(JSON.stringify({ applied: result.applied.length, rollback: result.rollbackPath }, null, 2));
    return;
  }

  console.error("Use --generate, --precheck, or --apply");
  process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
