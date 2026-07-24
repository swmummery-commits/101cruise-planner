/**
 * Content sniffing, hashing, paths — shared with Sprint 16D conventions.
 */

import crypto from "node:crypto";
import path from "node:path";

export const IMPORT_SOURCE = "squarespace_ci_migration";
export const MEDIA_BUCKET = "cruise-media";

export const LIMITS = {
  maxDownloadBytes: 12 * 1024 * 1024,
  maxUploadBytes: 10 * 1024 * 1024, // cruise-media bucket limit
  fetchTimeoutMs: 20000,
  maxRedirects: 3,
  oversizedWarnBytes: 4 * 1024 * 1024,
  logoSoftMaxBytes: 2 * 1024 * 1024
};

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function safeFilename(value) {
  const original = String(value || "image").trim();
  const base = path.basename(original.replace(/\\/g, "/"));
  const decoded = (() => {
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  })();
  const cleaned = decoded.replace(/\+/g, " ");
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  const stem =
    (dot > 0 ? cleaned.slice(0, dot) : cleaned)
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "image";
  return `${stem}${ext || ""}`;
}

export function filenameFromUrl(url) {
  try {
    const u = new URL(String(url).trim());
    const base = path.posix.basename(u.pathname) || "image";
    return safeFilename(base);
  } catch {
    return "image";
  }
}

export function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
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
  if (buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  const head = buffer.slice(0, 200).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}

export function assertAllowedMime(mime) {
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(new Error(`Unsupported MIME type: ${mime || "unknown"}`), {
      code: "invalid_mime"
    });
  }
}

export function buildLineStoragePath(lineId, contentHash, originalFilename) {
  const safe = safeFilename(originalFilename);
  const hash12 = String(contentHash || "").slice(0, 12) || "unknown";
  return `lines/${String(lineId).slice(0, 64)}/${hash12}-${safe}`;
}

export function buildShipStoragePath(shipId, contentHash, originalFilename) {
  const safe = safeFilename(originalFilename);
  const hash12 = String(contentHash || "").slice(0, 12) || "unknown";
  return `ships/${String(shipId).slice(0, 64)}/${hash12}-${safe}`;
}

export function publicMediaUrl(supabaseUrl, storagePath) {
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function extForMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/jpeg") return ".jpg";
  return "";
}

export { ALLOWED_MIME };
