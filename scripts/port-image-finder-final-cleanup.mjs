#!/usr/bin/env node
/**
 * Final targeted Port Image Finder cleanup (production).
 *
 *   node scripts/port-image-finder-final-cleanup.mjs --dry-run
 *   node scripts/port-image-finder-final-cleanup.mjs --apply
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
  candidatePassesEligibility
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const {
  approveReviewedPortImage,
  applyPortImageCandidate
} = require(path.join(root, "netlify/functions/lib/port-image-finder/apply.js"));
const {
  auditStoredPortImage,
  editorialRating,
  hasWrongGeographyForPort
} = require(path.join(root, "netlify/functions/lib/port-image-finder/public-image-audit.js"));
const { resolveCatalogueMediaIds } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/resolve-public.js"
));
const { findDuplicateCanonicalPorts } = require(path.join(root, "scripts/lib/port-canonical-integrity.cjs"));

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,match_key,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const DARWIN_KEEP = "1ddffef8-f995-467e-8a06-76d900f4b15a";
const DARWIN_REMOVE = "a0767afe-b197-4c4c-b019-2617680076e3";
const SOUTHAMPTON_KEEP = "b76ccee1-8e45-496e-b0ff-834980471ee8";
const SOUTHAMPTON_REMOVE = "87e59e5a-5295-4b58-8502-7708810fdf5c";

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

async function loadPort(rest, nameOrId) {
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) {
    return (await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${nameOrId}&limit=1`))[0] || null;
  }
  return (
    await rest.get(
      `ports?select=${encodeURIComponent(PORT_SELECT)}&canonical_name=eq.${encodeURIComponent(nameOrId)}&limit=1`
    )
  )[0] || null;
}

async function loadMedia(rest, id) {
  if (!id) return null;
  return (await rest.get(`media_library?select=*&id=eq.${encodeURIComponent(id)}&limit=1`))[0] || null;
}

async function auditPort(rest, port) {
  const media = await loadMedia(rest, port.hero_media_id);
  return auditStoredPortImage(port, media);
}

function pickValenciaReplacement(port, search) {
  return (search.candidates || [])
    .map((c) => ({ candidate: c, ...scorePortImageCandidate(c, port) }))
    .filter((row) => !hasWrongGeographyForPort(port, row.candidate))
    .filter((row) => !/\bdenia\b|\bdénia\b/i.test(String(row.candidate?.title || "")))
    .filter((row) => /\bvalencia\b/i.test(String(row.candidate?.title || "")))
    .filter((row) => {
      const editorial = editorialRating(row, port, row.candidate);
      return (editorial === "GOOD" || editorial === "ACCEPTABLE") && !row.vesselPrimary;
    })
    .filter((row) => row.geographic >= 55 && row.suitability >= 50)
    .sort((a, b) => b.confidence - a.confidence)[0] || null;
}

async function repointFeaturedStops(rest, fromId, toId) {
  const stops = await rest.get(
    `featured_cruise_itinerary_stops?select=id,port_id&port_id=eq.${encodeURIComponent(fromId)}&limit=500`
  );
  const moved = [];
  for (const stop of stops || []) {
    moved.push(stop.id);
    if (APPLY) {
      await rest.request(`featured_cruise_itinerary_stops?id=eq.${encodeURIComponent(stop.id)}`, {
        method: "PATCH",
        body: { port_id: toId },
        prefer: "return=minimal"
      });
    }
  }
  return moved;
}

async function main() {
  const rest = createSupabaseRest(root);
  const supabase = makeSupabaseClient(rest);
  const report = { mode: DRY ? "dry-run" : "apply", steps: [] };

  // --- Approve Cape Town + Cabo San Lucas ---
  for (const name of ["Cape Town", "Cabo San Lucas"]) {
    const port = await loadPort(rest, name);
    const before = port ? { status: port.image_status, hero: port.hero_media_id } : null;
    let after = before;
    if (port?.image_status === "NEEDS_REVIEW" && port.hero_media_id) {
      if (APPLY) {
        const approved = await approveReviewedPortImage(supabase, port);
        after = { status: approved.port.image_status, hero: approved.port.hero_media_id };
      } else {
        after = { status: "MANUAL", hero: port.hero_media_id };
      }
    }
    const audit = port ? await auditPort(rest, port) : null;
    report.steps.push({ action: "approve_reviewed", port: name, before, after, audit: audit?.action });
  }

  // --- Replace Valencia Dénia image ---
  const valencia = await loadPort(rest, "Valencia");
  let valenciaReplacement = null;
  if (valencia) {
    const search = await findPortImageCandidates(valencia, { force: true, autoApply: false });
    valenciaReplacement = pickValenciaReplacement(valencia, search);
    if (valenciaReplacement && APPLY) {
      await applyPortImageCandidate(supabase, valencia, valenciaReplacement.candidate, {
        force: true,
        imageStatus: "MANUAL",
        confidence: valenciaReplacement.confidence,
        searchQuery: search.query
      });
    }
    report.steps.push({
      action: "replace_valencia",
      before_image: (await loadMedia(rest, valencia.hero_media_id))?.title,
      replacement: valenciaReplacement?.candidate?.title || null,
      scores: valenciaReplacement
        ? {
            geographic: valenciaReplacement.geographic,
            suitability: valenciaReplacement.suitability,
            confidence: valenciaReplacement.confidence
          }
        : null
    });
  }

  // --- Consolidate Southampton: keep UK canonical + human MANUAL image ---
  const southKeep = await loadPort(rest, SOUTHAMPTON_KEEP);
  const southRemove = await loadPort(rest, SOUTHAMPTON_REMOVE);
  const southStopsMoved = southRemove ? await repointFeaturedStops(rest, SOUTHAMPTON_REMOVE, SOUTHAMPTON_KEEP) : [];
  if (southKeep && southRemove && APPLY) {
    await rest.request(`ports?id=eq.${encodeURIComponent(SOUTHAMPTON_KEEP)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        hero_media_id: southRemove.hero_media_id,
        image_status: "MANUAL",
        image_source: southRemove.image_source,
        image_source_url: southRemove.image_source_url,
        image_credit: southRemove.image_credit,
        image_license: southRemove.image_license,
        image_search_query: southRemove.image_search_query,
        image_confidence: southRemove.image_confidence,
        image_last_checked_at: southRemove.image_last_checked_at
      }
    });
    await rest.request(`ports?id=eq.${encodeURIComponent(SOUTHAMPTON_REMOVE)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
  }
  report.steps.push({
    action: "consolidate_southampton",
    keep_id: SOUTHAMPTON_KEEP,
    remove_id: SOUTHAMPTON_REMOVE,
    kept_image: (await loadMedia(rest, southRemove?.hero_media_id))?.title,
    featured_stops_repointed: southStopsMoved.length,
    stop_ids: southStopsMoved
  });

  // --- Consolidate Darwin: remove sparse stub ---
  const darwinKeep = await loadPort(rest, DARWIN_KEEP);
  const darwinRemove = await loadPort(rest, DARWIN_REMOVE);
  if (darwinRemove && APPLY) {
    await rest.request(`ports?id=eq.${encodeURIComponent(DARWIN_REMOVE)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
  }
  report.steps.push({
    action: "consolidate_darwin",
    keep_id: DARWIN_KEEP,
    remove_id: DARWIN_REMOVE,
    shared_hero: darwinKeep?.hero_media_id
  });

  // --- Post-state counts + duplicate check ---
  const allPorts = await rest.get(`ports?select=id,canonical_name,country,match_key,image_status,hero_media_id&limit=2000`);
  const counts = { total: allPorts.length, AUTO_APPROVED: 0, MANUAL: 0, NEEDS_REVIEW: 0, NO_IMAGE: 0 };
  for (const p of allPorts) {
    const s = String(p.image_status || "").toUpperCase();
    if (s === "AUTO_APPROVED" && p.hero_media_id) counts.AUTO_APPROVED++;
    else if (s === "MANUAL" && p.hero_media_id) counts.MANUAL++;
    else if (s === "NEEDS_REVIEW") counts.NEEDS_REVIEW++;
    else counts.NO_IMAGE++;
  }
  report.counts = counts;
  report.duplicates = findDuplicateCanonicalPorts(allPorts);

  // --- Audit flagged public ports ---
  const flagged = ["Palma de Mallorca", "St Johns Newfoundland", "Stockholm", "Villefranche-sur-Mer", "Valencia"];
  report.flagged_audits = {};
  for (const name of flagged) {
    const port = await loadPort(rest, name);
    if (!port) continue;
    const audit = await auditPort(rest, port);
    report.flagged_audits[name] = {
      status: port.image_status,
      image: (await loadMedia(rest, port.hero_media_id))?.title,
      action: audit.action,
      editorial: audit.editorial,
      reasons: audit.reasons
    };
  }

  report.public_resolution = {};
  for (const name of ["Cape Town", "Cabo San Lucas", "Valencia", "Southampton"]) {
    const map = await resolveCatalogueMediaIds((p) => rest.get(p.replace(/^\//, "")), [name]);
    report.public_resolution[name] = map.has(name.toLowerCase());
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
