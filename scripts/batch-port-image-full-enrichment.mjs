#!/usr/bin/env node
/**
 * Full missing-port enrichment (production).
 *
 *   node scripts/batch-port-image-full-enrichment.mjs --dry-run
 *   node scripts/batch-port-image-full-enrichment.mjs --run
 *   node scripts/batch-port-image-full-enrichment.mjs --run --resume
 *
 * Processes eligible ports only. Never touches MANUAL or AUTO_APPROVED.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates, RECHECK_DAYS } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/search.js"
));
const {
  applyPortImageCandidate,
  canOverwritePortImage
} = require(path.join(root, "netlify/functions/lib/port-image-finder/apply.js"));
const { validatePortIdentity } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/port-resolution.js"
));
const { licenseIsUsable, scorePortImageCandidate, statusForCandidate } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/scoring.js"
));
const { editorialRating } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/public-image-audit.js"
));

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const CHECKPOINT_PATH = path.join(root, "reports/port-image-full-enrichment-checkpoint.json");
const REPORT_PATH = path.join(root, "reports/port-image-full-enrichment.json");

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";

const apiStats = {
  wikimediaSearch429: 0,
  wikimediaDownload429: 0,
  wikimediaDownloads: 0,
  braveRequests: 0,
  braveResults: 0,
  retries: 0
};

function parseArgs() {
  return {
    dryRun: process.argv.includes("--dry-run") || !process.argv.includes("--run"),
    resume: process.argv.includes("--resume"),
    force: process.argv.includes("--force") || process.argv.includes("--run")
  };
}

function portResolutionSpec(port) {
  return {
    label: `${port.canonical_name}, ${port.country}`,
    requireCanonical: new RegExp(String(port.canonical_name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    country: new RegExp(String(port.country || ""), "i"),
    expectedPortId: port.id
  };
}

function isEligible(port, { force = false } = {}) {
  const status = String(port.image_status || "").toUpperCase();
  if (status === "MANUAL" && port.hero_media_id) return false;
  if (status === "AUTO_APPROVED" && port.hero_media_id) return false;
  if (status === "NEEDS_REVIEW" && port.hero_media_id) return false;
  if (!force && port.image_last_checked_at) {
    const age = Date.now() - Date.parse(port.image_last_checked_at);
    if (age < RECHECK_DAYS * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return { completedPortIds: [], results: [], summary: null };
  return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
}

function saveCheckpoint(state) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2));
}

function makeSupabaseClient(rest) {
  const { url, key } = require(path.join(root, "scripts/lib/supabase-rest.cjs")).getSupabaseConfig(root);
  return {
    fetchRest: (p, o) => rest.request(p, o),
    publicObjectUrl: (sp) =>
      `${url}/storage/v1/object/public/cruise-media/${sp.split("/").map(encodeURIComponent).join("/")}`,
    async uploadObject(bucket, storagePath, buffer, contentType) {
      apiStats.wikimediaDownloads += 1;
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
      if (response.status === 429) {
        apiStats.wikimediaDownload429 += 1;
        throw new Error("Storage upload rate limited: 429");
      }
      if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`);
    }
  };
}

function installApiInstrumentation() {
  const wikimediaClient = require(path.join(root, "netlify/functions/lib/port-image-finder/sources/wikimedia-client.js"));
  const braveSearch = require(path.join(root, "netlify/functions/lib/brave-search.js"));
  const origWiki = wikimediaClient.searchWikimediaCommons;
  const origBrave = braveSearch.braveImageSearch;
  wikimediaClient.searchWikimediaCommons = async function wrappedWiki(query, options) {
    try {
      return await origWiki.call(this, query, options);
    } catch (error) {
      if (String(error.code || "") === "rate_limited" || error.statusCode === 429) apiStats.wikimediaSearch429 += 1;
      throw error;
    }
  };
  braveSearch.braveImageSearch = async function wrappedBrave(key, query, options) {
    apiStats.braveRequests += 1;
    const results = await origBrave.call(this, key, query, options);
    apiStats.braveResults += Array.isArray(results) ? results.length : 0;
    return results;
  };
}

async function countByStatus(rest) {
  const rows = await rest.get(`ports?select=id,image_status,hero_media_id&limit=2000`);
  const counts = { total: rows.length, AUTO_APPROVED: 0, MANUAL: 0, NEEDS_REVIEW: 0, NO_IMAGE: 0, other: 0 };
  for (const row of rows) {
    const status = String(row.image_status || "").toUpperCase();
    if (status === "AUTO_APPROVED" && row.hero_media_id) counts.AUTO_APPROVED += 1;
    else if (status === "MANUAL" && row.hero_media_id) counts.MANUAL += 1;
    else if (status === "NEEDS_REVIEW" && row.hero_media_id) counts.NEEDS_REVIEW += 1;
    else if (status === "NO_IMAGE" || !row.hero_media_id) counts.NO_IMAGE += 1;
    else counts.other += 1;
  }
  return counts;
}

async function processPort(rest, supabase, port, { dryRun }) {
  const spec = portResolutionSpec(port);
  const validation = validatePortIdentity(port, spec);
  if (!validation.ok) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "PORT_RESOLUTION_FAILED",
      reason: validation.reason
    };
  }

  if (!canOverwritePortImage(port)) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "skipped_protected",
      reason: port.image_status
    };
  }

  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  if (search.skipped) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "skipped",
      reason: search.reason
    };
  }

  const eligible = search.eligibleCandidate;
  if (!eligible) {
    if (!dryRun) {
      await rest.request(`ports?id=eq.${encodeURIComponent(port.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          image_status: "NO_IMAGE",
          image_candidates: search.candidates || [],
          image_search_query: search.primaryQuery || null,
          image_confidence: search.bestConfidence || null,
          image_last_checked_at: new Date().toISOString()
        }
      });
    }
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "NO_IMAGE",
      candidate: search.rawTopCandidate?.title || null
    };
  }

  const scored = { candidate: eligible, ...scorePortImageCandidate(eligible, port) };
  const editorial = editorialRating(scored, port, eligible);
  const licensed = licenseIsUsable(eligible);
  const status = statusForCandidate(scored);

  if (!licensed) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "licensing_rejection",
      candidate: eligible.title
    };
  }

  if (scored.vesselPrimary) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "vessel_primary_rejection",
      candidate: eligible.title
    };
  }

  if (dryRun) {
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: status === "AUTO_APPROVED" ? "would_auto_approve" : "would_needs_review",
      candidate: eligible.title,
      editorial,
      geographic: scored.geographic,
      suitability: scored.suitability
    };
  }

  await new Promise((r) => setTimeout(r, 3000));

  if (status === "AUTO_APPROVED" && (editorial === "GOOD" || editorial === "ACCEPTABLE")) {
    const applied = await applyPortImageCandidate(supabase, port, eligible, {
      imageStatus: "AUTO_APPROVED",
      searchQuery: search.primaryQuery,
      confidence: scored.confidence,
      resolutionSpec: spec
    });
    if (applied.port.id !== port.id) {
      throw new Error(`SYSTEMIC: image written to wrong port ${applied.port.id} expected ${port.id}`);
    }
    return {
      port_id: port.id,
      canonical_name: port.canonical_name,
      outcome: "AUTO_APPROVED",
      candidate: eligible.title,
      editorial,
      media_id: applied.media.id,
      resolved_port_id: applied.port.id
    };
  }

  const applied = await applyPortImageCandidate(supabase, port, eligible, {
    imageStatus: "NEEDS_REVIEW",
    searchQuery: search.primaryQuery,
    confidence: scored.confidence,
    resolutionSpec: spec
  });
  if (applied.port.id !== port.id) {
    throw new Error(`SYSTEMIC: image written to wrong port ${applied.port.id} expected ${port.id}`);
  }
  return {
    port_id: port.id,
    canonical_name: port.canonical_name,
    outcome: "NEEDS_REVIEW",
    candidate: eligible.title,
    editorial,
    media_id: applied.media.id,
    note: "stored_non_public"
  };
}

async function main() {
  const args = parseArgs();
  installApiInstrumentation();
  const rest = createSupabaseRest(root);
  const supabase = makeSupabaseClient(rest);

  const starting = await countByStatus(rest);
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc&limit=2000`);
  const eligible = allPorts.filter((p) => isEligible(p, { force: args.force }));

  const checkpoint = args.resume ? loadCheckpoint() : { completedPortIds: [], results: [], startedAt: new Date().toISOString() };
  const completed = new Set(checkpoint.completedPortIds || []);
  const civitBefore = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];

  const summary = checkpoint.summary || {
    attempted: 0,
    resolution_successes: 0,
    resolution_failures: 0,
    auto_approved_added: 0,
    needs_review_added: 0,
    no_image: 0,
    skipped_protected: 0,
    skipped: 0,
    licensing_rejections: 0,
    vessel_primary_rejections: 0,
    errors: 0,
    systemic_failures: 0
  };

  const results = checkpoint.results || [];

  for (const port of eligible) {
    if (completed.has(port.id)) continue;
    try {
      const result = await processPort(rest, supabase, port, { dryRun: args.dryRun });
      results.push(result);
      summary.attempted += 1;
      if (result.outcome === "PORT_RESOLUTION_FAILED") summary.resolution_failures += 1;
      else summary.resolution_successes += 1;
      if (result.outcome === "AUTO_APPROVED" || result.outcome === "would_auto_approve") summary.auto_approved_added += 1;
      if (result.outcome === "NEEDS_REVIEW" || result.outcome === "would_needs_review") summary.needs_review_added += 1;
      if (result.outcome === "NO_IMAGE") summary.no_image += 1;
      if (result.outcome === "skipped_protected") summary.skipped_protected += 1;
      if (result.outcome === "skipped") summary.skipped += 1;
      if (result.outcome === "licensing_rejection") summary.licensing_rejections += 1;
      if (result.outcome === "vessel_primary_rejection") summary.vessel_primary_rejections += 1;

      completed.add(port.id);
      checkpoint.completedPortIds = [...completed];
      checkpoint.results = results;
      checkpoint.summary = summary;
      checkpoint.lastPort = port.canonical_name;
      checkpoint.updatedAt = new Date().toISOString();
      if (!args.dryRun) saveCheckpoint(checkpoint);
    } catch (error) {
      if (/SYSTEMIC/.test(error.message)) {
        summary.systemic_failures += 1;
        saveCheckpoint({ ...checkpoint, results, summary, fatal: error.message });
        throw error;
      }
      if (/429/.test(error.message)) {
        apiStats.retries += 1;
        results.push({
          port_id: port.id,
          canonical_name: port.canonical_name,
          outcome: "RATE_LIMITED",
          error: error.message
        });
        summary.errors += 1;
        saveCheckpoint({ ...checkpoint, results, summary });
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      summary.errors += 1;
      results.push({
        port_id: port.id,
        canonical_name: port.canonical_name,
        outcome: "error",
        error: error.message
      });
      completed.add(port.id);
      checkpoint.completedPortIds = [...completed];
      checkpoint.results = results;
      checkpoint.summary = summary;
      if (!args.dryRun) saveCheckpoint(checkpoint);
    }
  }

  const ending = args.dryRun ? starting : await countByStatus(rest);
  const civitAfter = args.dryRun
    ? civitBefore
    : (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];

  const report = {
    mode: args.dryRun ? "dry-run" : "run",
    starting,
    eligible_count: eligible.length,
    processed_count: results.length,
    summary,
    api_stats: apiStats,
    ending,
    protection: {
      civitavecchia_unchanged:
        civitBefore?.hero_media_id === civitAfter?.hero_media_id && civitAfter?.image_status === "MANUAL"
    },
    results
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: report.summary, starting, ending, eligible: eligible.length, mode: report.mode }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
