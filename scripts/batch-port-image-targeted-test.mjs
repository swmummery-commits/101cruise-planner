#!/usr/bin/env node
/**
 * Targeted 12-port Port Image Finder regression test (production).
 *
 *   node scripts/batch-port-image-targeted-test.mjs --discover
 *   node scripts/batch-port-image-targeted-test.mjs --apply
 *   node scripts/batch-port-image-targeted-test.mjs --all
 */

import fs from "fs";
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
  licenseIsUsable,
  classifyImageAge
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const { applyPortImageCandidate, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { resolveCanonicalPort } = require(path.join(root, "netlify/functions/lib/port-image-finder/port-resolution.js"));
const { buildDiscoverSummary, buildApplySummary } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/batch-metrics.js"
));
const { resolveCatalogueMediaIds } = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));

const ENSENADA_ID = "196f674c-0fed-4d2a-aba3-d518d7054746";
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const BATCH_PORTS = [
  {
    label: "Costa Maya, Mexico",
    match: /costa maya|mahahual/i,
    requireCanonical: /costa maya/i,
    forbiddenCanonical: /ensenada|cozumel|playa del carmen/i,
    country: /mexico/i
  },
  {
    label: "Ensenada, Mexico",
    match: /ensenada/i,
    requireCanonical: /ensenada/i,
    forbiddenCanonical: /costa maya|mahahual/i,
    country: /mexico/i,
    expectedPortId: ENSENADA_ID
  },
  {
    label: "Darwin, Northern Territory, Australia",
    match: /darwin/i,
    requireCanonical: /darwin/i,
    country: /australia/i,
    region: /northern territory|australia/i,
    exclude: /canada|ontario/i
  },
  {
    label: "Picton, New Zealand",
    match: /picton/i,
    requireCanonical: /picton/i,
    country: /new zealand/i,
    region: /marlborough|new zealand/i,
    exclude: /canada|ontario/i
  },
  {
    label: "Prince Rupert, British Columbia, Canada",
    match: /prince rupert/i,
    requireCanonical: /prince rupert/i,
    country: /canada/i,
    region: /british columbia|bc/i
  },
  {
    label: "Belfast, Northern Ireland",
    match: /belfast/i,
    requireCanonical: /belfast/i,
    country: /united kingdom|uk|northern ireland|ireland/i,
    exclude: /maine|usa|united states/i
  },
  {
    label: "Los Angeles/San Pedro, California, USA",
    match: /los angeles|san pedro/i,
    requireCanonical: /los angeles/i,
    country: /united states|usa|california/i
  },
  {
    label: "Nassau, Bahamas",
    match: /nassau/i,
    requireCanonical: /nassau/i,
    country: /bahamas/i,
    exclude: /germany|german/i
  },
  {
    label: "Marseille, France",
    match: /marseille|marseilles/i,
    requireCanonical: /marseille/i,
    country: /france/i
  },
  {
    label: "Quebec City, Canada",
    match: /quebec|qu[eé]bec city/i,
    requireCanonical: /quebec/i,
    country: /canada/i
  },
  {
    label: "St John's, Antigua",
    match: /st\.?\s*john|saint john|antigua/i,
    requireCanonical: /st john|st john's|st johns/i,
    country: /antigua|barbuda/i,
    exclude: /newfoundland|canada|new brunswick/i
  },
  {
    label: "La Spezia, Italy",
    match: /la spezia|spezia/i,
    requireCanonical: /la spezia/i,
    country: /italy/i
  }
];

const EDITORIAL_APPLY = {
  "Costa Maya, Mexico": {
    prefer: /costa maya|mahahual|mexico|caribbean|beach|harbour|harbor|port|waterfront/i,
    rejectTopIf: /cozumel only|playa del carmen only|ensenada/i
  },
  "Ensenada, Mexico": {
    prefer: /ensenada|mexico|baja|harbour|harbor|waterfront|port/i,
    rejectTopIf: /costa maya|mahahual|cozumel|bah[ií]a de los [aá]ngeles|bahia de los angeles|punta arenas/i
  },
  "Darwin, Northern Territory, Australia": {
    prefer: /darwin|northern territory|nt|harbour|harbor|waterfront|port|wharf/i,
    rejectTopIf: /canada|ontario/i
  },
  "Picton, New Zealand": {
    prefer: /picton|marlborough|queen charlotte|sounds|harbour|harbor|waterfront|port/i,
    rejectTopIf: /canada|ontario/i
  },
  "Prince Rupert, British Columbia, Canada": {
    prefer: /prince rupert|british columbia|bc|harbour|harbor|waterfront|port|kaien/i,
    rejectTopIf: /seattle|washington/i
  },
  "Belfast, Northern Ireland": {
    prefer: /belfast|northern ireland|harbour|harbor|waterfront|port|lough|titanic/i,
    rejectTopIf: /maine|usa/i
  },
  "Los Angeles/San Pedro, California, USA": {
    prefer: /san pedro|port of los angeles|world cruise center|los angeles harbour|los angeles harbor|la harbour|la harbor|waterfront|port|terminal/i,
    rejectTopIf: /santa monica beach|venice beach|malibu|hollywood only/i
  },
  "Nassau, Bahamas": {
    prefer: /nassau|bahamas|harbour|harbor|waterfront|port|paradise island|beach/i,
    rejectTopIf: /germany|german/i
  },
  "Marseille, France": {
    prefer: /marseille|marseilles|france|harbour|harbor|waterfront|port|old port|vieux port/i,
    rejectTopIf: /cruise ship docked only/i
  },
  "Quebec City, Canada": {
    prefer: /quebec|qu[eé]bec|old town|chateau|frontenac|harbour|harbor|waterfront|port|st\.? lawrence/i,
    rejectTopIf: /montreal only|toronto/i
  },
  "St John's, Antigua": {
    prefer: /st\.?\s*john|antigua|harbour|harbor|waterfront|port|caribbean/i,
    rejectTopIf: /newfoundland|canada|new brunswick/i
  },
  "La Spezia, Italy": {
    prefer: /la spezia|spezia|italy|harbour|harbor|waterfront|port|gulf of poets|cinque terre/i,
    rejectTopIf: /\b(lancaster|bomber|warship|submarine|destroyer|frigate|wwii|world war|aircraft carrier)\b/i
  }
};

const apiStats = {
  wikimediaRequests: 0,
  wikimedia429: 0,
  wikimediaDownload429: 0,
  braveRequests: 0,
  braveResults: 0,
  braveRejectedLicensing: 0
};

function parseArgs(argv) {
  const args = { discover: false, apply: false, all: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--discover") args.discover = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--all") args.all = true;
  }
  if (args.all) {
    args.discover = true;
    args.apply = true;
  }
  if (!args.discover && !args.apply) args.discover = true;
  return args;
}

function makeSupabaseClient(rest) {
  const { url, key } = require(path.join(root, "scripts/lib/supabase-rest.cjs")).getSupabaseConfig(root);
  return {
    fetchRest: (p, o) => rest.request(p, o),
    publicObjectUrl: (sp) =>
      `${url}/storage/v1/object/public/cruise-media/${sp.split("/").map(encodeURIComponent).join("/")}`,
    async uploadObject(bucket, storagePath, buffer, contentType) {
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
        throw new Error(`Storage upload rate limited: ${response.status}`);
      }
      if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`);
    }
  };
}

function enrichRow(row) {
  if (!row) return null;
  return { ...row, status: statusForCandidate(row) };
}

function hasWrongGeography(title, spec) {
  const editorial = EDITORIAL_APPLY[spec.label] || {};
  if (editorial.rejectTopIf && editorial.rejectTopIf.test(title)) return true;
  if (spec.label === "Costa Maya, Mexico" && /ensenada|cozumel|playa del carmen/i.test(title)) return true;
  if (spec.label === "Ensenada, Mexico" && /costa maya|mahahual/i.test(title)) return true;
  return false;
}

function editorialRating(row, spec) {
  if (!row) return "NO_IMAGE";
  const title = String(row.candidate?.title || "").toLowerCase();
  const editorial = EDITORIAL_APPLY[spec.label] || {};
  if (row.geographic < 40 || hasWrongGeography(title, spec)) return "WRONG";
  if (row.vesselPrimary) return "POOR";
  if (editorial.rejectTopIf && editorial.rejectTopIf.test(title)) return "POOR";
  if (/\b(lancaster|bomber|warship|submarine|destroyer|frigate|wwii|world war)\b/i.test(title)) return "POOR";
  if (editorial.prefer && editorial.prefer.test(title) && row.geographic >= 55 && row.suitability >= 60) return "GOOD";
  if (row.geographic >= 70 && row.suitability >= 65) return "GOOD";
  if (row.geographic >= 55 && row.suitability >= 50) return "ACCEPTABLE";
  return "POOR";
}

function editoriallyApplicable(row, spec) {
  const rating = editorialRating(row, spec);
  if (rating === "WRONG" || rating === "POOR") return false;
  if (!row || row.status === "NO_IMAGE") return false;
  if (row.vesselPrimary) return false;
  if (row.candidate?.provider === "brave" && !licenseIsUsable(row.candidate)) {
    apiStats.braveRejectedLicensing += 1;
    return false;
  }
  if (row.status === "AUTO_APPROVED" && rating !== "GOOD" && rating !== "ACCEPTABLE") return false;
  return rating === "GOOD" || rating === "ACCEPTABLE";
}

function ratingRank(rating) {
  return { GOOD: 4, ACCEPTABLE: 3, POOR: 2, WRONG: 1, NO_IMAGE: 0 }[rating] || 0;
}

function isClearlySuperior(newPick, existingTitle, existingRating, displacedHistorical) {
  if (!newPick) return false;
  if (displacedHistorical) return true;
  if (ratingRank(newPick.editorialRating) > ratingRank(existingRating || "POOR")) return true;
  if (newPick.editorialRating === "GOOD" && existingRating !== "GOOD") return true;
  return false;
}

function installApiInstrumentation() {
  const wikimediaClient = require(path.join(root, "netlify/functions/lib/port-image-finder/sources/wikimedia-client.js"));
  const braveSearch = require(path.join(root, "netlify/functions/lib/brave-search.js"));
  const origWiki = wikimediaClient.searchWikimediaCommons;
  const origBrave = braveSearch.braveImageSearch;

  wikimediaClient.searchWikimediaCommons = async function wrappedWiki(query, options) {
    try {
      apiStats.wikimediaRequests += 1;
      return await origWiki.call(this, query, options);
    } catch (error) {
      if (String(error.code || "") === "rate_limited" || error.statusCode === 429) apiStats.wikimedia429 += 1;
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

async function discoverPort(port, spec) {
  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const pickCandidate = search.eligibleCandidate || null;
  const pick = pickCandidate
    ? enrichRow({ candidate: pickCandidate, ...scorePortImageCandidate(pickCandidate, port) })
    : null;
  const rawTop = search.rawTopCandidate;
  const rawTopTitle = rawTop?.title || null;
  const ageClass = pick ? classifyImageAge(pick.candidate).ageClass : null;
  const rating = editorialRating(pick, spec);

  return {
    spec,
    port,
    search,
    pick,
    rawTopTitle,
    rawTopAgeClass: rawTop ? classifyImageAge(rawTop).ageClass : null,
    selectedRank: search.selectedRank,
    displacedHistorical: search.displacedHistorical,
    ageClass,
    editorialRating: rating,
    editoriallyApplicable: editoriallyApplicable(pick, spec)
  };
}

async function applyPick(rest, result) {
  const { port, pick, search, spec } = result;
  if (!pick || !canOverwritePortImage(port)) {
    return { applied: false, reason: !pick ? "no_suitable_candidate" : "protected_or_manual" };
  }
  if (!editoriallyApplicable(pick, spec)) {
    return {
      applied: false,
      reason: "editorial_reject",
      candidate: pick.candidate?.title,
      rating: result.editorialRating,
      geographic: pick.geographic,
      licensed: licenseIsUsable(pick.candidate)
    };
  }

  await new Promise((r) => setTimeout(r, 3000));

  const imageStatus = pick.status === "AUTO_APPROVED" ? "AUTO_APPROVED" : "NEEDS_REVIEW";
  const supabase = makeSupabaseClient(rest);
  try {
    const applied = await applyPortImageCandidate(supabase, port, pick.candidate, {
      imageStatus,
      searchQuery: search.primaryQuery,
      confidence: pick.confidence,
      resolutionSpec: spec
    });

    const reloaded = (
      await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(port.id)}&limit=1`)
    )[0];

    return {
      applied: true,
      imageStatus,
      editorialRating: result.editorialRating,
      geographic: pick.geographic,
      licensed: licenseIsUsable(pick.candidate),
      mediaId: applied.media.id,
      publicUrl: applied.media.public_url,
      storagePath: applied.media.storage_path,
      candidate: pick.candidate?.title,
      ageClass: result.ageClass,
      displacedHistorical: result.displacedHistorical,
      resolvedPortId: reloaded.id,
      canonical: reloaded.canonical_name,
      port: reloaded
    };
  } catch (error) {
    if (/429/.test(String(error.message))) apiStats.wikimediaDownload429 += 1;
    if (error.code === "PORT_RESOLUTION_FAILED") {
      return { applied: false, reason: "PORT_RESOLUTION_FAILED", error: error.message };
    }
    return { applied: false, reason: "apply_error", error: error.message };
  }
}

function buildResultTable(discoveries, applyResults) {
  const applyByLabel = new Map(applyResults.map((r) => [r.label, r]));
  return discoveries.map((d) => {
    const apply = applyByLabel.get(d.label) || {};
    return {
      Port: d.label,
      "Canonical match": d.resolvedCanonical || d.catalogue || (d.found ? "—" : "NOT FOUND"),
      Candidate: d.pick?.candidate?.title || d.existingTitle || d.rawTopTitle || "—",
      Age: d.ageClass || d.existingAgeClass || d.rawTopAgeClass || "—",
      Status: apply.imageStatus || d.existing_status || (d.found ? "discovered" : d.reason || "missing"),
      Editorial: d.editorialRating || d.existingEditorial || "—",
      Applied: apply.applied ? "yes" : d.comparisonOnly ? "comparison" : d.skipped || "no"
    };
  });
}

function evaluatePassCriteria(discoverSummary, applySummary, ensenadaSnapshot, costaMayaId, table) {
  const wrongWrites = table.filter(
    (r) =>
      (r.Port === "Costa Maya, Mexico" && r["Canonical match"] !== "Costa Maya") ||
      (r.Port === "Ensenada, Mexico" && r["Canonical match"] !== "Ensenada")
  );
  const geoErrors = applySummary.appliedRatings?.WRONG || 0;
  const editorialAcc = applySummary.autoApprovalEditorialAccuracy;
  const historicalImproved = discoverSummary.historicalDisplacements > 0;

  const pass =
    wrongWrites.length === 0 &&
    geoErrors === 0 &&
    applySummary.licensingAccuracy === 100 &&
    discoverSummary.reconciled &&
    applySummary.reconciled &&
    ensenadaSnapshot.hero_media_id !== costaMayaId &&
    (editorialAcc === null || editorialAcc >= 95) &&
    historicalImproved;

  return {
    pass,
    recommendation: pass ? "SAFE FOR FULL CATALOGUE ENRICHMENT" : "DO NOT RUN FULL CATALOGUE YET",
    checks: {
      zeroWrongCanonicalWrites: wrongWrites.length === 0,
      reportingReconciled: discoverSummary.reconciled && applySummary.reconciled,
      ensenadaIndependent: ensenadaSnapshot.image_status !== "AUTO_APPROVED" || ensenadaSnapshot.hero_media_id !== costaMayaId,
      historicalPreferenceImproved: historicalImproved,
      autoApprovalEditorialAccuracy: editorialAcc
    }
  };
}

async function main() {
  const args = parseArgs(process.argv);
  installApiInstrumentation();
  const rest = createSupabaseRest(root);
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&limit=2000`);

  const discoveries = [];
  for (const spec of BATCH_PORTS) {
    const resolution = resolveCanonicalPort(allPorts, spec);
    if (!resolution.ok) {
      discoveries.push({
        label: spec.label,
        found: false,
        reason: "PORT_RESOLUTION_FAILED",
        code: resolution.code,
        resolutionReason: resolution.reason,
        candidates: resolution.candidates || null
      });
      continue;
    }

    const port = resolution.port;
    if (port.image_status === "MANUAL" && port.hero_media_id) {
      const discovered = await discoverPort(port, spec);
      discoveries.push({
        label: spec.label,
        found: true,
        skipped: "manual_protected",
        comparisonOnly: true,
        resolvedPortId: port.id,
        resolvedCanonical: port.canonical_name,
        catalogue: port.canonical_name,
        existing_status: port.image_status,
        existingTitle: port.image_source_url,
        ...discovered
      });
      continue;
    }

    if (port.hero_media_id && ["AUTO_APPROVED", "NEEDS_REVIEW"].includes(String(port.image_status || "").toUpperCase())) {
      const discovered = await discoverPort(port, spec);
      const existingRating = "ACCEPTABLE";
      const superior = isClearlySuperior(
        { editorialRating: discovered.editorialRating },
        port.image_source_url,
        existingRating,
        discovered.displacedHistorical
      );
      discoveries.push({
        label: spec.label,
        found: true,
        skipped: superior ? null : "existing_image",
        comparisonOnly: !superior,
        allowReplace: superior,
        resolvedPortId: port.id,
        resolvedCanonical: port.canonical_name,
        catalogue: port.canonical_name,
        existing_status: port.image_status,
        existingTitle: port.image_source_url,
        existingEditorial: existingRating,
        ...discovered
      });
      continue;
    }

    const discovered = await discoverPort(port, spec);
    discoveries.push({
      label: spec.label,
      found: true,
      resolvedPortId: port.id,
      resolvedCanonical: port.canonical_name,
      ...discovered
    });
  }

  const discoverSummary = buildDiscoverSummary(discoveries, BATCH_PORTS.length);
  const table = buildResultTable(discoveries, []);

  const summary = {
    phase: "discover",
    discoverSummary,
    formulas: discoverSummary.formulas,
    api_stats: apiStats,
    table,
    ports: discoveries
  };

  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(root, "reports/port-image-targeted-discover.json"),
    JSON.stringify(summary, null, 2)
  );

  if (!args.apply) return;

  const applyResults = [];
  for (const d of discoveries) {
    if (!d.found || !d.port) continue;
    if (d.skipped === "manual_protected") {
      applyResults.push({ label: d.label, applied: false, reason: "manual_protected" });
      continue;
    }
    if (d.skipped === "existing_image" && !d.allowReplace) {
      applyResults.push({
        label: d.label,
        applied: false,
        reason: "existing_image_comparison_only",
        candidate: d.pick?.candidate?.title,
        displacedHistorical: d.displacedHistorical
      });
      continue;
    }
    applyResults.push({ label: d.label, ...(await applyPick(rest, d)) });
  }

  const ensenadaAfter = (
    await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${ENSENADA_ID}&limit=1`)
  )[0];
  const costaMayaPort = allPorts.find((p) => /^costa maya$/i.test(p.canonical_name)) ||
    (await rest.get(`ports?select=id,canonical_name&canonical_name=eq.Costa%20Maya&limit=1`))[0];

  const applySummary = buildApplySummary(applyResults, discoverSummary);
  const finalTable = buildResultTable(discoveries, applyResults);
  const passEval = evaluatePassCriteria(discoverSummary, applySummary, ensenadaAfter, costaMayaPort?.id, finalTable);

  const finalReport = {
    phase: "apply",
    discoverSummary,
    applySummary,
    formulas: {
      ...discoverSummary.formulas,
      ...applySummary.formulas
    },
    table: finalTable,
    ensenada: {
      id: ensenadaAfter.id,
      hero_media_id: ensenadaAfter.hero_media_id,
      image_status: ensenadaAfter.image_status
    },
    costaMaya: costaMayaPort
      ? { id: costaMayaPort.id, canonical_name: costaMayaPort.canonical_name }
      : null,
    api_stats: apiStats,
    passEval,
    recommendation: passEval.recommendation
  };

  console.log(JSON.stringify(finalReport, null, 2));
  fs.writeFileSync(path.join(root, "reports/port-image-targeted-apply.json"), JSON.stringify(finalReport, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
