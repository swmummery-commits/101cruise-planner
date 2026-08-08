#!/usr/bin/env node
/**
 * Controlled 50-port Port Image Finder batch test (production).
 *
 *   node scripts/batch-port-image-50-test.mjs --discover
 *   node scripts/batch-port-image-50-test.mjs --apply
 *   node scripts/batch-port-image-50-test.mjs --all
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
  licenseIsUsable,
  classifyImageAge
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const { applyPortImageCandidate, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { resolveCatalogueMediaIds } = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));
const { resolveCanonicalPort } = require(path.join(root, "netlify/functions/lib/port-image-finder/port-resolution.js"));
const { buildDiscoverSummary, buildApplySummary } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/batch-metrics.js"
));

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const TEN_PORT_IDS = [
  "sydney", "singapore", "juneau", "ketchikan", "dubrovnik", "mykonos", "noumea", "tauranga", "port vila", "isafjordur"
];
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

/** Canonical/alias-aware batch port specs */
const BATCH_PORTS = [
  // AU / NZ / Pacific
  { label: "Brisbane, Australia", match: /brisbane/i, country: /australia/i },
  { label: "Cairns, Australia", match: /cairns/i, country: /australia/i },
  { label: "Darwin, Australia", match: /darwin/i, country: /australia/i, exclude: /canada|ontario/i },
  { label: "Adelaide, Australia", match: /adelaide/i, country: /australia/i },
  { label: "Eden, Australia", match: /^eden$|eden australia|eden nsw/i, country: /australia/i, exclude: /new york|canada|garden of/i },
  { label: "Burnie, Australia", match: /burnie/i, country: /australia/i, exclude: /scotland|uk|united kingdom/i },
  {
    label: "Bay of Islands, New Zealand",
    match: /bay of islands|russell|paihia|waitangi/i,
    country: /new zealand/i,
    aliases: ["Bay of Islands", "Russell", "Paihia"]
  },
  { label: "Napier, New Zealand", match: /napier/i, country: /new zealand/i, exclude: /italy|florida|usa|united states/i },
  { label: "Picton, New Zealand", match: /picton/i, country: /new zealand/i, exclude: /canada|ontario|marlborough canada/i },
  {
    label: "Port Chalmers, New Zealand",
    match: /port chalmers|chalmers|dunedin/i,
    country: /new zealand|otago/i,
    aliases: ["Port Chalmers", "Dunedin"]
  },
  // Asia
  {
    label: "Tokyo/Yokohama, Japan",
    match: /tokyo|yokohama/i,
    country: /japan/i,
    aliases: ["Tokyo", "Yokohama"],
    note: "Tokyo and Yokohama are separate catalogue entries"
  },
  { label: "Osaka, Japan", match: /osaka/i, country: /japan/i, exclude: /georgia|usa|united states/i },
  { label: "Kobe, Japan", match: /kobe/i, country: /japan/i },
  { label: "Hiroshima, Japan", match: /hiroshima/i, country: /japan/i },
  { label: "Busan, South Korea", match: /busan|pusan/i, country: /korea|south korea/i },
  {
    label: "Keelung/Taipei, Taiwan",
    match: /keelung|taipei|taiwan/i,
    country: /taiwan|china/i,
    aliases: ["Keelung", "Taipei"]
  },
  { label: "Shanghai, China", match: /shanghai/i, country: /china/i, exclude: /restaurant|hotel only/i },
  {
    label: "Halong Bay, Vietnam",
    match: /halong|ha long|hạ long/i,
    country: /vietnam/i,
    aliases: ["Halong Bay", "Ha Long Bay", "Hạ Long"]
  },
  {
    label: "Da Nang/Chan May, Vietnam",
    match: /da nang|danang|đà nẵng|chan may|hoi an|hue/i,
    country: /vietnam/i,
    aliases: ["Da Nang", "Chan May", "Hoi An", "Hue"]
  },
  { label: "Phuket, Thailand", match: /phuket/i, country: /thailand/i },
  // North America
  { label: "Seward, Alaska, USA", match: /seward/i, country: /united states|usa|alaska/i },
  {
    label: "Icy Strait Point/Hoonah, Alaska, USA",
    match: /icy strait|hoonah/i,
    country: /united states|usa|alaska/i,
    aliases: ["Icy Strait Point", "Hoonah"]
  },
  {
    label: "Prince Rupert, British Columbia, Canada",
    match: /prince rupert/i,
    country: /canada/i,
    region: /british columbia|bc/i
  },
  { label: "San Francisco, California, USA", match: /san francisco/i, country: /united states|usa|california/i },
  {
    label: "Los Angeles/San Pedro, California, USA",
    match: /los angeles|san pedro|long beach/i,
    country: /united states|usa|california/i,
    aliases: ["San Pedro", "Los Angeles"],
    note: "Prefer San Pedro cruise terminal over generic LA skyline"
  },
  { label: "San Diego, California, USA", match: /san diego/i, country: /united states|usa|california/i },
  { label: "Seattle, Washington, USA", match: /seattle/i, country: /united states|usa|washington/i },
  { label: "Boston, Massachusetts, USA", match: /boston/i, country: /united states|usa|massachusetts/i, exclude: /lincolnshire|uk|united kingdom/i },
  { label: "New York, New York, USA", match: /new york|manhattan|brooklyn/i, country: /united states|usa|new york/i },
  {
    label: "Quebec City, Canada",
    match: /quebec|qu[eé]bec city/i,
    country: /canada/i,
    aliases: ["Quebec City", "Québec City"]
  },
  // Caribbean
  { label: "Cozumel, Mexico", match: /cozumel/i, country: /mexico/i },
  {
    label: "Costa Maya, Mexico",
    match: /costa maya|mahahual/i,
    requireCanonical: /costa maya/i,
    forbiddenCanonical: /ensenada|cozumel|playa del carmen/i,
    country: /mexico/i,
    aliases: ["Costa Maya", "Mahahual"]
  },
  {
    label: "George Town, Grand Cayman",
    match: /george town|grand cayman|cayman/i,
    country: /cayman|united kingdom|uk/i,
    exclude: /malaysia|penang/i
  },
  { label: "Nassau, Bahamas", match: /nassau/i, country: /bahamas/i, exclude: /germany|german/i },
  { label: "Bridgetown, Barbados", match: /bridgetown/i, country: /barbados/i },
  { label: "Castries, St Lucia", match: /castries|st\.?\s*lucia|saint lucia/i, country: /saint lucia|st lucia|lucia/i },
  {
    label: "St John's, Antigua",
    match: /st\.?\s*john|saint john|antigua/i,
    country: /antigua|barbuda/i,
    exclude: /newfoundland|canada|new brunswick/i
  },
  {
    label: "Basseterre, St Kitts",
    match: /basseterre|st\.?\s*kitts|saint kitts/i,
    country: /saint kitts|st kitts|kitts|nevis/i
  },
  { label: "Roseau, Dominica", match: /roseau|dominica/i, country: /dominica/i, exclude: /canada|quebec/i },
  {
    label: "Road Town, Tortola",
    match: /road town|tortola|british virgin/i,
    country: /british virgin|virgin islands|bvi/i,
    aliases: ["Road Town", "Tortola"]
  },
  // Europe
  { label: "Santorini, Greece", match: /santorini|thira|fira|oia|athinios/i, country: /greece/i },
  { label: "Corfu, Greece", match: /corfu|kerkyra/i, country: /greece/i },
  { label: "Rhodes, Greece", match: /rhodes|rodos/i, country: /greece/i },
  { label: "Marseille, France", match: /marseille|marseilles/i, country: /france/i },
  {
    label: "Livorno, Italy",
    match: /livorno|spezia/i,
    country: /italy/i,
    exclude: /la spezia/i,
    aliases: ["Livorno", "Florence", "Pisa"],
    note: "Livorno serves Florence/Pisa — avoid La Spezia confusion"
  },
  { label: "Valletta, Malta", match: /valletta|la valletta/i, country: /malta/i },
  { label: "Bergen, Norway", match: /bergen/i, country: /norway/i, exclude: /germany|usa|united states/i },
  {
    label: "Flåm, Norway",
    match: /flam|fl[aå]m/i,
    country: /norway/i,
    aliases: ["Flam", "Flåm"]
  },
  { label: "Reykjavik, Iceland", match: /reykjavik|reykjav[ií]k/i, country: /iceland/i },
  { label: "Belfast, Northern Ireland", match: /belfast/i, country: /united kingdom|uk|northern ireland|ireland/i, exclude: /maine|usa|united states/i }
];

const EDITORIAL_APPLY = {
  "Brisbane, Australia": {
    prefer: /brisbane|queensland|story bridge|river|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship|celebrity|norwegian/i
  },
  "Cairns, Australia": {
    prefer: /cairns|queensland|trinity|harbour|harbor|waterfront|reef|port/i,
    rejectTopIf: /cruise ship docked|celebrity/i
  },
  "Darwin, Australia": {
    prefer: /darwin|northern territory|nt|harbour|harbor|waterfront|port|wharf/i,
    rejectTopIf: /cruise ship|canada|ontario/i
  },
  "Adelaide, Australia": {
    prefer: /adelaide|south australia|outer harbor|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship|celebrity/i
  },
  "Eden, Australia": {
    prefer: /eden|nsw|sapphire coast|harbour|harbor|waterfront|port|wharf/i,
    rejectTopIf: /cruise ship|garden of eden|new york/i
  },
  "Burnie, Australia": {
    prefer: /burnie|tasmania|harbour|harbor|waterfront|port|wharf/i,
    rejectTopIf: /cruise ship|scotland|uk/i
  },
  "Bay of Islands, New Zealand": {
    prefer: /bay of islands|russell|paihia|waitangi|new zealand|harbour|harbor|waterfront/i,
    rejectTopIf: /cruise ship|celebrity|fiji only/i
  },
  "Napier, New Zealand": {
    prefer: /napier|hawke|art deco|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship|italy|florida/i
  },
  "Picton, New Zealand": {
    prefer: /picton|marlborough|queen charlotte|sounds|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship|canada|ontario/i
  },
  "Port Chalmers, New Zealand": {
    prefer: /port chalmers|dunedin|otago|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship docked|celebrity solstice/i
  },
  "Tokyo/Yokohama, Japan": {
    prefer: /yokohama|tokyo|harbour|harbor|waterfront|port|skyline|minato/i,
    rejectTopIf: /cruise ship docked|osaka only|kyoto only|nagoya only/i
  },
  "Osaka, Japan": {
    prefer: /osaka|harbour|harbor|waterfront|port|skyline|tempozan/i,
    rejectTopIf: /cruise ship|tokyo only|kyoto only/i
  },
  "Kobe, Japan": {
    prefer: /kobe|harbour|harbor|waterfront|port|skyline|port tower/i,
    rejectTopIf: /cruise ship|osaka only|tokyo only/i
  },
  "Hiroshima, Japan": {
    prefer: /hiroshima|harbour|harbor|waterfront|port|peace|miyajima/i,
    rejectTopIf: /cruise ship|tokyo|osaka|nagasaki only/i
  },
  "Busan, South Korea": {
    prefer: /busan|pusan|harbour|harbor|waterfront|port|skyline/i,
    rejectTopIf: /seoul only|incheon only/i
  },
  "Keelung/Taipei, Taiwan": {
    prefer: /keelung|taipei|taiwan|harbour|harbor|waterfront|port|skyline|101/i,
    rejectTopIf: /cruise ship|shanghai|hong kong|china mainland only/i
  },
  "Shanghai, China": {
    prefer: /shanghai|bund|pudong|huangpu|harbour|harbor|waterfront|port|wusongkou|baoshan/i,
    rejectTopIf: /cruise ship docked|beijing only|hong kong only/i
  },
  "Halong Bay, Vietnam": {
    prefer: /halong|ha long|hạ long|bay|limestone|karst|vietnam|water/i,
    rejectTopIf: /ho chi minh|saigon|phu my|da nang only|hanoi street only/i
  },
  "Da Nang/Chan May, Vietnam": {
    prefer: /da nang|danang|chan may|hoi an|hue|vietnam|harbour|harbor|waterfront|port|beach/i,
    rejectTopIf: /halong only|ho chi minh only|saigon only/i
  },
  "Phuket, Thailand": {
    prefer: /phuket|thailand|harbour|harbor|waterfront|port|patong|old town/i,
    rejectTopIf: /bangkok only|chiang mai|laem chabang only/i
  },
  "Seward, Alaska, USA": {
    prefer: /seward|alaska|harbour|harbor|waterfront|port|resurrection bay|mountain/i,
    rejectTopIf: /cruise ship docked|celebrity|norwegian/i
  },
  "Icy Strait Point/Hoonah, Alaska, USA": {
    prefer: /icy strait|hoonah|alaska|harbour|harbor|waterfront|port|wilderness|glacier/i,
    rejectTopIf: /cruise ship docked|juneau only|skagway only|ketchikan only/i
  },
  "Prince Rupert, British Columbia, Canada": {
    prefer: /prince rupert|british columbia|bc|harbour|harbor|waterfront|port|kaien/i,
    rejectTopIf: /cruise ship|seattle|washington/i
  },
  "San Francisco, California, USA": {
    prefer: /san francisco|golden gate|bay|fisherman|pier|waterfront|harbour|harbor|skyline/i,
    rejectTopIf: /cruise ship docked|celebrity|oakland only/i
  },
  "Los Angeles/San Pedro, California, USA": {
    prefer: /san pedro|los angeles|la harbour|la harbor|waterfront|port|terminal|long beach cruise/i,
    rejectTopIf: /hollywood only|beverly hills|downtown la only(?!.*harbor)|downtown la only(?!.*harbour)/i
  },
  "San Diego, California, USA": {
    prefer: /san diego|harbour|harbor|waterfront|port|bay|coronado|skyline/i,
    rejectTopIf: /cruise ship docked|los angeles only|san francisco only/i
  },
  "Seattle, Washington, USA": {
    prefer: /seattle|pike place|waterfront|harbour|harbor|port|skyline|puget/i,
    rejectTopIf: /cruise ship docked|vancouver bc|british columbia/i
  },
  "Boston, Massachusetts, USA": {
    prefer: /boston|massachusetts|harbour|harbor|waterfront|port|skyline|wharf/i,
    rejectTopIf: /cruise ship docked|lincolnshire|uk/i
  },
  "New York, New York, USA": {
    prefer: /new york|manhattan|brooklyn|staten|harbour|harbor|waterfront|port|skyline|hudson/i,
    rejectTopIf: /cruise ship docked|albany ny|buffalo/i
  },
  "Quebec City, Canada": {
    prefer: /quebec|qu[eé]bec|old town|chateau|frontenac|harbour|harbor|waterfront|port|st\.? lawrence/i,
    rejectTopIf: /cruise ship docked|montreal only|toronto/i
  },
  "Cozumel, Mexico": {
    prefer: /cozumel|caribbean|waterfront|harbour|harbor|port|beach|mexico/i,
    rejectTopIf: /cruise ship docked|celebrity|playa del carmen|terminal maritima playa/i
  },
  "Costa Maya, Mexico": {
    prefer: /costa maya|mahahual|mexico|caribbean|beach|harbour|harbor|port|waterfront/i,
    rejectTopIf: /cruise ship docked|cozumel only|playa del carmen only/i
  },
  "George Town, Grand Cayman": {
    prefer: /george town|grand cayman|cayman|harbour|harbor|waterfront|port|seven mile/i,
    rejectTopIf: /penang|malaysia|scotland|georgetown guyana/i
  },
  "Nassau, Bahamas": {
    prefer: /nassau|bahamas|harbour|harbor|waterfront|port|paradise island|beach/i,
    rejectTopIf: /cruise ship docked|germany|german/i
  },
  "Bridgetown, Barbados": {
    prefer: /bridgetown|barbados|harbour|harbor|waterfront|port|carlisle bay/i,
    rejectTopIf: /cruise ship docked|celebrity/i
  },
  "Castries, St Lucia": {
    prefer: /castries|st\.?\s*lucia|saint lucia|harbour|harbor|waterfront|port|pitons/i,
    rejectTopIf: /cruise ship docked|martinique only|barbados only/i
  },
  "St John's, Antigua": {
    prefer: /st\.?\s*john|saint john|antigua|harbour|harbor|waterfront|port|barbuda/i,
    rejectTopIf: /newfoundland|canada|st\.?\s*thomas|usvi|sint maarten/i
  },
  "Basseterre, St Kitts": {
    prefer: /basseterre|st\.?\s*kitts|saint kitts|nevis|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship docked|st\.?\s*lucia only|guadeloupe only/i
  },
  "Roseau, Dominica": {
    prefer: /roseau|dominica|harbour|harbor|waterfront|port|caribbean/i,
    rejectTopIf: /cruise ship docked|canada|quebec|dominican republic/i
  },
  "Road Town, Tortola": {
    prefer: /road town|tortola|bvi|british virgin|harbour|harbor|waterfront|port/i,
    rejectTopIf: /cruise ship docked|st\.?\s*thomas|usvi|sint maarten/i
  },
  "Santorini, Greece": {
    prefer: /santorini|thira|fira|oia|caldera|cyclades|harbour|harbor|waterfront/i,
    rejectTopIf: /cruise ship only|mykonos only|athens only/i
  },
  "Corfu, Greece": {
    prefer: /corfu|kerkyra|old town|harbour|harbor|waterfront|port|ionian/i,
    rejectTopIf: /cruise ship docked|santorini only|athens only/i
  },
  "Rhodes, Greece": {
    prefer: /rhodes|rodos|old town|harbour|harbor|waterfront|port|medieval|dodecanese/i,
    rejectTopIf: /cruise ship docked|santorini only|athens only|corfu only/i
  },
  "Marseille, France": {
    prefer: /marseille|old port|vieux port|harbour|harbor|waterfront|notre.?dame|calanques/i,
    rejectTopIf: /cruise ship docked|paris only|lyon only/i
  },
  "Livorno, Italy": {
    prefer: /livorno|florence|pisa|tuscany|italy|harbour|harbor|waterfront|port|mole/i,
    rejectTopIf: /naples|napoli|la spezia|spezia|cruise ship docked|lancaster|bomber|warship|wwii/i
  },
  "Valletta, Malta": {
    prefer: /valletta|malta|grand harbour|grand harbor|waterfront|port|fort|bastion/i,
    rejectTopIf: /cruise ship docked|sicily only|italy only(?!.*malta)/i
  },
  "Bergen, Norway": {
    prefer: /bergen|bryggen|fjord|norway|harbour|harbor|waterfront|port|mount/i,
    rejectTopIf: /cruise ship docked|oslo only|geiranger only/i
  },
  "Flåm, Norway": {
    prefer: /fl[aå]m|flam|aurland|fjord|norway|harbour|harbor|waterfront|port|railway/i,
    rejectTopIf: /cruise ship docked|bergen city only|oslo/i
  },
  "Reykjavik, Iceland": {
    prefer: /reykjav[ií]k|reykjavik|iceland|harbour|harbor|waterfront|port|hallgr[ií]mskirkja|skyline/i,
    rejectTopIf: /cruise ship docked|greenland|norway only/i
  },
  "Belfast, Northern Ireland": {
    prefer: /belfast|northern ireland|harbour|harbor|waterfront|port|titanic|lough|skyline/i,
    rejectTopIf: /cruise ship docked|maine|usa|dublin only(?!.*belfast)/i
  }
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
      ...(Array.isArray(port.aliases) ? port.aliases : [])
    ]
      .filter(Boolean)
      .map(normalizeKey);

    const nameMatch = names.some((n) => spec.match.test(n));
    if (!nameMatch) return false;
    return true;
  });

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    if (spec.label === "Tokyo/Yokohama, Japan") {
      return (
        candidates.find((p) => /yokohama/i.test(normalizeKey(p.canonical_name))) ||
        candidates.find((p) => /tokyo/i.test(normalizeKey(p.canonical_name))) ||
        candidates[0]
      );
    }
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

function enrichRow(row) {
  if (!row) return null;
  return {
    ...row,
    status: statusForCandidate(row)
  };
}

function selectedRankForPick(ranked, pick) {
  if (!pick || !Array.isArray(ranked)) return null;
  const idx = ranked.findIndex((r) => r.candidate === pick.candidate);
  return idx >= 0 ? idx + 1 : null;
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
  if (row.geographic >= 75 && row.suitability >= 75 && !row.vesselPrimary) return "GOOD";
  if (row.geographic >= 55 && row.suitability >= 60) return "ACCEPTABLE";
  return "POOR";
}

function hasWrongGeography(title, spec) {
  const wrongPatterns = {
    "Darwin, Australia": /canada|ontario|darwin nt canada/i,
    "Eden, Australia": /new york|garden of eden/i,
    "Picton, New Zealand": /canada|ontario|marlborough canada/i,
    "Tokyo/Yokohama, Japan": /osaka only|kyoto only|nagoya only/i,
    "Keelung/Taipei, Taiwan": /shanghai|hong kong|beijing/i,
    "Halong Bay, Vietnam": /ho chi minh|saigon only|hanoi street/i,
    "Da Nang/Chan May, Vietnam": /halong only|ho chi minh only/i,
    "Los Angeles/San Pedro, California, USA": /san francisco only|seattle only/i,
    "Icy Strait Point/Hoonah, Alaska, USA": /juneau only|skagway only|ketchikan only/i,
    "Prince Rupert, British Columbia, Canada": /seattle|washington state/i,
    "George Town, Grand Cayman": /penang|malaysia|georgetown guyana/i,
    "Cozumel, Mexico": /playa del carmen|terminal maritima playa/i,
    "St John's, Antigua": /newfoundland|canada(?!.*antigua)/i,
    "Roseau, Dominica": /dominican republic|canada|quebec/i,
    "Livorno, Italy": /la spezia|spezia|naples fl/i,
    "Flåm, Norway": /bergen city only|oslo only/i,
    "Reykjavik, Iceland": /greenland|norway only/i,
    "Rhodes, Greece": /rhode island|usa/i,
    "Belfast, Northern Ireland": /maine|belfast usa/i
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
  const eligible = search.eligibleCandidate;
  const rawTop = search.rawTopCandidate;
  const pickCandidate = eligible || null;
  const pick = pickCandidate
    ? enrichRow({ candidate: pickCandidate, ...scorePortImageCandidate(pickCandidate, port) })
    : null;
  const rows = (search.candidates || []).map((c) =>
    enrichRow({ candidate: c, ...scorePortImageCandidate(c, port) })
  );
  const rawTopTitle = rawTop?.title || null;
  const selectedRank = search.selectedRank;
  const displacedHistorical = search.displacedHistorical;
  const ageClass = pick ? classifyImageAge(pick.candidate).ageClass : null;
  const rating = editorialRating(pick, spec);

  return {
    spec,
    port,
    search,
    rows,
    pick,
    rawTopTitle,
    selectedRank,
    displacedHistorical,
    ageClass,
    editorialRating: rating,
    editoriallyApplicable: editoriallyApplicable(pick, spec)
  };
}

function percent(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

function buildDiscoverAccuracy(discoveries) {
  const discovered = discoveries.filter((d) => d.found && !d.skipped);
  const ageBreakdown = { MODERN: 0, HISTORICAL: 0, UNKNOWN: 0 };
  let historicalDisplacements = 0;

  for (const d of discovered) {
    if (d.displacedHistorical) historicalDisplacements += 1;
    if (d.ageClass) ageBreakdown[d.ageClass] = (ageBreakdown[d.ageClass] || 0) + 1;
  }

  return { historicalDisplacements, ageBreakdown };
}

function buildApplyAccuracy(applyResults) {
  const applied = applyResults.filter((r) => r.applied);
  const autoApproved = applied.filter((r) => r.imageStatus === "AUTO_APPROVED");
  const autoEditorialGood = autoApproved.filter(
    (r) => r.editorialRating === "GOOD" || r.editorialRating === "ACCEPTABLE"
  );
  const geographicGood = applied.filter((r) => r.editorialRating !== "WRONG" && (r.geographic ?? 0) >= 55);
  const licensed = applied.filter((r) => r.licensed !== false);

  return {
    autoApprovalEditorialAccuracy: percent(autoEditorialGood.length, autoApproved.length),
    geographicAccuracy: percent(geographicGood.length, applied.length),
    licensingAccuracy: percent(licensed.length, applied.length)
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

    const publicMap = await resolveCatalogueMediaIds(
      (p) => rest.get(p.replace(/^\//, "")),
      [reloaded.canonical_name, reloaded.city].filter(Boolean)
    );
    const isPublic = publicMap.has(reloaded.canonical_name?.toLowerCase()) || publicMap.size > 0;

    return {
      applied: true,
      imageStatus,
      editorialRating: result.editorialRating,
      geographic: pick.geographic,
      licensed: licenseIsUsable(pick.candidate),
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
    const resolution = resolveCanonicalPort(allPorts, spec);
    if (!resolution.ok) {
      discoveries.push({
        label: spec.label,
        found: false,
        reason: resolution.reason === "not_found" ? "missing" : "PORT_RESOLUTION_FAILED",
        code: resolution.code,
        candidates: resolution.candidates || null
      });
      continue;
    }
    const port = resolution.port;
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

  const discoverSummary = buildDiscoverSummary(discoveries, BATCH_PORTS.length);
  const discoverAccuracy = buildDiscoverAccuracy(discoveries);

  const summary = {
    phase: "discover",
    requested: discoverSummary.requested,
    missing: discoverSummary.missing,
    missingCount: discoverSummary.missingCount,
    resolutionFailures: discoverSummary.resolutionFailures,
    resolutionFailureCount: discoverSummary.resolutionFailureCount,
    canonicalMatches: discoverSummary.canonicalMatches,
    skipped: discoverSummary.skipped,
    processed: discoverSummary.processed,
    ratings: discoverSummary.ratings,
    ratingsTotal: discoverSummary.ratingsTotal,
    reconciled: discoverSummary.reconciled,
    formulas: discoverSummary.formulas,
    historicalDisplacements: discoverAccuracy.historicalDisplacements,
    ageBreakdown: discoverAccuracy.ageBreakdown,
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
        rawTopTitle: d.rawTopTitle,
        selectedRank: d.selectedRank,
        displacedHistorical: d.displacedHistorical,
        ageClass: d.ageClass,
        top_candidates: d.rows.slice(0, 3).map((r) => ({
          title: r.candidate?.title,
          provider: r.candidate?.provider,
          license: r.candidate?.license,
          geographic: r.geographic,
          suitability: r.suitability,
          confidence: r.confidence,
          vesselPrimary: r.vesselPrimary,
          status: r.status,
          ageClass: classifyImageAge(r.candidate).ageClass
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
              editoriallyApplicable: d.editoriallyApplicable,
              selectedRank: d.selectedRank,
              displacedHistorical: d.displacedHistorical,
              ageClass: d.ageClass
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
  const applySummary = buildApplySummary(applyResults, discoverSummary);
  const applyAccuracy = buildApplyAccuracy(applyResults);

  console.log(
    JSON.stringify(
      {
        phase: "apply",
        apply_results: applyResults,
        applySummary,
        autoApprovalEditorialAccuracy: applySummary.autoApprovalEditorialAccuracy,
        geographicAccuracy: applySummary.geographicAccuracy,
        licensingAccuracy: applySummary.licensingAccuracy,
        reconciled: applySummary.reconciled,
        formulas: applySummary.formulas,
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
