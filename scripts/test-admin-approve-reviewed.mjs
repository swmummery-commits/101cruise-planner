#!/usr/bin/env node
/**
 * Verify NEEDS_REVIEW → MANUAL admin approval flow on production.
 * Uses Mykonos from the 10-port test unless --port-id is supplied.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { approveReviewedPortImage, canOverwritePortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/apply.js"
));
const { resolveCatalogueMediaIds } = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const PORT_SELECT =
  "id,canonical_name,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license";

function makeSupabaseClient(rest) {
  return { fetchRest: (p, o) => rest.request(p, o) };
}

async function main() {
  const rest = createSupabaseRest(root);
  const portIdArg = process.argv.find((a) => a.startsWith("--port-id="));
  const targetId = portIdArg ? portIdArg.split("=")[1] : null;

  let port;
  if (targetId) {
    port = (await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(targetId)}&limit=1`))[0];
  } else {
    const candidates = await rest.get(
      `ports?select=${encodeURIComponent(PORT_SELECT)}&image_status=eq.NEEDS_REVIEW&hero_media_id=not.is.null&limit=5`
    );
    port = candidates.find((p) => /mykonos/i.test(p.canonical_name)) || candidates[0];
  }

  if (!port?.id) {
    console.error("No NEEDS_REVIEW port with hero_media_id found.");
    process.exit(1);
  }

  const civitBefore = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];
  const mediaBefore = (
    await rest.get(`media_library?select=id,public_url,source_url,import_source&id=eq.${encodeURIComponent(port.hero_media_id)}&limit=1`)
  )[0];

  const beforePublic = await resolveCatalogueMediaIds((p) => rest.get(p.replace(/^\//, "")), [port.canonical_name]);
  const beforeOverwrite = canOverwritePortImage(port);

  const supabase = makeSupabaseClient(rest);
  const approved = await approveReviewedPortImage(supabase, port);

  const reloaded = (
    await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(port.id)}&limit=1`)
  )[0];
  const mediaAfter = (
    await rest.get(`media_library?select=id,public_url,source_url,import_source&id=eq.${encodeURIComponent(reloaded.hero_media_id)}&limit=1`)
  )[0];
  const afterPublic = await resolveCatalogueMediaIds((p) => rest.get(p.replace(/^\//, "")), [reloaded.canonical_name]);
  const civitAfter = (await rest.get(`ports?select=id,hero_media_id,image_status&id=eq.${CIVIT_ID}&limit=1`))[0];

  const result = {
    port: reloaded.canonical_name,
    port_id: reloaded.id,
    before_status: port.image_status,
    after_status: reloaded.image_status,
    hero_media_id_unchanged: port.hero_media_id === reloaded.hero_media_id,
    no_duplicate_media: mediaBefore?.id === mediaAfter?.id,
    source_metadata_intact:
      reloaded.image_source === port.image_source &&
      reloaded.image_license === port.image_license &&
      reloaded.image_credit === port.image_credit,
    public_before: beforePublic.size > 0,
    public_after: afterPublic.size > 0,
    overwrite_protected_after: !canOverwritePortImage(reloaded),
    approved_existing: approved.approved_existing,
    civitavecchia_unchanged:
      civitBefore?.hero_media_id === civitAfter?.hero_media_id && civitAfter?.image_status === "MANUAL",
    before_overwrite_allowed: beforeOverwrite,
    media: {
      before: mediaBefore,
      after: mediaAfter
    }
  };

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.after_status === "MANUAL" &&
    result.hero_media_id_unchanged &&
    result.no_duplicate_media &&
    result.public_after &&
    result.overwrite_protected_after &&
    result.civitavecchia_unchanged;

  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
