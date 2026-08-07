#!/usr/bin/env node
/**
 * Controlled 10-port Port Image Finder batch test (production).
 *
 *   node scripts/batch-port-image-10-test.mjs --discover
 *   node scripts/batch-port-image-10-test.mjs --apply
 *   node scripts/batch-port-image-10-test.mjs --all
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
const { resolveCatalogueMediaIds } = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const BATCH_PORTS = [
  { label: "Sydney, NSW, Australia", match: /^sydney$/i, country: /australia/i, exclude: /nova scotia|canada|nsw canada/i },
  { label: "Singapore", match: /singapore/i, country: /singapore/i },
  { label: "Juneau, Alaska, USA", match: /juneau/i, country: /united states|usa|alaska/i },
  { label: "Ketchikan, Alaska, USA", match: /ketchikan/i, country: /united states|usa|alaska/i },
  { label: "Dubrovnik, Croatia", match: /dubrovnik/i, country: /croatia/i },
  { label: "Mykonos, Greece", match: /mykonos/i, country: /greece/i },
  { label: "Nouméa, New Caledonia", match: /noum[eé]a/i, country: /new caledonia/i },
  { label: "Tauranga, New Zealand", match: /tauranga/i, country: /new zealand/i },
  { label: "Port Vila, Vanuatu", match: /port vila/i, country: /vanuatu/i },
  { label: "Ísafjörður, Iceland", match: /isafjordur|ísafjörður/i, country: /iceland/i }
];

/** Editorial apply decisions: port label → candidate title substring or null to skip apply */
const EDITORIAL_APPLY = {
  "Sydney, NSW, Australia": { prefer: /circular quay|sydney harbour|sydney harbor|opera house|harbour bridge|harbor bridge|skyline.*sydney|sydney.*skyline/i, rejectTopIf: /cruise ship|celebrity|solstice|oasis|quantum|vessel/i },
  "Singapore": { prefer: /marina bay|singapore.*harbour|singapore.*harbor|waterfront|skyline.*singapore|singapore.*skyline|port of singapore/i, rejectTopIf: /cruise ship docked|celebrity|quantum/i },
  "Juneau, Alaska, USA": { prefer: /juneau.*harbour|juneau.*harbor|juneau.*waterfront|juneau.*skyline|downtown juneau|mountain/i, rejectTopIf: /cruise ship|celebrity|norwegian|princess/i },
  "Ketchikan, Alaska, USA": { prefer: /ketchikan.*harbour|ketchikan.*harbor|ketchikan.*waterfront|ketchikan.*creek|creek street|downtown ketchikan/i, rejectTopIf: /cruise ship|celebrity|norwegian/i },
  "Dubrovnik, Croatia": { prefer: /dubrovnik|old town|old city|city walls|harbour|harbor|coast|panorama/i, rejectTopIf: /cruise ship|celebrity|msc/i },
  "Mykonos, Greece": { prefer: /mykonos|windmill|chora|harbour|harbor|waterfront|cyclades/i, rejectTopIf: /cruise ship|celebrity/i },
  "Nouméa, New Caledonia": { prefer: /noum[eé]a|waterfront|harbour|harbor|port|city|skyline|anse/i, rejectTopIf: /cruise ship/i },
  "Tauranga, New Zealand": { prefer: /tauranga|mount maunganui|maunganui|harbour|harbor|waterfront|port/i, rejectTopIf: /cruise ship|celebrity/i },
  "Port Vila, Vanuatu": { prefer: /port vila|vila|vanuatu|harbour|harbor|waterfront|efate/i, rejectTopIf: /cruise ship|fiji|samoa|tonga(?!.*vanuatu)/i },
  "Ísafjörður, Iceland": { prefer: /isafjordur|ísafjörður|isafjörður harbour|isafjordur harbour/i, rejectTopIf: /cruise ship|^road \d+/i }
};

const apiStats = { wikimediaRequests: 0, wikimedia429: 0, wikimediaRetries: 0, wikimediaCacheHits: 0, braveRequests: 0, braveResults: 0 };

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
      if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`);
    }
  };
}

function findCataloguePort(allPorts, spec) {
  return allPorts.find((port) => {
    const hay = [port.canonical_name, port.display_name, port.city, port.country, port.region]
      .filter(Boolean)
      .join(" ");
    if (spec.exclude && spec.exclude.test(hay)) return false;
    const canonical = String(port.canonical_name || "").trim();
    const city = String(port.city || "").trim();
    const nameMatch = spec.match.test(canonical) || spec.match.test(city);
    return nameMatch && spec.country.test(hay);
  });
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

function editoriallyGood(row, spec) {
  if (!row) return false;
  const title = String(row.candidate?.title || "").toLowerCase();
  const editorial = EDITORIAL_APPLY[spec.label] || {};
  if (row.vesselPrimary) return false;
  if (editorial.rejectTopIf && editorial.rejectTopIf.test(title)) return false;
  if (row.geographic < 55) return false;
  if (row.suitability < 60) return false;
  if (row.status === "NO_IMAGE") return false;
  if (row.candidate?.provider === "brave" && !row.candidate?.license) return false;
  return true;
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
  return {
    spec,
    port,
    search,
    rows,
    pick,
    editoriallyGood: editoriallyGood(pick, spec)
  };
}

async function applyPick(rest, result) {
  const { port, pick, search, spec } = result;
  if (!pick || !canOverwritePortImage(port)) {
    return { applied: false, reason: !pick ? "no_suitable_candidate" : "protected_or_manual" };
  }
  if (!editoriallyGood(pick, spec)) {
    return { applied: false, reason: "editorial_reject", candidate: pick.candidate?.title };
  }

  await new Promise((r) => setTimeout(r, 2500));

  const imageStatus = pick.status === "AUTO_APPROVED" ? "AUTO_APPROVED" : "NEEDS_REVIEW";
  const supabase = makeSupabaseClient(rest);
  const applied = await applyPortImageCandidate(supabase, port, pick.candidate, {
    imageStatus,
    searchQuery: search.primaryQuery,
    confidence: pick.confidence
  });

  const reloaded = (
    await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(port.id)}&limit=1`)
  )[0];

  return {
    applied: true,
    imageStatus,
    mediaId: applied.media.id,
    publicUrl: applied.media.public_url,
    storagePath: applied.media.storage_path,
    port: reloaded
  };
}

async function main() {
  const args = parseArgs(process.argv);
  installApiInstrumentation();
  const rest = createSupabaseRest(root);
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&limit=2000`);

  const civitBefore = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];

  const discoveries = [];
  for (const spec of BATCH_PORTS) {
    const port = findCataloguePort(allPorts, spec);
    if (!port) {
      discoveries.push({ label: spec.label, found: false });
      continue;
    }
    if (port.image_status === "MANUAL" && port.hero_media_id) {
      discoveries.push({ label: spec.label, found: true, skipped: "manual_protected", port_id: port.id });
      continue;
    }
    discoveries.push({ label: spec.label, found: true, ...(await discoverPort(port, spec)) });
  }

  const summary = {
    phase: "discover",
    requested: BATCH_PORTS.length,
    found: discoveries.filter((d) => d.found).length,
    missing: discoveries.filter((d) => !d.found).map((d) => d.label),
    api_stats: apiStats,
    ports: discoveries.map((d) => {
      if (!d.found) return { label: d.label, found: false };
      if (d.skipped) return { label: d.label, skipped: d.skipped };
      const top = d.pick;
      return {
        label: d.label,
        catalogue: d.port?.canonical_name,
        port_id: d.port?.id,
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
              editoriallyGood: d.editoriallyGood
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

  const appliedUrls = applyResults.filter((r) => r.applied).map((r) => r.publicUrl);
  const duplicateUrls = appliedUrls.filter((u, i) => appliedUrls.indexOf(u) !== i);

  console.log(
    JSON.stringify(
      {
        phase: "apply",
        apply_results: applyResults,
        civitavecchia_unchanged:
          civitBefore?.hero_media_id === civitAfter?.hero_media_id && civitAfter?.image_status === "MANUAL",
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
