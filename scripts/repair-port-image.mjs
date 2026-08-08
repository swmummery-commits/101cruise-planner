#!/usr/bin/env node
/**
 * Clear an incorrectly applied port image and remove orphaned batch media.
 *
 *   node scripts/repair-port-image.mjs --port-id=<uuid> --audit
 *   node scripts/repair-port-image.mjs --port-id=<uuid> --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const AUDIT = process.argv.includes("--audit") || !APPLY;
const portIdArg = process.argv.find((a) => a.startsWith("--port-id="));
const PORT_ID = portIdArg ? portIdArg.split("=")[1] : null;

const PORT_SELECT =
  "id,canonical_name,display_name,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license";

async function fetchMedia(rest, mediaId) {
  const rows = await rest.get(
    `media_library?select=id,title,storage_path,source_url,import_source,created_at&id=eq.${encodeURIComponent(mediaId)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function auditPort(rest, portId) {
  const port = (await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${portId}&limit=1`))[0];
  if (!port) throw new Error(`Port not found: ${portId}`);
  const media = port.hero_media_id ? await fetchMedia(rest, port.hero_media_id) : null;
  const refs = port.hero_media_id
    ? await rest.get(`ports?select=id,canonical_name&hero_media_id=eq.${encodeURIComponent(port.hero_media_id)}&limit=10`)
    : [];
  return {
    port,
    media,
    refs: Array.isArray(refs) ? refs : [],
    soleReference: Array.isArray(refs) && refs.length === 1 && refs[0]?.id === portId
  };
}

async function repairPort(rest, portId) {
  const before = await auditPort(rest, portId);
  const mediaId = before.port.hero_media_id;
  const media = before.media;

  await rest.request(`ports?id=eq.${encodeURIComponent(portId)}`, {
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
  if (mediaId && before.soleReference && String(media?.import_source || "").startsWith("port_image_finder:")) {
    await rest.request(`media_library?id=eq.${encodeURIComponent(mediaId)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    mediaDeleted = true;
    if (media?.storage_path) {
      const { url, key } = getSupabaseConfig(root);
      const response = await fetch(
        `${url}/storage/v1/object/cruise-media/${media.storage_path.split("/").map(encodeURIComponent).join("/")}`,
        {
          method: "DELETE",
          headers: { apikey: key, Authorization: `Bearer ${key}` }
        }
      );
      storageDeleted = response.ok || response.status === 404;
    }
  }

  const after = await auditPort(rest, portId);
  return { before, after, mediaDeleted, storageDeleted };
}

async function main() {
  if (!PORT_ID) throw new Error("--port-id=<uuid> is required");
  const rest = createSupabaseRest(root);
  if (AUDIT) {
    console.log(JSON.stringify({ mode: "audit", ...(await auditPort(rest, PORT_ID)) }, null, 2));
    return;
  }
  console.log(JSON.stringify({ mode: "apply", ...(await repairPort(rest, PORT_ID)) }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
