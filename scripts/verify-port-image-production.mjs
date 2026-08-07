#!/usr/bin/env node
/**
 * Production verification: migration, Civitavecchia E2E apply, manual protection, five-port retest.
 *
 *   node scripts/verify-port-image-production.mjs --audit
 *   node scripts/verify-port-image-production.mjs --apply-civitavecchia
 *   node scripts/verify-port-image-production.mjs --five-port
 *   node scripts/verify-port-image-production.mjs --manual-protection
 *   node scripts/verify-port-image-production.mjs --public-check
 *   node scripts/verify-port-image-production.mjs --brave-check
 *   node scripts/verify-port-image-production.mjs --all
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates } = require(path.join(root, "netlify/functions/lib/port-image-finder/search.js"));
const {
  scorePortImageCandidate,
  statusForCandidate,
  isVesselPrimarySubject
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const { applyPortImageCandidate, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { braveImageSearch, getBraveApiKey } = require(path.join(root, "netlify/functions/lib/brave-search.js"));
const { portImageFallback } = require(path.join(root, "netlify/functions/lib/destination-image-fallbacks.js"));

const NETLIFY_ORIGIN = process.env.SMOKE_NETLIFY_ORIGIN || "https://admirable-tiramisu-d4da8a.netlify.app";
const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";

const IMAGE_COLUMNS = [
  "hero_media_id",
  "image_status",
  "image_source",
  "image_source_url",
  "image_credit",
  "image_license",
  "image_search_query",
  "image_confidence",
  "image_last_checked_at",
  "image_candidates"
];

const PORT_SELECT = `id,canonical_name,display_name,city,country,country_code,region,aliases,${IMAGE_COLUMNS.join(",")}`;

const TEST_PORTS = [
  { label: "Albany, Western Australia", match: /albany/i, country: /australia|western australia/i },
  { label: "Newcastle, NSW", match: /newcastle/i, country: /australia|new south wales/i, exclude: /tyne|united kingdom|england/i },
  { label: "Victoria, BC", match: /victoria bc|victoria/i, country: /canada|british columbia/i, exclude: /australia|alaska/i },
  { label: "Civitavecchia, Italy", match: /civitavecchia/i, country: /italy/i },
  { label: "Port Chalmers, NZ", match: /port chalmers|chalmers/i, country: /new zealand|otago|dunedin/i }
];

function parseArgs(argv) {
  const args = {
    audit: false,
    applyCivit: false,
    fivePort: false,
    manualProtection: false,
    publicCheck: false,
    braveCheck: false,
    all: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--audit") args.audit = true;
    if (arg === "--apply-civitavecchia") args.applyCivit = true;
    if (arg === "--five-port") args.fivePort = true;
    if (arg === "--manual-protection") args.manualProtection = true;
    if (arg === "--public-check") args.publicCheck = true;
    if (arg === "--brave-check") args.braveCheck = true;
    if (arg === "--all") args.all = true;
  }
  if (args.all) Object.assign(args, { audit: true, applyCivit: true, fivePort: true, manualProtection: true, publicCheck: true, braveCheck: true });
  if (!Object.values(args).some(Boolean)) args.audit = true;
  return args;
}

function makeSupabaseClient(rest) {
  const { url, key } = require(path.join(root, "scripts/lib/supabase-rest.cjs")).getSupabaseConfig(root);
  async function fetchRest(restPath, options = {}) {
    return rest.request(restPath, options);
  }
  function publicObjectUrl(storagePath) {
    return `${url}/storage/v1/object/public/cruise-media/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  }
  async function uploadObject(bucket, storagePath, buffer, contentType) {
    const response = await fetch(
      `${url}/storage/v1/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": contentType || "application/octet-stream",
          "x-upsert": "true"
        },
        body: buffer
      }
    );
    if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`);
  }
  return { fetchRest, publicObjectUrl, uploadObject };
}

async function auditMigration(rest) {
  const columnChecks = {};
  for (const col of IMAGE_COLUMNS) {
    try {
      await rest.get(`ports?select=${col}&limit=1`);
      columnChecks[col] = true;
    } catch (error) {
      columnChecks[col] = false;
    }
  }
  const allPresent = IMAGE_COLUMNS.every((c) => columnChecks[c]);
  const countRows = await rest.get("ports?select=id&limit=2000");
  const sample = allPresent ? await rest.get(`ports?select=id,canonical_name,hero_media_id,image_status&limit=3`) : [];
  const report = {
    phase: "migration_audit",
    columns_present: columnChecks,
    all_columns_present: allPresent,
    ports_count: Array.isArray(countRows) ? countRows.length : null,
    schema_warning_expected: !allPresent,
    sample_ports: sample,
    passed: allPresent && countRows.length === 264
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function findPort(allPorts, spec) {
  return allPorts.find((port) => {
    const hay = [port.canonical_name, port.display_name, port.city, port.country, port.region].filter(Boolean).join(" ");
    if (spec.exclude && spec.exclude.test(hay)) return false;
    return spec.match.test(hay) && spec.country.test(hay);
  });
}

function pickHarbourCandidate(candidates, port) {
  const preferred = candidates.find((c) => /outher harbour|harbour panorama|harbour and|waterfront|inner harbor|inner harbour/i.test(c.title || ""));
  if (preferred) return preferred;
  return candidates.find((c) => {
    const scored = scorePortImageCandidate(c, port);
    return !isVesselPrimarySubject(c).vesselPrimary && scored.suitability >= 70;
  });
}

async function applyCivitavecchia(rest) {
  const ports = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${CIVIT_ID}&limit=1`);
  const port = ports[0];
  if (!port) throw new Error("Civitavecchia port not found");

  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const harbour = pickHarbourCandidate(search.candidates || [], port);
  if (!harbour) throw new Error("No suitable harbour candidate found for Civitavecchia");

  const supabase = makeSupabaseClient(rest);
  const applied = await applyPortImageCandidate(supabase, port, harbour, {
    imageStatus: "MANUAL",
    searchQuery: search.primaryQuery,
    confidence: harbour.confidence
  });

  const reloaded = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${CIVIT_ID}&limit=1`);
  const media = await rest.get(`media_library?select=id,public_url,storage_path,source_url,import_source,mime_type&id=eq.${applied.media.id}&limit=1`);

  const report = {
    phase: "civitavecchia_apply",
    selected_title: harbour.title,
    selected_provider: harbour.provider,
    selected_license: harbour.license,
    selected_source_url: harbour.sourceUrl,
    storage_path: applied.media.storage_path,
    media_library_id: applied.media.id,
    public_url: applied.media.public_url,
    ports_hero_media_id: reloaded[0]?.hero_media_id,
    image_status: reloaded[0]?.image_status,
    image_source: reloaded[0]?.image_source,
    image_license: reloaded[0]?.image_license,
    image_credit: reloaded[0]?.image_credit,
    image_confidence: reloaded[0]?.image_confidence,
    media_record: media[0] || null,
    passed:
      reloaded[0]?.hero_media_id === applied.media.id &&
      reloaded[0]?.image_status === "MANUAL" &&
      Boolean(applied.media.public_url) &&
      !String(applied.media.public_url).includes("wikimedia.org")
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function testManualProtection(rest) {
  const ports = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${CIVIT_ID}&limit=1`);
  const port = ports[0];
  const canOverwrite = canOverwritePortImage(port);
  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const report = {
    phase: "manual_protection",
    image_status: port?.image_status,
    hero_media_id: port?.hero_media_id,
    can_overwrite: canOverwrite,
    find_image_skipped: search.skipped,
    find_image_reason: search.reason,
    candidates_returned: (search.candidates || []).length,
    passed: !canOverwrite && port?.image_status === "MANUAL" && Boolean(port?.hero_media_id)
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function fivePortTest(rest) {
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc&limit=2000`);
  const results = [];
  for (const spec of TEST_PORTS) {
    const port = findPort(allPorts, spec);
    if (!port) {
      results.push({ port: spec.label, found: false });
      continue;
    }
    const search = await findPortImageCandidates(port, { force: true, autoApply: false });
    const top = search.candidates?.[0] || null;
    const vessel = top ? isVesselPrimarySubject(top) : { vesselPrimary: false };
    const scored = top ? scorePortImageCandidate(top, port) : null;
    const status = scored ? statusForCandidate({ ...scored, candidate: top }) : "NO_IMAGE";
    results.push({
      port: spec.label,
      catalogue_match: port.canonical_name,
      best_candidate: top?.title || null,
      geographic: scored?.geographic ?? null,
      suitability: scored?.suitability ?? null,
      vessel_primary: vessel.vesselPrimary,
      vessel_reason: vessel.reason || null,
      status
    });
  }
  console.log(JSON.stringify({ phase: "five_port", results }, null, 2));
  return results;
}

async function braveCheck() {
  const report = {
    phase: "brave_check",
    configured: Boolean(getBraveApiKey()),
    http_status: null,
    image_search_works: false,
    result_count: 0,
    error: null
  };
  if (!report.configured) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  try {
    const results = await braveImageSearch(null, "Civitavecchia Italy harbour waterfront", { count: 3 });
    report.http_status = 200;
    report.image_search_works = Array.isArray(results) && results.length > 0;
    report.result_count = results.length;
  } catch (error) {
    report.error = error.message;
    report.http_status = error.statusCode || null;
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function publicCheck(rest) {
  const civit = await rest.get(`ports?select=id,canonical_name,hero_media_id,image_status&canonical_name=eq.Civitavecchia&limit=1`);
  const slug = "mediterranean";
  const response = await fetch(`${NETLIFY_ORIGIN}/.netlify/functions/public-destination?slug=${slug}`);
  const data = await response.json();
  const ports = data?.destination?.ports || [];
  const civitPort = ports.find((p) => /civitavecchia|rome/i.test(p?.name || ""));
  const blankPorts = ports.filter((p) => !p?.media?.url);

  const report = {
    phase: "public_check",
    http_status: response.status,
    destination_loaded: Boolean(data?.success),
    ports_on_page: ports.length,
    civitavecchia_has_stored_image: Boolean(civit[0]?.hero_media_id),
    civitavecchia_public_name: civitPort?.name || null,
    civitavecchia_public_media_id: civitPort?.mediaId || null,
    civitavecchia_public_media_url: civitPort?.media?.url || null,
    blank_ports_count: blankPorts.length,
    sample_blank_port: blankPorts[0]?.name || null,
    country_fallback_disabled: portImageFallback("mediterranean", "test", "Test") === null,
    destination_hero_present: Boolean(data?.destination?.hero?.url),
    passed:
      response.ok &&
      data?.success &&
      portImageFallback("x", "y", "z") === null &&
      (civit[0]?.hero_media_id ? Boolean(civitPort?.media?.url) : true)
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const rest = createSupabaseRest(root);
  let audit = null;
  if (args.audit) audit = await auditMigration(rest);
  if (audit && !audit.all_columns_present && (args.applyCivit || args.manualProtection)) {
    console.error("Migration columns missing — cannot run apply/manual tests.");
    process.exit(1);
  }
  if (args.applyCivit) await applyCivitavecchia(rest);
  if (args.manualProtection) await testManualProtection(rest);
  if (args.fivePort) await fivePortTest(rest);
  if (args.braveCheck) await braveCheck();
  if (args.publicCheck) await publicCheck(rest);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
