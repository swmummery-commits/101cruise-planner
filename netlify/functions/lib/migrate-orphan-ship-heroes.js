/**
 * Plan and apply migration of orphan ship heroes into media_library.
 * Copies bytes into cruise-media; creates default media row; updates hero_image_url.
 * Does not delete ship-images objects.
 */

const crypto = require("crypto");

const MEDIA_BUCKET = "cruise-media";
const IMPORT_SOURCE = "orphan_ship_hero_migration";
const MAX_BYTES = 10 * 1024 * 1024;

function assignError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeFilename(value) {
  const original = String(value || "image").trim();
  const base = original.split("/").pop() || "image";
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    /* keep */
  }
  const cleaned = decoded.replace(/\+/g, " ");
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  const stem =
    (dot > 0 ? cleaned.slice(0, dot) : cleaned)
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "image";
  return `${stem}${ext || ".jpg"}`;
}

function publicObjectUrl(supabaseUrl, bucket, storagePath) {
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${bucket}/${storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extForMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

/**
 * @param {object[]} ships rows with id,name,hero_image_url,cruise_line_id
 * @param {Map<string, object[]>} mediaByShipId ship_id → media rows
 */
function classifyShipHeroGaps(ships, mediaByShipId) {
  const orphans = [];
  const mismatches = [];
  for (const ship of ships || []) {
    const hero = String(ship.hero_image_url || "").trim();
    if (!hero) continue;
    const media = mediaByShipId.get(ship.id) || [];
    const defaults = media.filter((m) => m.is_default === true);
    if (!defaults.length) {
      orphans.push({
        kind: "orphan",
        ship_id: ship.id,
        ship_name: ship.name,
        cruise_line_id: ship.cruise_line_id || null,
        hero_image_url: hero,
        media_count: media.length
      });
      continue;
    }
    const def = defaults[0];
    if (String(def.public_url || "") !== hero) {
      const matching = media.find((m) => m.public_url === hero);
      mismatches.push({
        kind: "mismatch",
        ship_id: ship.id,
        ship_name: ship.name,
        cruise_line_id: ship.cruise_line_id || null,
        hero_image_url: hero,
        current_default_id: def.id,
        current_default_url: def.public_url,
        matching_media_id: matching?.id || null
      });
    }
  }
  return { orphans, mismatches };
}

function buildStoragePath(shipId, contentHash, filename) {
  const hash12 = String(contentHash || "").slice(0, 12) || "hash";
  return `ships/${shipId}/${hash12}-${safeFilename(filename)}`;
}

/**
 * @param {object} opts
 * @param {object} opts.item orphan or mismatch plan item
 * @param {(url: string) => Promise<Buffer>} opts.fetchBytes
 * @param {(path: string, bytes: Buffer, contentType: string) => Promise<void>} opts.uploadBytes
 * @param {(row: object) => Promise<object>} opts.insertMedia
 * @param {(mediaId: string) => Promise<object>} opts.setShipHero
 * @param {string} opts.supabaseUrl
 * @param {boolean} [opts.dryRun]
 */
async function migrateOneShipHero(opts) {
  const {
    item,
    fetchBytes,
    uploadBytes,
    insertMedia,
    setShipHero,
    supabaseUrl,
    dryRun = true
  } = opts;

  if (item.kind === "mismatch" && item.matching_media_id) {
    if (dryRun) {
      return {
        dry_run: true,
        action: "promote_existing_media",
        ship_id: item.ship_id,
        media_id: item.matching_media_id
      };
    }
    const result = await setShipHero(item.matching_media_id);
    return {
      dry_run: false,
      action: "promote_existing_media",
      ship_id: item.ship_id,
      media_id: item.matching_media_id,
      result
    };
  }

  const bytes = await fetchBytes(item.hero_image_url);
  if (!bytes?.length) throw assignError("Empty image download", "empty_download");
  if (bytes.length > MAX_BYTES) throw assignError("Image exceeds 10 MB", "too_large");
  const mime = sniffMime(bytes);
  if (!mime) throw assignError("Unsupported image type", "bad_mime");

  const contentHash = sha256Hex(bytes);
  const urlName = safeFilename(item.hero_image_url.split("?")[0]);
  const withExt =
    /\.(jpe?g|png|webp)$/i.test(urlName) ? urlName : `${urlName.replace(/\.[^.]+$/, "")}${extForMime(mime)}`;
  const storagePath = buildStoragePath(item.ship_id, contentHash, withExt);
  const publicUrl = publicObjectUrl(supabaseUrl, MEDIA_BUCKET, storagePath);

  if (dryRun) {
    return {
      dry_run: true,
      action: "copy_and_register",
      ship_id: item.ship_id,
      ship_name: item.ship_name,
      bytes: bytes.length,
      mime,
      storage_path: storagePath,
      public_url: publicUrl,
      content_hash: contentHash
    };
  }

  await uploadBytes(storagePath, bytes, mime);

  const media = await insertMedia({
    title: `${item.ship_name} hero`,
    alt_text: `${item.ship_name} hero image`,
    media_type: "ship",
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    file_name: withExt,
    mime_type: mime,
    file_size_bytes: bytes.length,
    cruise_line_id: item.cruise_line_id || null,
    ship_id: item.ship_id,
    tags: ["hero", "migrated"],
    is_default: false,
    is_active: true,
    content_hash: contentHash,
    import_source: IMPORT_SOURCE,
    source_url: item.hero_image_url
  });

  const result = await setShipHero(media.id);
  return {
    dry_run: false,
    action: "copy_and_register",
    ship_id: item.ship_id,
    ship_name: item.ship_name,
    media_id: media.id,
    public_url: publicUrl,
    previous_hero_image_url: item.hero_image_url,
    result
  };
}

module.exports = {
  MEDIA_BUCKET,
  IMPORT_SOURCE,
  MAX_BYTES,
  classifyShipHeroGaps,
  migrateOneShipHero,
  buildStoragePath,
  safeFilename,
  publicObjectUrl,
  sniffMime,
  sha256Hex
};
