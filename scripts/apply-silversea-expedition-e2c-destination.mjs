#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2c — verify destination mapping (code-only, no Supabase writes).
 *
 *   node scripts/apply-silversea-expedition-e2c-destination.mjs
 *   node scripts/apply-silversea-expedition-e2c-destination.mjs --write-report
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

const WRITE_REPORT = process.argv.includes("--write-report");
const REPORT_DIR = path.join(root, "reports");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const {
  E2C_DESTINATION_MAPPING_MANIFEST,
  E2C_SILVERSEA_DESTINATION_SLUGS,
  assertE2cManifestWithinLimit,
  buildE2cRollbackManifest
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2c-destination-batch"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { resolveOperationalDestination } = require(path.join(
  root,
  "netlify/functions/lib/discovery-destination-resolver"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function destinationRowForSlug(destinations, slug) {
  return destinations.find((d) => String(d.slug || "").toLowerCase() === String(slug || "").toLowerCase());
}

async function main() {
  assertE2cManifestWithinLimit();
  const runId = `silversea-expedition-e2c-destination-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const rest = createSupabaseRest(root);
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => rest.get(q)));

  const beforeState = {
    silversea_destination_slug_keys: Object.keys(adapter.SILVERSEA_DESTINATION_SLUG).sort(),
    e2c_mappings_present: Object.keys(E2C_SILVERSEA_DESTINATION_SLUGS).every(
      (k) => adapter.SILVERSEA_DESTINATION_SLUG[k] === E2C_SILVERSEA_DESTINATION_SLUGS[k]
    )
  };

  const verifications = [];
  let allVerified = true;

  for (const row of E2C_DESTINATION_MAPPING_MANIFEST) {
    const slug = row.canonical_slug;
    const destRow = destinationRowForSlug(destinations, slug);
    const fallback = adapter.destinationFallbackSlug(row.source_label);
    const opOnly = resolveOperationalDestination({
      title: "Arctic expedition",
      description: row.source_label,
      itinerary: "Reykjavik Nuuk Longyearbyen",
      departurePort: "Reykjavik",
      arrivalPort: "Reykjavik",
      nights: 10,
      destinations
    });
    const withFallback = resolveOperationalDestination({
      title: "Arctic expedition",
      description: row.source_label,
      itinerary: "Reykjavik Nuuk Longyearbyen",
      departurePort: "Reykjavik",
      arrivalPort: "Reykjavik",
      nights: 10,
      destinations,
      preferredDestination: { slug: fallback }
    });

    const checks = {
      raw_source_destination: row.source_label,
      canonical_slug: slug,
      fallback_slug: fallback,
      catalogue_destination_exists: Boolean(destRow?.id),
      catalogue_destination_id: destRow?.id || null,
      operational_without_fallback_unresolved: opOnly.status !== "resolved",
      operational_with_fallback_resolved: withFallback.status === "resolved",
      mapping_scope: row.mapping_scope,
      global_alias: row.global_alias,
      new_canonical: row.new_canonical,
      fuzzy_matching: row.fuzzy_matching,
      verified:
        fallback === slug &&
        Boolean(destRow?.id) &&
        withFallback.status === "resolved" &&
        withFallback.destinationKey === slug
    };
    if (!checks.verified) allVerified = false;
    verifications.push(checks);
  }

  const report = {
    phase: "expedition_e2c_destination",
    run_id: runId,
    started_at: new Date().toISOString(),
    git_sha: gitSha(),
    apply_mode: "code_only",
    supabase_writes: 0,
    proposed_mappings: E2C_DESTINATION_MAPPING_MANIFEST,
    actual_mappings: E2C_DESTINATION_MAPPING_MANIFEST,
    before_state: beforeState,
    rollback_manifest: buildE2cRollbackManifest(),
    verifications,
    all_verified: allVerified,
    expedition_new_canonical_destinations: 0,
    expedition_destination_mappings: E2C_DESTINATION_MAPPING_MANIFEST.length,
    expedition_new_canonical_ports: 0,
    expedition_port_aliases: 0,
    expedition_logistics_mappings: 0,
    production_cruise_writes: { inserts: 0, updates: 0, deletes: 0 }
  };

  if (WRITE_REPORT) {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.report_path = reportPath;
  }

  console.log(JSON.stringify({ run_id: runId, all_verified: allVerified, verifications }, null, 2));
  if (!allVerified) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
