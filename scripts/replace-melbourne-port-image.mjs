#!/usr/bin/env node
/**
 * Replace Melbourne AUTO_APPROVED vessel-primary image via replace_auto_approved.
 *
 *   node scripts/replace-melbourne-port-image.mjs --discover
 *   node scripts/replace-melbourne-port-image.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates } = require(path.join(root, "netlify/functions/lib/port-image-finder/search.js"));
const { scorePortImageCandidate } = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));
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

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const MYKONOS_NAME = "Mykonos";
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at";

const APPLY = process.argv.includes("--apply");
const DISCOVER = process.argv.includes("--discover") || !APPLY;

const PREFER =
  /melbourne.*(harbour|harbor|waterfront|skyline|port|station pier|docklands|yarra|bay)|port melbourne|station pier|victoria harbour.*melbourne|docklands.*melbourne/i;
const REJECT =
  /cruise ship|cruise ships|passenger ship|ocean liner|vessel|warship|florida|st kilda beach only|generic victoria(?!.*melbourne)/i;

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

function melbourneEditorial(row, port) {
  const title = String(row.candidate?.title || "").toLowerCase();
  if (row.vesselPrimary || REJECT.test(title)) return "POOR";
  return editorialRating(row, port, row.candidate);
}

function pickMelbourneReplacement(port, search) {
  return (
    (search.candidates || [])
      .map((c) => ({ candidate: c, ...scorePortImageCandidate(c, port) }))
      .filter((row) => !row.vesselPrimary)
      .filter((row) => !hasWrongGeographyForPort(port, row.candidate))
      .filter((row) => {
        const editorial = melbourneEditorial(row, port);
        return editorial === "GOOD" || editorial === "ACCEPTABLE";
      })
      .filter((row) => row.geographic >= 55 && row.suitability >= 50)
      .sort((a, b) => {
        const title = (row) => String(row.candidate?.title || "").toLowerCase();
        const aPref = PREFER.test(title(a)) ? 1 : 0;
        const bPref = PREFER.test(title(b)) ? 1 : 0;
        if (aPref !== bPref) return bPref - aPref;
        const aEdit = melbourneEditorial(a, port) === "GOOD" ? 1 : 0;
        const bEdit = melbourneEditorial(b, port) === "GOOD" ? 1 : 0;
        if (aEdit !== bEdit) return bEdit - aEdit;
        return b.confidence - a.confidence;
      })[0] || null
  );
}

async function verifyProtectedPorts(rest, before) {
  const civit = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];
  const mykonos = (
    await rest.get(
      `ports?select=id,hero_media_id,image_status&canonical_name=eq.${encodeURIComponent(MYKONOS_NAME)}&limit=1`
    )
  )[0];
  return {
    civitavecchia_unchanged:
      civit?.hero_media_id === before.civit?.hero_media_id && civit?.image_status === "MANUAL",
    mykonos_unchanged:
      mykonos?.hero_media_id === before.mykonos?.hero_media_id && mykonos?.image_status === "MANUAL"
  };
}

async function main() {
  const rest = createSupabaseRest(root);
  const port = (
    await rest.get(
      `ports?select=${encodeURIComponent(PORT_SELECT)}&canonical_name=eq.${encodeURIComponent("Melbourne")}&limit=1`
    )
  )[0];
  if (!port) throw new Error("Melbourne port not found");

  const before = {
    civit: (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0],
    mykonos: (
      await rest.get(
        `ports?select=id,hero_media_id,image_status&canonical_name=eq.${encodeURIComponent(MYKONOS_NAME)}&limit=1`
      )
    )[0]
  };

  const mediaBefore = port.hero_media_id
    ? (
        await rest.get(
          `media_library?select=id,title,storage_path,source_url,public_url&id=eq.${encodeURIComponent(port.hero_media_id)}&limit=1`
        )
      )[0]
    : null;

  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const pick = pickMelbourneReplacement(port, search);

  const discoverReport = {
    mode: "discover",
    port: { id: port.id, canonical_name: port.canonical_name },
    old_image: mediaBefore?.title || port.image_source_url,
    old_vessel_primary: scorePortImageCandidate(
      { title: mediaBefore?.title || "", provider: "wikimedia", license: port.image_license },
      port
    ).vesselPrimary,
    can_replace: canReplaceAutoApprovedPortImage(port),
    pick: pick
      ? {
          title: pick.candidate.title,
          provider: pick.candidate.provider,
          license: pick.candidate.license,
          geographic: pick.geographic,
          suitability: pick.suitability,
          confidence: pick.confidence,
          vesselPrimary: pick.vesselPrimary,
          editorial: melbourneEditorial(pick, port)
        }
      : null,
    top_candidates: (search.candidates || []).slice(0, 8).map((c) => c.title)
  };

  console.log(JSON.stringify(discoverReport, null, 2));
  if (DISCOVER) return;
  if (!pick) throw new Error("No eligible Melbourne replacement candidate found.");
  if (!canReplaceAutoApprovedPortImage(port)) {
    throw new Error("Melbourne is not AUTO_APPROVED with a stored image.");
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
  const newMedia = (
    await rest.get(
      `media_library?select=id,title,storage_path,source_url,public_url,import_source&id=eq.${encodeURIComponent(reloaded.hero_media_id)}&limit=1`
    )
  )[0];
  const publicMap = await resolveCatalogueMediaIds(
    (p) => rest.get(p.replace(/^\//, "")),
    [reloaded.canonical_name, reloaded.city].filter(Boolean)
  );
  const protectedCheck = await verifyProtectedPorts(rest, before);
  const audit = melbourneEditorial(
    { candidate: pick.candidate, ...scorePortImageCandidate(pick.candidate, reloaded) },
    reloaded
  );

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        old_image: mediaBefore?.title,
        old_reason: "vessel-primary Victoria Harbour Docklands photograph",
        replacement: {
          title: pick.candidate.title,
          source: pick.candidate.provider,
          licence: pick.candidate.license,
          credit: pick.candidate.credit,
          source_url: pick.candidate.sourceUrl
        },
        new_rating: audit,
        new_status: reloaded.image_status,
        image_confidence: reloaded.image_confidence,
        previous_media_id: replaced.previous_media_id,
        previous_media_preserved: true,
        new_media_id: newMedia?.id,
        storage_path: newMedia?.storage_path,
        public_url: newMedia?.public_url,
        publicly_resolved: publicMap.has(reloaded.canonical_name?.toLowerCase()),
        protected_ports: protectedCheck,
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
