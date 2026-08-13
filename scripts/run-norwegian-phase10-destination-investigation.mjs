#!/usr/bin/env node
/** Phase 10 Gate B — investigate Phase 9 destination_id null discrepancy. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { resolveNorwegianDestinationAssignment, NCL_DESTINATION_CODE_SLUG } = require(
  path.join(root, "netlify/functions/lib/norwegian-destination-mapping")
);

const AFFECTED = [
  "ENCORE6LAXSFOVICVAN|2027-04-18",
  "JOY6VANSEAASTSFOLAX|2026-10-01",
  "SPIRIT11AKLTAULYTORRMELBWTQDNSYD|2027-04-12",
  "SPIRIT11SYDHBAADLKANMELSYD|2026-12-12"
];

const MANIFEST_PATH = path.join(
  root,
  "reports/norwegian-phase9-controlled-batch-manifest-norwegian-phase9-2026-08-13-2026-08-13T08-02-02-023Z.json"
);

async function main() {
  const rest = createSupabaseRest(root);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const dryRun = JSON.parse(
    fs.readFileSync(
      path.join(root, "reports/norwegian-phase9-dry-run-norwegian-phase9-2026-08-13-2026-08-13T08-02-02-023Z.json"),
      "utf8"
    )
  );
  const destinations = await rest.get("destinations?select=id,name,slug&limit=100");
  const cases = [];

  for (const officialId of AFFECTED) {
    const manifestEntry = manifest.entries.find((e) => e.official_sailing_id === officialId);
    const dryEntry = dryRun.entries.find((e) => e.official_sailing_id === officialId);
    const dbRows = await rest.get(
      `discovered_cruises?official_sailing_id=eq.${encodeURIComponent(officialId)}&select=id,destination_id,status,raw_extract&limit=1`
    );
    const db = dbRows[0];
    const codes = manifestEntry?.destination_codes || [];
    const currentAssignment = resolveNorwegianDestinationAssignment({
      destination_codes: codes,
      dbRow: { departure_port: manifestEntry?.resolved_departure_port, nights: manifestEntry?.duration, itinerary: manifestEntry?.itinerary_code },
      destinations
    });

    cases.push({
      official_sailing_id: officialId,
      destination_codes: codes,
      code_slugs_now: codes.map((c) => ({ code: c, slug: NCL_DESTINATION_CODE_SLUG[c] ?? null })),
      manifest: {
        resolved_destination_id: manifestEntry?.resolved_destination_id ?? null,
        proposed_canonical_destination: manifestEntry?.proposed_canonical_destination ?? null,
        unknown_destination_codes: manifestEntry?.unknown_destination_codes ?? [],
        candidate_destination_id: manifestEntry?.candidate?.destination_id ?? null
      },
      dry_run_gate: dryRun.dry_run_gate,
      dry_run_entry_destination_id: dryEntry?.resolved_destination_id ?? null,
      production_now: {
        destination_id: db?.destination_id ?? null,
        status: db?.status ?? null
      },
      current_resolution: {
        destination_id: currentAssignment.destination_id,
        slug: currentAssignment.proposed_slug,
        method: currentAssignment.method
      }
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    root_cause:
      "Phase 9 manifest was frozen with resolved_destination_id=null for AUSTRALIA/PACIFIC_COASTAL voyages because NCL destination code slugs were absent at batch-build time (manifest audit shows proposed_slug:null). Dry-run gate FAILED (unresolved_destination, unknown_ncl_destination_code) but initial --full run bypassed the gate via postInsertMode including stage2/stage3 flags (fixed in 6f56788). applyManifestWrites faithfully inserted null destination_id because manifest.resolved_destination_id was null. Enrichment destination backfill repaired 4 rows later once mappings existed.",
    chain: [
      "manifest.resolved_destination_id null at freeze",
      "candidate.destination_id null in frozen manifest",
      "dry_run_gate.passed false",
      "gate bypass on --full (pre-6f56788 fix)",
      "applyManifestWrites: if (entry.resolved_destination_id) only — null preserved",
      "upsertCandidateRecord wrote destination_id:null",
      "enrichment backfill assigned destination_id post-hoc"
    ],
    hardening_applied: [
      "evaluateDryRunGate checks candidate.destination_id",
      "applyManifestWrites requireDestination blocks null inserts",
      "postInsertMode no longer includes stage flags",
      "Phase 10 baseline rejects null destination_id genuine rows"
    ],
    cases
  };

  const out = path.join(root, "reports/norwegian-phase10-destination-id-investigation.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report_path: out, root_cause: report.root_cause }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
