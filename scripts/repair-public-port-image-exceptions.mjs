#!/usr/bin/env node
/**
 * Deliberate replace_auto_approved repairs for known public image audit exceptions.
 *
 *   node scripts/repair-public-port-image-exceptions.mjs --audit
 *   node scripts/repair-public-port-image-exceptions.mjs --discover
 *   node scripts/repair-public-port-image-exceptions.mjs --apply
 *   node scripts/repair-public-port-image-exceptions.mjs --apply --port=Tampa
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { searchWikimediaCommons } = require(path.join(root, "netlify/functions/lib/port-image-finder/sources/wikimedia-client.js"));
const { scorePortImageCandidate } = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const {
  replaceAutoApprovedPortImage,
  canReplaceAutoApprovedPortImage
} = require(path.join(root, "netlify/functions/lib/port-image-finder/apply.js"));
const {
  auditStoredPortImage,
  hasWrongGeographyForPort,
  editorialRating
} = require(path.join(root, "netlify/functions/lib/port-image-finder/public-image-audit.js"));
const { resolveCatalogueMediaIds } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/resolve-public.js"
));

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at";

const PROTECTED = {
  civitavecchia: { id: "777a9a1d-55e2-4330-89d0-59ec08bca45d", name: "Civitavecchia" },
  mykonos: { name: "Mykonos" },
  losAngeles: { name: "Los Angeles" },
  melbourne: { name: "Melbourne" }
};

const EXCEPTION_PORTS = [
  {
    name: "Tampa",
    problem: "vessel_primary",
    extraQueries: ["Tampa Florida waterfront skyline", "Tampa Bay harbour Florida", "Tampa Riverwalk waterfront"],
    prefer: /tampa.*(riverwalk.*(waterfront|convention|center)|waterfront|skyline|bay|harbour|harbor)|downtown tampa/i,
    reject: /\buss\b|typhoon|commissioning|warship|destroyer|frigate|\(pc-\d\)|dog run|chwp dog/i
  },
  {
    name: "Tokyo",
    problem: "wrong_geography_or_destination",
    extraQueries: ["Tokyo Bay waterfront Japan", "Tokyo International Cruise Terminal", "Tokyo harbour skyline Japan"],
    prefer: /tokyo.*(bay|harbour|harbor|waterfront|skyline|cruise terminal)|international cruise terminal.*tokyo/i,
    reject: /ogasawara|chichijima|futami|bonin|siberian war|vragaeschensk|yokohama only/i
  },
  {
    name: "La Goulette",
    problem: "wrong_geography_or_destination",
    extraQueries: ["La Goulette Tunis harbour", "Haven van La Goulette", "La Goulette Port Tunisia"],
    prefer: /la goulette|goulette.*tunis|haven van la goulette/i,
    reject: /msc melody|tourisme redémarre/i
  },
  {
    name: "Punta Arenas",
    problem: "wrong_geography_or_destination",
    extraQueries: ["Punta Arenas Chile harbour", "Punta Arenas Chile waterfront", "Punta Arenas city Chile"],
    prefer: /punta arenas|magellan|magallanes/i,
    reject: /patagonien 07|puerto eden|patagonia only/i
  },
  {
    name: "Casablanca",
    problem: "wrong_geography_or_destination",
    extraQueries: ["Casablanca Morocco harbour", "Casablanca Morocco waterfront", "Casablanca Morocco city lights"],
    prefer: /casablanca|maroc|morocco/i,
    reject: /diamond harbour|diamond harbor|navire diamond|navire victoria harbour|soldiers of the united states army/i
  },
  {
    name: "Kahului",
    problem: "wrong_geography_or_destination",
    extraQueries: ["Kahului Maui harbour", "Kahului Bay Hawaii", "Kahului port Maui"],
    prefer: /kahului|maui.*(harbour|harbor|bay|port|waterfront)/i,
    reject: /cocos nucifera|coconut palm\b/i
  },
  {
    name: "Warnemunde",
    problem: "vessel_primary",
    extraQueries: ["Warnemunde lighthouse harbour", "Warnemunde Teepott Leuchtturm", "Rostock Warnemünde Hafen"],
    prefer: /warnemünde|warnemunde|leuchtturm|teepott|hafen|lighthouse/i,
    reject: /ostsee \(49833072171\)|ostsee \(498/i
  }
];

const APPLY = process.argv.includes("--apply");
const AUDIT = process.argv.includes("--audit") || (!APPLY && !process.argv.includes("--discover"));
const DISCOVER = process.argv.includes("--discover");
const portFilter = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || null;

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

function candidateEligible(port, candidate, config) {
  const title = String(candidate?.title || "");
  if (config.reject?.test(title)) return false;
  const row = { candidate, ...scorePortImageCandidate(candidate, port) };
  if (row.vesselPrimary) return false;
  if (hasWrongGeographyForPort(port, candidate)) return false;
  const editorial = editorialRating(row, port, candidate);
  if (editorial !== "GOOD" && editorial !== "ACCEPTABLE") return false;
  if (row.geographic < 55 || row.suitability < 50) return false;
  return true;
}

function pickReplacement(port, candidates, config) {
  return (
    candidates
      .filter((c) => candidateEligible(port, c, config))
      .map((c) => ({ candidate: c, ...scorePortImageCandidate(c, port) }))
      .sort((a, b) => {
        const title = (row) => String(row.candidate?.title || "").toLowerCase();
        const aPref = config.prefer?.test(title(a)) ? 1 : 0;
        const bPref = config.prefer?.test(title(b)) ? 1 : 0;
        if (aPref !== bPref) return bPref - aPref;
        const aEdit = editorialRating(a, port, a.candidate) === "GOOD" ? 1 : 0;
        const bEdit = editorialRating(b, port, b.candidate) === "GOOD" ? 1 : 0;
        if (aEdit !== bEdit) return bEdit - aEdit;
        return b.confidence - a.confidence;
      })[0] || null
  );
}

async function loadPort(rest, name) {
  const rows = await rest.get(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&canonical_name=eq.${encodeURIComponent(name)}&limit=1`
  );
  return rows[0] || null;
}

async function loadMedia(rest, mediaId) {
  if (!mediaId) return null;
  const rows = await rest.get(
    `media_library?select=id,title,storage_path,source_url,public_url,import_source&id=eq.${encodeURIComponent(mediaId)}&limit=1`
  );
  return rows[0] || null;
}

async function gatherCandidates(port, config) {
  const seen = new Set();
  const all = [];
  for (const query of config.extraQueries || []) {
    const rows = await searchWikimediaCommons(query, { limit: 10 });
    for (const row of rows) {
      const key = row.title || row.sourceUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(row);
    }
  }
  return all;
}

async function auditPort(rest, config) {
  const port = await loadPort(rest, config.name);
  if (!port) throw new Error(`${config.name} not found`);
  const media = await loadMedia(rest, port.hero_media_id);
  const audit = auditStoredPortImage(port, media);
  const publicMap = await resolveCatalogueMediaIds(
    (p) => rest.get(p.replace(/^\//, "")),
    [port.canonical_name, port.city].filter(Boolean)
  );
  return {
    port_id: port.id,
    canonical_name: port.canonical_name,
    hero_media_id: port.hero_media_id,
    current_image: audit.current_image,
    image_source: port.image_source,
    image_license: port.image_license,
    image_source_url: port.image_source_url,
    expected_problem: config.problem,
    audit_action: audit.action,
    audit_reasons: audit.reasons,
    editorial: audit.editorial,
    scores: audit.scores,
    publicly_resolved: publicMap.has(port.canonical_name?.toLowerCase()),
    still_needs_repair: audit.action === "REPLACE" || audit.action === "REVIEW"
  };
}

async function clearAutoApprovedToNoImage(rest, port, previousMediaId) {
  await rest.request(`ports?id=eq.${encodeURIComponent(port.id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      hero_media_id: null,
      image_status: "NO_IMAGE",
      image_source: null,
      image_source_url: null,
      image_credit: null,
      image_license: null,
      image_search_query: null,
      image_confidence: null,
      image_last_checked_at: new Date().toISOString()
    }
  });
  return { previous_media_id: previousMediaId, previous_media_preserved: true, cleared_to_no_image: true };
}

async function verifyProtected(rest, before) {
  const out = {};
  for (const [key, spec] of Object.entries(PROTECTED)) {
    const port = spec.id
      ? (await rest.get(`ports?select=id,hero_media_id,image_status,canonical_name&id=eq.${spec.id}&limit=1`))[0]
      : (await loadPort(rest, spec.name));
    out[key] = {
      canonical_name: port?.canonical_name,
      hero_media_id: port?.hero_media_id,
      image_status: port?.image_status,
      unchanged: port?.hero_media_id === before[key]?.hero_media_id && port?.image_status === before[key]?.image_status
    };
  }
  return out;
}

async function loadProtectedSnapshot(rest) {
  const out = {};
  for (const [key, spec] of Object.entries(PROTECTED)) {
    const port = spec.id
      ? (await rest.get(`ports?select=id,hero_media_id,image_status,canonical_name&id=eq.${spec.id}&limit=1`))[0]
      : (await loadPort(rest, spec.name));
    out[key] = { hero_media_id: port?.hero_media_id, image_status: port?.image_status };
  }
  return out;
}

async function main() {
  const rest = createSupabaseRest(root);
  const targets = EXCEPTION_PORTS.filter((p) => !portFilter || p.name.toLowerCase() === portFilter.toLowerCase());
  if (!targets.length) throw new Error("No matching exception ports");

  const protectedBefore = await loadProtectedSnapshot(rest);

  if (AUDIT) {
    const audits = [];
    for (const config of targets) audits.push(await auditPort(rest, config));
    console.log(JSON.stringify({ mode: "audit", audits, protected: await verifyProtected(rest, protectedBefore) }, null, 2));
    return;
  }

  const results = [];
  const supabase = makeSupabaseClient(rest);

  for (const config of targets) {
    const preAudit = await auditPort(rest, config);
    if (!preAudit.still_needs_repair) {
      results.push({ port: config.name, skipped: true, reason: "audit_no_longer_replace", preAudit });
      continue;
    }

    const port = await loadPort(rest, config.name);
    const candidates = await gatherCandidates(port, config);
    const pick = pickReplacement(port, candidates, config);

    if (DISCOVER) {
      results.push({
        port: config.name,
        preAudit,
        pick: pick
          ? {
              title: pick.candidate.title,
              license: pick.candidate.license,
              geographic: pick.geographic,
              suitability: pick.suitability,
              confidence: pick.confidence,
              editorial: editorialRating(pick, port, pick.candidate)
            }
          : null,
        candidate_count: candidates.length
      });
      continue;
    }

    if (!pick) {
      if (!canReplaceAutoApprovedPortImage(port)) {
        results.push({ port: config.name, error: "not_auto_approved", preAudit });
        continue;
      }
      const cleared = await clearAutoApprovedToNoImage(rest, port, port.hero_media_id);
      results.push({
        port: config.name,
        preAudit,
        outcome: "NO_IMAGE",
        reason: "no_eligible_replacement",
        ...cleared
      });
      continue;
    }

    const postPickAudit = auditStoredPortImage(
      { ...port, image_status: "AUTO_APPROVED", image_license: pick.candidate.license, image_source: "wikimedia" },
      {
        title: pick.candidate.title,
        alt_text: pick.candidate.description,
        public_url: pick.candidate.url,
        width: pick.candidate.width,
        height: pick.candidate.height,
        source_url: pick.candidate.sourceUrl
      }
    );
    if (postPickAudit.action !== "KEEP") {
      results.push({
        port: config.name,
        preAudit,
        outcome: "blocked",
        reason: "replacement_failed_post_audit",
        candidate: pick.candidate.title,
        postPickAudit
      });
      continue;
    }

    await new Promise((r) => setTimeout(r, 3000));
    const replaced = await replaceAutoApprovedPortImage(supabase, port, pick.candidate, {
      imageStatus: "AUTO_APPROVED",
      searchQuery: config.extraQueries[0],
      confidence: pick.confidence
    });

    const reloaded = await loadPort(rest, config.name);
    const newMedia = await loadMedia(rest, reloaded.hero_media_id);
    const publicMap = await resolveCatalogueMediaIds(
      (p) => rest.get(p.replace(/^\//, "")),
      [reloaded.canonical_name, reloaded.city].filter(Boolean)
    );
    const postAudit = auditStoredPortImage(reloaded, newMedia);

    results.push({
      port: config.name,
      preAudit,
      old_image: preAudit.current_image,
      problem: config.problem,
      replacement: {
        title: pick.candidate.title,
        licence: pick.candidate.license,
        credit: pick.candidate.credit,
        source_url: pick.candidate.sourceUrl
      },
      new_rating: editorialRating(pick, reloaded, pick.candidate),
      new_status: reloaded.image_status,
      post_audit_action: postAudit.action,
      previous_media_id: replaced.previous_media_id,
      previous_media_preserved: true,
      new_media_id: newMedia?.id,
      public_url: newMedia?.public_url,
      publicly_resolved: publicMap.has(reloaded.canonical_name?.toLowerCase()),
      outcome: postAudit.action === "KEEP" ? "REPLACED" : "REPLACED_NEEDS_REVIEW"
    });
  }

  const report = {
    mode: APPLY ? "apply" : "discover",
    results,
    protected: await verifyProtected(rest, protectedBefore)
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
