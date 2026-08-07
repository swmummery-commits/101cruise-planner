#!/usr/bin/env node
/**
 * Controlled 25-port Port Image Finder batch test (production).
 *
 *   node scripts/batch-port-image-25-test.mjs --discover
 *   node scripts/batch-port-image-25-test.mjs --apply
 *   node scripts/batch-port-image-25-test.mjs --all
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
  isVesselPrimarySubject,
  licenseIsUsable
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const { applyPortImageCandidate, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { resolveCatalogueMediaIds } = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const TEN_PORT_IDS = [
  "sydney", "singapore", "juneau", "ketchikan", "dubrovnik", "mykonos", "noumea", "tauranga", "port vila", "isafjordur"
];
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

/** Canonical/alias-aware batch port specs */
const BATCH_PORTS = [
  { label: "Auckland, New Zealand", match: /auckland/i, country: /new zealand/i, exclude: /oakland/i },
  { label: "Wellington, New Zealand", match: /wellington/i, country: /new zealand/i, exclude: /florida|ontario|canada(?!.*columbia)/i },
  { label: "Hobart, Tasmania, Australia", match: /hobart/i, country: /australia/i },
  { label: "Melbourne, Victoria, Australia", match: /melbourne/i, country: /australia/i, exclude: /florida|usa|united states/i },
  { label: "Fremantle, Western Australia", match: /fremantle/i, country: /australia/i, note: "avoid generic Perth unless Fremantle-relevant" },
  { label: "Bali / Benoa, Indonesia", match: /benoa|bali/i, country: /indonesia|bali/i, aliases: ["Benoa", "Bali"] },
  { label: "Ho Chi Minh City / Phu My, Vietnam", match: /phu my|ho chi minh|saigon/i, country: /vietnam/i, aliases: ["Phu My", "Ho Chi Minh City", "Saigon"] },
  { label: "Bangkok / Laem Chabang, Thailand", match: /laem chabang|bangkok/i, country: /thailand/i, aliases: ["Laem Chabang", "Bangkok"] },
  { label: "Hong Kong", match: /hong kong/i, country: /hong kong|china/i },
  { label: "Busan, South Korea", match: /busan|pusan/i, country: /korea|south korea/i },
  { label: "Nagasaki, Japan", match: /nagasaki/i, country: /japan/i },
  { label: "Kagoshima, Japan", match: /kagoshima/i, country: /japan/i },
  { label: "Skagway, Alaska, USA", match: /skagway/i, country: /united states|usa|alaska/i },
  { label: "Sitka, Alaska, USA", match: /sitka/i, country: /united states|usa|alaska/i },
  { label: "Vancouver, British Columbia, Canada", match: /vancouver/i, country: /canada/i, exclude: /washington|usa|united states/i },
  { label: "Victoria, British Columbia, Canada", match: /victoria/i, country: /canada/i, region: /british columbia|bc/i, exclude: /australia|seychelles|texas|malta/i },
  { label: "Cozumel, Mexico", match: /cozumel/i, country: /mexico/i },
  { label: "George Town, Grand Cayman", match: /george town|grand cayman|cayman/i, country: /cayman|united kingdom|uk/i },
  { label: "Philipsburg, Sint Maarten", match: /philipsburg|sint maarten|st\.? maarten/i, country: /maarten|sint maarten|netherlands/i },
  { label: "St Thomas, US Virgin Islands", match: /st\.?\s*thomas|saint thomas|charlotte amalie/i, country: /virgin islands|united states|usa/i },
  { label: "Santorini, Greece", match: /santorini|thira|fira|oia/i, country: /greece/i },
  { label: "Naples, Italy", match: /^naples$|napoli/i, country: /italy/i, exclude: /florida|usa|united states|idaho/i },
  { label: "La Spezia, Italy", match: /la spezia|spezia/i, country: /italy/i, exclude: /naples|napoli/i },
  { label: "Kotor, Montenegro", match: /kotor/i, country: /montenegro/i },
  { label: "Geiranger, Norway", match: /geiranger/i, country: /norway/i }
];

const EDITORIAL_APPLY = {
  "Auckland, New Zealand": { prefer: /auckland|harbour|harbor|waterfront|skyline|waitemata|port/i, rejectTopIf: /cruise ship|celebrity|norwegian/i },
  "Wellington, New Zealand": { prefer: /wellington|harbour|harbor|waterfront|skyline|port/i, rejectTopIf: /cruise ship|florida|ontario/i },
  "Hobart, Tasmania, Australia": { prefer: /hobart|tasmania|waterfront|harbour|harbor|port|mount wellington/i, rejectTopIf: /cruise ship|celebrity/i },
  "Melbourne, Victoria, Australia": { prefer: /victoria harbour.*melbourne|docklands.*melbourne|melbourne.*harbour|melbourne.*harbor|melbourne.*waterfront|port melbourne/i, rejectTopIf: /cruise ship|florida|usa(?!.*australia)|st kilda beach/i },
  "Fremantle, Western Australia": { prefer: /fremantle|harbour|harbor|waterfront|port|roundhouse/i, rejectTopIf: /^perth\b|perth skyline|perth city(?!.*fremantle)/i },
  "Bali / Benoa, Indonesia": { prefer: /benoa|bali|denpasar|harbour|harbor|port|waterfront|temple|coast/i, rejectTopIf: /resort pool|generic resort|bali resort only/i },
  "Ho Chi Minh City / Phu My, Vietnam": { prefer: /ho chi minh|saigon|phu my|vietnam|waterfront|skyline|river|port/i, rejectTopIf: /hanoi only|halong only/i },
  "Bangkok / Laem Chabang, Thailand": { prefer: /bangkok|laem chabang|chao phraya|thailand|waterfront|skyline|port/i, rejectTopIf: /phuket only|chiang mai/i },
  "Hong Kong": { prefer: /hong kong|victoria harbour|victoria harbor|skyline|waterfront|port/i, rejectTopIf: /cruise ship docked|celebrity/i },
  "Busan, South Korea": { prefer: /busan|pusan|harbour|harbor|waterfront|port|skyline/i, rejectTopIf: /seoul only|incheon only/i },
  "Nagasaki, Japan": { prefer: /nagasaki|harbour|harbor|waterfront|port|peace park|mount/i, rejectTopIf: /cruise ship|tokyo|osaka/i },
  "Kagoshima, Japan": { prefer: /kagoshima|sakurajima|harbour|harbor|waterfront|port/i, rejectTopIf: /cruise ship|tokyo|osaka/i },
  "Skagway, Alaska, USA": { prefer: /skagway|harbour|harbor|waterfront|port|alaska|mountain/i, rejectTopIf: /cruise ship|celebrity/i },
  "Sitka, Alaska, USA": { prefer: /sitka|harbour|harbor|waterfront|port|alaska|baranof/i, rejectTopIf: /cruise ship|celebrity/i },
  "Vancouver, British Columbia, Canada": { prefer: /vancouver|british columbia|harbour|harbor|waterfront|port|skyline|stanley/i, rejectTopIf: /washington|usa(?!.*alaska)|seattle/i },
  "Victoria, British Columbia, Canada": { prefer: /victoria.*british columbia|victoria bc|inner harbour|inner harbor|waterfront|port/i, rejectTopIf: /australia|seychelles|malta|texas/i },
  "Cozumel, Mexico": { prefer: /cozumel|caribbean|waterfront|harbour|harbor|port|beach/i, rejectTopIf: /cruise ship docked|celebrity/i },
  "George Town, Grand Cayman": { prefer: /george town|grand cayman|cayman|harbour|harbor|waterfront|port/i, rejectTopIf: /penang|malaysia|scotland/i },
  "Philipsburg, Sint Maarten": { prefer: /philipsburg|sint maarten|st\.? maarten|harbour|harbor|waterfront|port|beach/i, rejectTopIf: /st\.? thomas|usvi/i },
  "St Thomas, US Virgin Islands": { prefer: /st\.?\s*thomas|saint thomas|charlotte amalie|usvi|virgin islands|harbour|harbor|waterfront|port/i, rejectTopIf: /sint maarten|philipsburg/i },
  "Santorini, Greece": { prefer: /santorini|thira|fira|oia|caldera|cyclades|harbour|harbor|waterfront/i, rejectTopIf: /cruise ship only|mykonos only|athens only/i },
  "Naples, Italy": { prefer: /naples|napoli|italy|harbour|harbor|waterfront|port|vesuvius|bay/i, rejectTopIf: /florida|usa|la spezia|spezia|cruise ship docked/i },
  "La Spezia, Italy": { prefer: /la spezia|spezia|italy|harbour|harbor|waterfront|port|gulf/i, rejectTopIf: /naples|napoli|cruise ship docked|lancaster|bomber|warship|wwii|world war|avro/i },
  "Kotor, Montenegro": { prefer: /kotor|montenegro|bay|harbour|harbor|waterfront|old town|fjord/i, rejectTopIf: /cruise ship docked|dubrovnik only/i },
  "Geiranger, Norway": { prefer: /geiranger|fjord|norway|waterfall|village|harbour|harbor|port/i, rejectTopIf: /cruise ship docked|oslo|bergen only/i }
};

const apiStats = {
  wikimediaRequests: 0,
  wikimedia429: 0,
  wikimediaDownload429: 0,
  wikimediaRetries: 0,
  wikimediaCacheHits: 0,
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

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function portHaystack(port) {
  return [port.canonical_name, port.display_name, port.city, port.country, port.region, ...(port.aliases || [])]
    .filter(Boolean)
    .join(" ");
}

function findCataloguePort(allPorts, spec) {
  const candidates = allPorts.filter((port) => {
    const hay = portHaystack(port);
    if (spec.exclude && spec.exclude.test(hay)) return false;
    if (spec.region && !spec.region.test(String(port.region || ""))) return false;
    if (!spec.country.test(hay)) return false;

    const names = [
      port.canonical_name,
      port.display_name,
      port.city,
      ...(Array.isArray(port.aliases) ? port.aliases : []),
      ...(spec.aliases || [])
    ]
      .filter(Boolean)
      .map(normalizeKey);

    const matchKeys = names.filter((n) => spec.match.test(n) || spec.match.test(n.replace(/\s+/g, " ")));
    if (matchKeys.length === 0) {
      const canonical = normalizeKey(port.canonical_name);
      const city = normalizeKey(port.city);
      if (!(spec.match.test(canonical) || spec.match.test(city))) return false;
    }
    return true;
  });

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return (
      candidates.find((p) => spec.match.test(normalizeKey(p.canonical_name))) ||
      candidates.find((p) => spec.match.test(normalizeKey(p.city))) ||
      candidates[0]
    );
  }
  return null;
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

function scoreRow(candidate, port) {
  const scored = scorePortImageCandidate(candidate, port);
  const vessel = isVesselPrimarySubject(candidate);
  return {
    candidate,
    ...scored,
    vesselPrimary: vessel.vesselPrimary,
    vesselReason: vessel.reason,
    status: statusForCandidate({ ...scored, candidate })
  };
}

function pickEditorialCandidate(rows, port, spec) {
  const editorial = EDITORIAL_APPLY[spec.label] || {};
  const ranked = rows.filter((r) => !r.rejected);

  if (editorial.prefer) {
    const preferred = ranked.find((r) => editorial.prefer.test(String(r.candidate?.title || "")));
    if (preferred && preferred.status !== "NO_IMAGE") return preferred;
  }

  const top = ranked[0] || null;
  if (!top) return null;
  if (editorial.rejectTopIf && editorial.rejectTopIf.test(String(top.candidate?.title || ""))) {
    const alt = ranked.find(
      (r, i) => i > 0 && !editorial.rejectTopIf.test(String(r.candidate?.title || "")) && r.status !== "NO_IMAGE"
    );
    return alt || null;
  }
  if (top.vesselPrimary) {
    const alt = ranked.find((r, i) => i > 0 && !r.vesselPrimary && r.status !== "NO_IMAGE");
    return alt || null;
  }
  return top.status === "NO_IMAGE" ? null : top;
}

function editorialRating(row, spec) {
  if (!row) return "NO_IMAGE";
  const title = String(row.candidate?.title || "").toLowerCase();
  const editorial = EDITORIAL_APPLY[spec.label] || {};
  if (row.geographic < 40 || hasWrongGeography(title, spec)) return "WRONG";
  if (row.vesselPrimary) return "POOR";
  if (editorial.rejectTopIf && editorial.rejectTopIf.test(title)) return "POOR";
  if (/\b(lancaster|bomber|warship|submarine|destroyer|frigate|wwii|world war)\b/i.test(title)) return "POOR";
  if (row.geographic >= 75 && row.suitability >= 75 && !row.vesselPrimary) return "GOOD";
  if (row.geographic >= 55 && row.suitability >= 60) return "ACCEPTABLE";
  return "POOR";
}

function hasWrongGeography(title, spec) {
  const wrongPatterns = {
    "Victoria, British Columbia, Canada": /australia|seychelles|malta|texas/i,
    "Vancouver, British Columbia, Canada": /seattle|washington state/i,
    "Naples, Italy": /florida|naples fl/i,
    "George Town, Grand Cayman": /penang|malaysia/i,
    "St Thomas, US Virgin Islands": /sint maarten|philipsburg/i,
    "Philipsburg, Sint Maarten": /st\.?\s*thomas|charlotte amalie/i
  };
  const pattern = wrongPatterns[spec.label];
  return pattern ? pattern.test(title) : false;
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
  const rows = (search.candidates || []).map((c) => scoreRow(c, port));
  const pick = pickEditorialCandidate(rows, port, spec);
  const rating = editorialRating(pick, spec);
  return {
    spec,
    port,
    search,
    rows,
    pick,
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
    return { applied: false, reason: "editorial_reject", candidate: pick.candidate?.title, rating: result.editorialRating };
  }

  await new Promise((r) => setTimeout(r, 3000));

  const imageStatus = pick.status === "AUTO_APPROVED" ? "AUTO_APPROVED" : "NEEDS_REVIEW";
  const supabase = makeSupabaseClient(rest);
  try {
    const applied = await applyPortImageCandidate(supabase, port, pick.candidate, {
      imageStatus,
      searchQuery: search.primaryQuery,
      confidence: pick.confidence
    });

    const reloaded = (
      await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(port.id)}&limit=1`)
    )[0];

    const publicMap = await resolveCatalogueMediaIds(
      (p) => rest.get(p.replace(/^\//, "")),
      [reloaded.canonical_name, reloaded.city].filter(Boolean)
    );
    const isPublic = publicMap.has(reloaded.canonical_name?.toLowerCase()) || publicMap.size > 0;

    return {
      applied: true,
      imageStatus,
      editorialRating: result.editorialRating,
      mediaId: applied.media.id,
      publicUrl: applied.media.public_url,
      storagePath: applied.media.storage_path,
      publicEligible: imageStatus === "AUTO_APPROVED" || imageStatus === "MANUAL",
      publiclyResolved: imageStatus === "AUTO_APPROVED" ? isPublic : false,
      port: reloaded
    };
  } catch (error) {
    if (/429/.test(String(error.message))) apiStats.wikimediaDownload429 += 1;
    return { applied: false, reason: "apply_error", error: error.message };
  }
}

async function verifyTenPortIntact(rest) {
  const all = await rest.get(`ports?select=id,canonical_name,hero_media_id,image_status&limit=2000`);
  return all
    .filter((p) => TEN_PORT_IDS.some((needle) => normalizeKey(p.canonical_name).includes(needle.replace(/\s+/g, " "))))
    .map((p) => ({ canonical_name: p.canonical_name, hero_media_id: p.hero_media_id, image_status: p.image_status }));
}

async function main() {
  const args = parseArgs(process.argv);
  installApiInstrumentation();
  const rest = createSupabaseRest(root);
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&limit=2000`);

  const civitBefore = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];
  const tenPortBefore = await verifyTenPortIntact(rest);

  const discoveries = [];
  for (const spec of BATCH_PORTS) {
    const port = findCataloguePort(allPorts, spec);
    if (!port) {
      discoveries.push({ label: spec.label, found: false });
      continue;
    }
    if (port.image_status === "MANUAL" && port.hero_media_id) {
      discoveries.push({ label: spec.label, found: true, skipped: "manual_protected", port_id: port.id, catalogue: port.canonical_name });
      continue;
    }
    if (port.hero_media_id && ["AUTO_APPROVED", "NEEDS_REVIEW"].includes(String(port.image_status || "").toUpperCase())) {
      discoveries.push({
        label: spec.label,
        found: true,
        skipped: "existing_image",
        port_id: port.id,
        catalogue: port.canonical_name,
        existing_status: port.image_status
      });
      continue;
    }
    discoveries.push({ label: spec.label, found: true, ...(await discoverPort(port, spec)) });
  }

  const ratings = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, WRONG: 0, NO_IMAGE: 0 };
  for (const d of discoveries) {
    if (d.editorialRating) ratings[d.editorialRating] = (ratings[d.editorialRating] || 0) + 1;
    else if (!d.found || d.skipped) continue;
    else ratings.NO_IMAGE += 1;
  }

  const summary = {
    phase: "discover",
    requested: BATCH_PORTS.length,
    found: discoveries.filter((d) => d.found).length,
    missing: discoveries.filter((d) => !d.found).map((d) => d.label),
    ratings,
    api_stats: apiStats,
    ports: discoveries.map((d) => {
      if (!d.found) return { label: d.label, found: false };
      if (d.skipped) return { label: d.label, skipped: d.skipped, catalogue: d.catalogue, existing_status: d.existing_status };
      const top = d.pick;
      return {
        label: d.label,
        catalogue: d.port?.canonical_name,
        port_id: d.port?.id,
        note: d.spec?.note || null,
        queries: d.search?.queries,
        top_candidates: d.rows.slice(0, 3).map((r) => ({
          title: r.candidate?.title,
          provider: r.candidate?.provider,
          license: r.candidate?.license,
          geographic: r.geographic,
          suitability: r.suitability,
          confidence: r.confidence,
          vesselPrimary: r.vesselPrimary,
          status: r.status
        })),
        selected: top
          ? {
              title: top.candidate?.title,
              provider: top.candidate?.provider,
              license: top.candidate?.license,
              geographic: top.geographic,
              suitability: top.suitability,
              confidence: top.confidence,
              vesselPrimary: top.vesselPrimary,
              status: top.status,
              editorialRating: d.editorialRating,
              editoriallyApplicable: d.editoriallyApplicable
            }
          : null
      };
    })
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) return;

  const applyResults = [];
  for (const d of discoveries) {
    if (!d.found || d.skipped || !d.port) continue;
    applyResults.push({ label: d.label, ...(await applyPick(rest, d)) });
  }

  const civitAfter = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];
  const tenPortAfter = await verifyTenPortIntact(rest);

  const appliedUrls = applyResults.filter((r) => r.applied).map((r) => r.publicUrl);
  const duplicateUrls = appliedUrls.filter((u, i) => appliedUrls.indexOf(u) !== i);

  console.log(
    JSON.stringify(
      {
        phase: "apply",
        apply_results: applyResults,
        civitavecchia_unchanged:
          civitBefore?.hero_media_id === civitAfter?.hero_media_id && civitAfter?.image_status === "MANUAL",
        ten_port_intact: JSON.stringify(tenPortBefore) === JSON.stringify(tenPortAfter),
        ten_port_before: tenPortBefore,
        ten_port_after: tenPortAfter,
        duplicate_public_urls: [...new Set(duplicateUrls)],
        api_stats: apiStats
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
