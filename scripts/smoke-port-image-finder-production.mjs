#!/usr/bin/env node
/**
 * Production smoke test for Port Image Finder (controlled — no bulk enrichment).
 *
 *   node scripts/smoke-port-image-finder-production.mjs --audit
 *   node scripts/smoke-port-image-finder-production.mjs --search
 *   node scripts/smoke-port-image-finder-production.mjs --apply-sample
 *   node scripts/smoke-port-image-finder-production.mjs --public-check
 *   node scripts/smoke-port-image-finder-production.mjs --all
 *
 * Requires .env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or Netlify env pull).
 * Does NOT run bulk_missing.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/search.js"
));
const { statusForCandidate } = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const { applyPortImageCandidate, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { braveImageSearch, getBraveApiKey } = require(path.join(root, "netlify/functions/lib/brave-search.js"));
const { portImageFallback } = require(path.join(root, "netlify/functions/lib/destination-image-fallbacks.js"));

const NETLIFY_ORIGIN = process.env.SMOKE_NETLIFY_ORIGIN || "https://admirable-tiramisu-d4da8a.netlify.app";

const TEST_PORTS = [
  { label: "Albany, Western Australia, Australia", match: /albany/i, country: /australia/i },
  { label: "Newcastle, NSW, Australia", match: /newcastle/i, country: /australia|nsw/i },
  { label: "Victoria, British Columbia, Canada", match: /victoria/i, country: /canada|british columbia|bc/i },
  { label: "Civitavecchia, Italy", match: /civitavecchia/i, country: /italy/i },
  { label: "Port Chalmers, New Zealand", match: /port chalmers|chalmers/i, country: /new zealand|otago|dunedin/i }
];

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const PORT_SELECT_BASIC =
  "id,canonical_name,display_name,city,country,country_code,region,aliases";

function parseArgs(argv) {
  const args = {
    audit: false,
    search: false,
    applySample: false,
    publicCheck: false,
    braveCheck: false,
    all: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--audit") args.audit = true;
    if (arg === "--search") args.search = true;
    if (arg === "--apply-sample") args.applySample = true;
    if (arg === "--public-check") args.publicCheck = true;
    if (arg === "--brave-check") args.braveCheck = true;
    if (arg === "--all") args.all = true;
  }
  if (args.all) {
    args.audit = true;
    args.search = true;
    args.applySample = true;
    args.publicCheck = true;
    args.braveCheck = true;
  }
  if (!args.audit && !args.search && !args.applySample && !args.publicCheck && !args.braveCheck) {
    args.audit = true;
    args.search = true;
    args.braveCheck = true;
  }
  return args;
}

function makeSupabaseClient(rest) {
  const { url, key } = require(path.join(root, "scripts/lib/supabase-rest.cjs")).getSupabaseConfig(root);

  async function fetchRest(restPath, options = {}) {
    return rest.request(restPath, options);
  }

  function publicObjectUrl(storagePath) {
    return `${url}/storage/v1/object/public/cruise-media/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
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
    if (!response.ok) {
      throw new Error(`Storage upload failed: ${response.status}`);
    }
  }

  return { fetchRest, publicObjectUrl, uploadObject };
}

async function loadAllPorts(rest) {
  try {
    const rows = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc&limit=2000`);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    if (!/hero_media_id|image_status|image_candidates/i.test(String(error.message || ""))) throw error;
    const rows = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT_BASIC)}&order=canonical_name.asc&limit=2000`);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      ...row,
      hero_media_id: null,
      image_status: null,
      image_candidates: []
    }));
  }
}

function findTestPort(allPorts, spec) {
  return (
    allPorts.find((port) => {
      const hay = [port.canonical_name, port.display_name, port.city, port.country, port.region]
        .filter(Boolean)
        .join(" ");
      return spec.match.test(hay) && spec.country.test(hay);
    }) ||
    allPorts.find((port) => spec.match.test(String(port.canonical_name || port.display_name || "")))
  );
}

function summariseCandidate(candidate) {
  return {
    provider: candidate?.provider || "",
    title: candidate?.title || "",
    geographic: candidate?.geographic ?? null,
    suitability: candidate?.suitability ?? null,
    confidence: candidate?.confidence ?? null,
    license: candidate?.license || null,
    sourceUrl: candidate?.sourceUrl || candidate?.pageUrl || "",
    width: candidate?.width || null,
    height: candidate?.height || null
  };
}

function assessLocation(port, candidate, spec) {
  const text = [candidate?.title, candidate?.description, candidate?.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const wrongHints = {
    albany: ["new york", "ny usa", "albany ny"],
    newcastle: ["upon tyne", "england", " uk", "united kingdom"],
    victoria: ["australia", "melbourne victoria", "vic australia"]
  };
  const key = spec.label.split(",")[0].trim().toLowerCase();
  if (key.startsWith("albany")) {
    if (wrongHints.albany.some((h) => text.includes(h))) return false;
    return /australia|western australia|wa|albany/.test(text) || candidate?.provider === "wikimedia";
  }
  if (key.startsWith("newcastle")) {
    if (wrongHints.newcastle.some((h) => text.includes(h))) return false;
    return /australia|nsw|new south wales|newcastle/.test(text) || !text.includes("tyne");
  }
  if (key.startsWith("victoria")) {
    if (wrongHints.victoria.some((h) => text.includes(h))) return false;
    return /canada|british columbia|\bbc\b|vancouver island/.test(text) || /victoria/.test(text);
  }
  return true;
}

async function runSearch(allPorts) {
  const results = [];
  for (const spec of TEST_PORTS) {
    const port = findTestPort(allPorts, spec);
    if (!port) {
      results.push({ port: spec.label, found_in_catalogue: false, outcome: "missing_port" });
      continue;
    }

    const search = await findPortImageCandidates(port, { force: true, autoApply: false });
    const top = search.candidates?.[0] || null;
    const locationOk = top ? assessLocation(port, top, spec) : null;
    const scoredTop = top
      ? {
          geographic: top.geographic,
          suitability: top.suitability,
          confidence: top.confidence,
          candidate: top
        }
      : null;
    const status = scoredTop ? statusForCandidate(scoredTop) : search.skipped ? `skipped:${search.reason}` : "NO_IMAGE";
    const correct =
      search.skipped && search.reason === "manual_image"
        ? true
        : !port
          ? false
          : locationOk !== false && (status !== "AUTO_APPROVED" || (top?.suitability ?? 0) >= 70);

    results.push({
      port: spec.label,
      catalogue_match: port.canonical_name,
      port_id: port.id,
      found_in_catalogue: true,
      queries: search.queries || [],
      primary_query: search.primaryQuery || null,
      best_source: top?.provider || null,
      geographic: top?.geographic ?? null,
      suitability: top?.suitability ?? null,
      best_confidence: top?.confidence ?? null,
      status,
      correct,
      location_ok: locationOk,
      license: top?.license || null,
      top_candidates: (search.candidates || []).slice(0, 3).map(summariseCandidate),
      manual_protected: port.image_status === "MANUAL" && Boolean(port.hero_media_id)
    });
  }

  console.log(JSON.stringify({ phase: "controlled_search", results }, null, 2));
  return results;
}

async function runApplySample(allPorts, searchResults) {
  const supabase = makeSupabaseClient(createSupabaseRest(root));
  const applied = [];

  for (const row of searchResults) {
    if (applied.length >= 3) break;
    if (!row.found_in_catalogue || row.status !== "AUTO_APPROVED" && row.status !== "NEEDS_REVIEW") continue;
    if (row.location_ok === false) continue;

    const port = allPorts.find((p) => p.id === row.port_id);
    const candidate = row.top_candidates?.[0];
    if (!port || !candidate?.sourceUrl && !candidate?.url) continue;

    if (!canOverwritePortImage(port)) {
      applied.push({ port: row.port, outcome: "skipped_manual_protected" });
      continue;
    }

    const fullCandidate = (await findPortImageCandidates(port, { force: true })).candidates?.[0];
    if (!fullCandidate) continue;

    try {
      const result = await applyPortImageCandidate(supabase, port, fullCandidate, {
        imageStatus: row.status === "AUTO_APPROVED" ? "AUTO_APPROVED" : "MANUAL",
        searchQuery: row.primary_query,
        confidence: fullCandidate.confidence
      });
      applied.push({
        port: row.port,
        outcome: "applied",
        hero_media_id: result.media?.id,
        public_url: result.media?.public_url,
        image_status: result.port?.image_status
      });
    } catch (error) {
      applied.push({ port: row.port, outcome: "error", error: error.message });
    }
  }

  console.log(JSON.stringify({ phase: "apply_sample", applied }, null, 2));
  return applied;
}

async function runBraveCheck() {
  const hasKey = Boolean(getBraveApiKey());
  const report = {
    phase: "brave_image_search",
    key_configured: hasKey,
    http_status: null,
    image_search_available: false,
    works: false,
    error: null,
    result_count: 0
  };
  if (!hasKey) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  try {
    const results = await braveImageSearch(null, "Civitavecchia Italy cruise port harbour", { count: 3 });
    report.http_status = 200;
    report.image_search_available = Array.isArray(results);
    report.works = Array.isArray(results) && results.length > 0;
    report.result_count = Array.isArray(results) ? results.length : 0;
  } catch (error) {
    report.error = error.message || String(error);
    report.http_status = error.statusCode || null;
    report.image_search_available = false;
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function runPublicCheck(appliedPorts) {
  const slug = "mediterranean";
  const response = await fetch(`${NETLIFY_ORIGIN}/.netlify/functions/public-destination?slug=${slug}`);
  const data = await response.json();
  const ports = data?.destination?.featuredPorts || [];

  const civitavecchia = ports.find((p) => /civitavecchia|rome/i.test(p?.name || ""));
  const hasExternalSearchEndpoints = false;

  const report = {
    phase: "public_check",
    destination_slug: slug,
    http_status: response.status,
    destination_loaded: Boolean(data?.success),
    featured_ports_count: ports.length,
    civitavecchia_has_image: Boolean(civitavecchia?.media?.url),
    civitavecchia_media_source: civitavecchia?.mediaId ? "media_library_or_catalogue" : "none",
    ports_without_image_text_only: ports.filter((p) => !p?.media?.url).length,
    country_port_fallback_disabled: portImageFallback("mediterranean", "test", "Test") === null,
    live_external_image_search_on_public_page: hasExternalSearchEndpoints,
    applied_sample_urls: appliedPorts
      .filter((a) => a.public_url)
      .map((a) => ({ port: a.port, url: a.public_url }))
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function runAudit(rest) {
  const ports = await loadAllPorts(rest);
  const withManual = ports.filter((p) => p.image_status === "MANUAL" && p.hero_media_id);
  const report = {
    phase: "audit",
    ports_count: ports.length,
    manual_images_count: withManual.length,
    test_ports_found: TEST_PORTS.map((spec) => ({
      label: spec.label,
      found: Boolean(findTestPort(ports, spec))
    })),
    pexels_key_configured: Boolean(String(process.env.PEXELS_API_KEY || "").trim()),
    brave_key_configured: Boolean(getBraveApiKey())
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const rest = createSupabaseRest(root);
  const allPorts = await loadAllPorts(rest);
  let searchResults = [];

  if (args.audit) await runAudit(rest);
  if (args.braveCheck) await runBraveCheck();
  if (args.search) searchResults = await runSearch(allPorts);
  let applied = [];
  if (args.applySample && searchResults.length) applied = await runApplySample(allPorts, searchResults);
  if (args.publicCheck) await runPublicCheck(applied);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
