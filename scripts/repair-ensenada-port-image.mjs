#!/usr/bin/env node
/**
 * Repair Ensenada after incorrect Costa Maya batch image assignment.
 *
 *   node scripts/repair-ensenada-port-image.mjs --audit
 *   node scripts/repair-ensenada-port-image.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const ENSENADA_ID = "196f674c-0fed-4d2a-aba3-d518d7054746";
const WRONG_MEDIA_ID = "b9996b27-4ea7-4dde-8a72-84ad4c84ab89";
const PORT_SELECT =
  "id,canonical_name,display_name,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at,image_candidates";

const APPLY = process.argv.includes("--apply");
const AUDIT = process.argv.includes("--audit") || !APPLY;

async function fetchMedia(rest, mediaId) {
  const rows = await rest.get(
    `media_library?select=id,title,storage_path,source_url,import_source,created_at&id=eq.${encodeURIComponent(mediaId)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function countMediaReferences(rest, mediaId) {
  const ports = await rest.get(
    `ports?select=id,canonical_name&hero_media_id=eq.${encodeURIComponent(mediaId)}&limit=10`
  );
  return Array.isArray(ports) ? ports : [];
}

async function auditEnsenada(rest) {
  const port = (
    await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${ENSENADA_ID}&limit=1`)
  )[0];
  if (!port) throw new Error("Ensenada port record not found");

  const media = port.hero_media_id ? await fetchMedia(rest, port.hero_media_id) : null;
  const refs = port.hero_media_id ? await countMediaReferences(rest, port.hero_media_id) : [];

  return {
    ensenadaPortId: port.id,
    hero_media_id: port.hero_media_id,
    image_status: port.image_status,
    image_source: port.image_source,
    image_title: media?.title || null,
    source_url: media?.source_url || port.image_source_url,
    media_library_id: media?.id || null,
    storage_path: media?.storage_path || null,
    import_source: media?.import_source || null,
    media_created_at: media?.created_at || null,
    hadValidImageBeforeCostaMayaTest: false,
    createdByCostaMayaBatch:
      media?.import_source === "port_image_finder:wikimedia" &&
      /ensenada/i.test(media?.storage_path || "") &&
      media?.id === WRONG_MEDIA_ID,
    mediaReferenceCount: refs.length,
    mediaReferencedBy: refs.map((r) => r.canonical_name),
    soleReference: refs.length === 1 && refs[0]?.id === ENSENADA_ID
  };
}

async function repairEnsenada(rest) {
  const before = await auditEnsenada(rest);
  const mediaId = before.hero_media_id;
  const media = mediaId ? await fetchMedia(rest, mediaId) : null;
  const refs = mediaId ? await countMediaReferences(rest, mediaId) : [];
  const soleReference = refs.length === 1 && refs[0]?.id === ENSENADA_ID;
  const batchCreated =
    media?.import_source === "port_image_finder:wikimedia" && media?.id === WRONG_MEDIA_ID;

  await rest.request(`ports?id=eq.${encodeURIComponent(ENSENADA_ID)}`, {
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
      image_last_checked_at: new Date().toISOString(),
      image_candidates: []
    }
  });

  let mediaDeleted = false;
  let storageDeleted = false;
  if (mediaId && soleReference && batchCreated) {
    await rest.request(`media_library?id=eq.${encodeURIComponent(mediaId)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    mediaDeleted = true;

    if (media?.storage_path) {
      const { url, key } = getSupabaseConfig(root);
      const storagePath = media.storage_path;
      const response = await fetch(
        `${url}/storage/v1/object/cruise-media/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
        {
          method: "DELETE",
          headers: { apikey: key, Authorization: `Bearer ${key}` }
        }
      );
      storageDeleted = response.ok || response.status === 404;
    }
  }

  const after = await auditEnsenada(rest);
  return { before, after, mediaDeleted, storageDeleted };
}

async function main() {
  const rest = createSupabaseRest(root);
  if (AUDIT) {
    const audit = await auditEnsenada(rest);
    console.log(JSON.stringify({ mode: "audit", audit }, null, 2));
    return;
  }
  const result = await repairEnsenada(rest);
  console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
