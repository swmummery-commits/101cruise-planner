/**
 * Resize and compress newsletter images for email (600px layout, retina photos).
 * Photos → JPEG around 1200px / 100–250KB. Route maps → smaller, more compressed.
 */

const PHOTO_MAX_WIDTH = 1200;
const MAP_MAX_WIDTH = 800;
const PHOTO_TARGET_MAX_BYTES = 250 * 1024;
const PHOTO_TARGET_MIN_QUALITY = 55;
const MAP_TARGET_MAX_BYTES = 180 * 1024;

function loadSharp() {
  try {
    return require("sharp");
  } catch (error) {
    const err = new Error(
      "Email image optimisation is unavailable on this server (sharp is not installed). Newsletter export cannot continue, because original Supabase images must not be used in Mailchimp HTML."
    );
    err.code = "optimizer_unavailable";
    err.statusCode = 500;
    err.cause = error;
    throw err;
  }
}

function normalizeAssetType(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "route_map" || key === "route-map" || key === "map") return "route_map";
  if (key === "hero" || key === "photo" || key === "image") return "hero";
  return "other";
}

async function optimizeEmailAsset(buffer, assetType = "hero") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error("Cannot optimise an empty image for email.");
    err.code = "optimize_empty";
    err.statusCode = 400;
    throw err;
  }
  const sharp = loadSharp();
  const type = normalizeAssetType(assetType);
  const isMap = type === "route_map";
  const maxWidth = isMap ? MAP_MAX_WIDTH : PHOTO_MAX_WIDTH;
  const targetMax = isMap ? MAP_TARGET_MAX_BYTES : PHOTO_TARGET_MAX_BYTES;

  let image;
  try {
    image = sharp(buffer, { failOn: "none", animated: false }).rotate();
  } catch (error) {
    const err = new Error(`Could not read a newsletter image for optimisation (${error.message || "invalid image"}).`);
    err.code = "optimize_invalid";
    err.statusCode = 400;
    throw err;
  }

  const meta = await image.metadata();
  const hasAlpha = Boolean(meta.hasAlpha) && isMap;
  const sourceWidth = Number(meta.width) || 0;

  async function encodeJpeg(width, quality) {
    return sharp(buffer, { failOn: "none", animated: false })
      .rotate()
      .resize({
        width,
        withoutEnlargement: true,
        fit: "inside"
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  async function encodePng(width) {
    return sharp(buffer, { failOn: "none", animated: false })
      .rotate()
      .resize({
        width,
        withoutEnlargement: true,
        fit: "inside"
      })
      .png({ compressionLevel: 9, palette: true, quality: 70, effort: 8 })
      .toBuffer();
  }

  if (hasAlpha) {
    let width = Math.min(sourceWidth || maxWidth, maxWidth);
    let out = await encodePng(width);
    while (out.length > targetMax && width > 520) {
      width = Math.max(520, width - 80);
      out = await encodePng(width);
    }
    return {
      buffer: out,
      mimeType: "image/png",
      extension: "png",
      width,
      bytes: out.length
    };
  }

  let width = Math.min(sourceWidth || maxWidth, maxWidth) || maxWidth;
  let quality = isMap ? 68 : 78;
  let out = await encodeJpeg(width, quality);

  while (out.length > targetMax && quality > PHOTO_TARGET_MIN_QUALITY) {
    quality -= 6;
    out = await encodeJpeg(width, quality);
  }
  while (out.length > targetMax + 30 * 1024 && width > 720) {
    width = Math.max(720, width - 100);
    out = await encodeJpeg(width, isMap ? 65 : 72);
  }

  return {
    buffer: out,
    mimeType: "image/jpeg",
    extension: "jpg",
    width,
    bytes: out.length
  };
}

module.exports = {
  PHOTO_MAX_WIDTH,
  MAP_MAX_WIDTH,
  PHOTO_TARGET_MAX_BYTES,
  MAP_TARGET_MAX_BYTES,
  normalizeAssetType,
  optimizeEmailAsset
};
