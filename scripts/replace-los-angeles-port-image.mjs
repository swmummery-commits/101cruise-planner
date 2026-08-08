#!/usr/bin/env node
/**
 * Replace Los Angeles / San Pedro AUTO_APPROVED Santa Monica Beach image.
 *
 *   node scripts/replace-los-angeles-port-image.mjs --discover
 *   node scripts/replace-los-angeles-port-image.mjs --apply
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
  candidatePassesEligibility
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
const {
  replaceAutoApprovedPortImage,
  canReplaceAutoApprovedPortImage
} = require(path.join(root, "netlify/functions/lib/port-image-finder/apply.js"));
const { hasWrongGeographyForPort, editorialRating } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/public-image-audit.js"
));
const { resolveCatalogueMediaIds } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/resolve-public.js"
));

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at";

const APPLY = process.argv.includes("--apply");
const DISCOVER = process.argv.includes("--discover") || !APPLY;

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

function pickLosAngelesReplacement(port, search) {
  const candidates = search.candidates || [];
  return (
    candidates
      .map((c) => ({ candidate: c, ...scorePortImageCandidate(c, port) }))
      .filter((row) => !hasWrongGeographyForPort(port, row.candidate))
      .filter((row) => {
        const editorial = editorialRating(row, port, row.candidate);
        return editorial === "GOOD" || editorial === "ACCEPTABLE";
      })
      .filter((row) => row.geographic >= 55 && row.suitability >= 50 && !row.vesselPrimary)
      .sort((a, b) => {
        const title = (row) => String(row.candidate?.title || "").toLowerCase();
        const aPort = /san pedro|port of los angeles|world cruise center|los angeles harbour|los angeles harbor|la harbour|la harbor|cruise terminal|harbour|harbor/i.test(
          title(a)
        );
        const bPort = /san pedro|port of los angeles|world cruise center|los angeles harbour|los angeles harbor|la harbour|la harbor|cruise terminal|harbour|harbor/i.test(
          title(b)
        );
        if (aPort !== bPort) return bPort ? 1 : -1;
        const aEdit = editorialRating(a, port, a.candidate) === "GOOD" ? 1 : 0;
        const bEdit = editorialRating(b, port, b.candidate) === "GOOD" ? 1 : 0;
        if (aEdit !== bEdit) return bEdit - aEdit;
        return b.confidence - a.confidence;
      })[0] || null
  );
}

async function main() {
  const rest = createSupabaseRest(root);
  const port = (
    await rest.get(
      `ports?select=${encodeURIComponent(PORT_SELECT)}&canonical_name=eq.${encodeURIComponent("Los Angeles")}&limit=1`
    )
  )[0];
  if (!port) throw new Error("Los Angeles port not found");

  const mediaBefore = port.hero_media_id
    ? (
        await rest.get(
          `media_library?select=id,title,source_url,public_url&id=eq.${encodeURIComponent(port.hero_media_id)}&limit=1`
        )
      )[0]
    : null;

  const oldImage = mediaBefore?.title || port.image_source_url || "—";
  const oldWrong = hasWrongGeographyForPort(port, {
    title: oldImage,
    description: mediaBefore?.title || "",
    sourceUrl: port.image_source_url
  });

  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const pick = pickLosAngelesReplacement(port, search);

  const discoverReport = {
    mode: "discover",
    port: { id: port.id, canonical_name: port.canonical_name },
    old_image: oldImage,
    old_wrong_geography: oldWrong,
    can_replace: canReplaceAutoApprovedPortImage(port),
    pick: pick
      ? {
          title: pick.candidate.title,
          provider: pick.candidate.provider,
          license: pick.candidate.license,
          geographic: pick.geographic,
          suitability: pick.suitability,
          confidence: pick.confidence,
          editorial: editorialRating(pick, port, pick.candidate)
        }
      : null,
    top_candidates: (search.candidates || []).slice(0, 5).map((c) => c.title)
  };

  console.log(JSON.stringify(discoverReport, null, 2));
  if (DISCOVER) return;
  if (!pick) throw new Error("No eligible Los Angeles replacement candidate found.");
  if (!canReplaceAutoApprovedPortImage(port)) {
    throw new Error("Los Angeles port is not AUTO_APPROVED with a stored image.");
  }

  await new Promise((r) => setTimeout(r, 3000));
  const supabase = makeSupabaseClient(rest);
  const replaced = await replaceAutoApprovedPortImage(supabase, port, pick.candidate, {
    imageStatus: "AUTO_APPROVED",
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

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        old_image: oldImage,
        old_reason: "Santa Monica Beach is generic metro-area imagery, not San Pedro / Port of Los Angeles cruise destination",
        replacement: {
          title: pick.candidate.title,
          source: pick.candidate.provider,
          licence: pick.candidate.license,
          credit: pick.candidate.credit,
          source_url: pick.candidate.sourceUrl
        },
        new_status: reloaded.image_status,
        previous_media_id: replaced.previous_media_id,
        new_media_id: replaced.media.id,
        public_url: replaced.media.public_url,
        publicly_resolved: publicMap.has(reloaded.canonical_name?.toLowerCase()),
        port: reloaded
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
