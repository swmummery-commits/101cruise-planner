/**
 * Bulk ship-image import — pure helpers (no Supabase I/O).
 * Sprint 16D.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const HERO_NAMES = new Set([
  "hero.jpg",
  "hero.jpeg",
  "hero.png",
  "hero.webp",
  "primary.jpg",
  "primary.jpeg",
  "primary.png",
  "primary.webp"
]);
const UNSUPPORTED_EXT = new Set([
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".gif",
  ".pdf",
  ".bmp",
  ".svg"
]);

const LIMITS = {
  maxZipBytes: 50 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxFiles: 150,
  maxUncompressedBytes: 120 * 1024 * 1024
};

function normaliseName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilename(value) {
  const original = String(value || "image").trim();
  const base = path.basename(original.replace(/\\/g, "/"));
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
  return `${stem}${ext}`;
}

function slugify(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isMacMetadataPath(entryPath) {
  const p = String(entryPath || "").replace(/\\/g, "/");
  if (p.includes("__MACOSX/")) return true;
  const base = path.posix.basename(p);
  if (base === ".DS_Store" || base.startsWith("._")) return true;
  return false;
}

function assertSafeZipPath(entryPath) {
  const raw = String(entryPath || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0")) {
    throw Object.assign(new Error(`Unsafe ZIP path: ${entryPath}`), { code: "path_traversal" });
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    // allow trailing slash dirs with empty last segment
    const filtered = parts.filter((p, i) => p !== "" || i === parts.length - 1);
    if (filtered.some((p) => p === "..")) {
      throw Object.assign(new Error(`Path traversal rejected: ${entryPath}`), {
        code: "path_traversal"
      });
    }
  }
  if (parts.includes("..")) {
    throw Object.assign(new Error(`Path traversal rejected: ${entryPath}`), {
      code: "path_traversal"
    });
  }
  return raw.replace(/^\/+/, "");
}

function classifyEntry(entryPath) {
  const safe = assertSafeZipPath(entryPath);
  if (isMacMetadataPath(safe)) {
    return { kind: "ignored_macos", path: safe };
  }
  if (safe.endsWith("/")) {
    return { kind: "directory", path: safe };
  }
  const ext = path.posix.extname(safe).toLowerCase();
  const base = path.posix.basename(safe);
  if (ALLOWED_EXT.has(ext)) {
    return {
      kind: "image",
      path: safe,
      ext,
      basename: base,
      isHeroCandidate: HERO_NAMES.has(base.toLowerCase())
    };
  }
  if (UNSUPPORTED_EXT.has(ext) || ext) {
    return { kind: "unsupported", path: safe, ext, basename: base };
  }
  return { kind: "ignored_other", path: safe };
}

/**
 * Parse ZIP entry paths into ship folders for single-line mode.
 * Expects: Ship Name/file.jpg  (optional root wrapper ignored if unique)
 */
function groupSingleLineEntries(entryPaths) {
  const files = [];
  const ignored = [];
  const unsupported = [];

  for (const entryPath of entryPaths) {
    let classified;
    try {
      classified = classifyEntry(entryPath);
    } catch (error) {
      if (error.code === "path_traversal") throw error;
      ignored.push({ path: entryPath, reason: error.message });
      continue;
    }
    if (classified.kind === "directory") continue;
    if (classified.kind === "ignored_macos" || classified.kind === "ignored_other") {
      ignored.push({ path: classified.path, reason: classified.kind });
      continue;
    }
    if (classified.kind === "unsupported") {
      unsupported.push(classified);
      continue;
    }
    files.push(classified);
  }

  // Strip a single common root folder if every path shares it and the next
  // segment looks like ship folders (depth >= 2 after strip).
  const split = files.map((f) => ({
    ...f,
    parts: f.path.split("/").filter(Boolean)
  }));

  let working = split;
  if (split.length) {
    const roots = new Set(split.map((f) => f.parts[0]));
    if (roots.size === 1) {
      const only = [...roots][0];
      const depths = split.map((f) => f.parts.length);
      const minDepth = Math.min(...depths);
      // If everything is Root/Ship/file or Root/file — detect
      if (minDepth >= 3) {
        working = split.map((f) => ({
          ...f,
          parts: f.parts.slice(1),
          path: f.parts.slice(1).join("/")
        }));
      } else if (minDepth === 2 && only && !files.some((f) => f.parts?.length > 2)) {
        // Root might be cruise line name with ships as files directly — uncommon.
        // Keep as-is: first segment = ship folder.
        working = split;
      }
    }
  }

  const byShip = new Map();
  const loose = [];
  for (const file of working) {
    if (file.parts.length < 2) {
      loose.push(file);
      continue;
    }
    const shipFolder = file.parts[0];
    const filename = file.parts[file.parts.length - 1];
    if (!byShip.has(shipFolder)) byShip.set(shipFolder, []);
    byShip.get(shipFolder).push({
      ...file,
      ship_folder: shipFolder,
      filename,
      relative_path: file.parts.join("/")
    });
  }

  return { byShip, loose, ignored, unsupported };
}

/**
 * Full-library mode: Cruise Line / Ship / file
 */
function groupFullLibraryEntries(entryPaths) {
  const files = [];
  const ignored = [];
  const unsupported = [];

  for (const entryPath of entryPaths) {
    let classified;
    try {
      classified = classifyEntry(entryPath);
    } catch (error) {
      if (error.code === "path_traversal") throw error;
      ignored.push({ path: entryPath, reason: error.message });
      continue;
    }
    if (classified.kind === "directory") continue;
    if (classified.kind === "ignored_macos" || classified.kind === "ignored_other") {
      ignored.push({ path: classified.path, reason: classified.kind });
      continue;
    }
    if (classified.kind === "unsupported") {
      unsupported.push(classified);
      continue;
    }
    files.push(classified);
  }

  const byLine = new Map();
  const loose = [];
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length < 3) {
      loose.push({ ...file, parts });
      continue;
    }
    const lineFolder = parts[0];
    const shipFolder = parts[1];
    const filename = parts[parts.length - 1];
    if (!byLine.has(lineFolder)) byLine.set(lineFolder, new Map());
    const ships = byLine.get(lineFolder);
    if (!ships.has(shipFolder)) ships.set(shipFolder, []);
    ships.get(shipFolder).push({
      ...file,
      line_folder: lineFolder,
      ship_folder: shipFolder,
      filename,
      relative_path: parts.join("/")
    });
  }

  return { byLine, loose, ignored, unsupported };
}

function matchShipFolder(folderName, ships, aliases) {
  const needle = normaliseName(folderName);
  if (!needle) return null;

  for (const ship of ships || []) {
    if (normaliseName(ship.name) === needle) {
      return { ship, via: "exact_name" };
    }
  }
  for (const alias of aliases || []) {
    const aliasNeedle = normaliseName(alias.normalised_alias || alias.raw_alias);
    if (aliasNeedle && aliasNeedle === needle) {
      const ship = (ships || []).find((s) => s.id === alias.ship_id);
      if (ship) return { ship, via: "alias", alias };
    }
  }
  // Ends-with / contains for "MS Rotterdam" vs "Rotterdam"
  const candidates = (ships || []).filter((ship) => {
    const n = normaliseName(ship.name);
    return n.endsWith(needle) || needle.endsWith(n);
  });
  if (candidates.length === 1) {
    return { ship: candidates[0], via: "fuzzy_unique" };
  }
  return null;
}

function matchLineFolder(folderName, lines) {
  const needle = normaliseName(folderName);
  if (!needle) return null;
  for (const line of lines || []) {
    if (normaliseName(line.name) === needle) return { line, via: "exact_name" };
  }
  const candidates = (lines || []).filter((line) => {
    const n = normaliseName(line.name);
    return n.includes(needle) || needle.includes(n);
  });
  if (candidates.length === 1) return { line: candidates[0], via: "fuzzy_unique" };
  return null;
}

function buildContentAddressedPath(shipId, contentHash, originalFilename) {
  const safe = safeFilename(originalFilename);
  const hash12 = String(contentHash || "").slice(0, 12) || "unknown";
  return `ships/${String(shipId).slice(0, 64)}/${hash12}-${safe}`;
}

function mimeFromExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

module.exports = {
  ALLOWED_EXT,
  HERO_NAMES,
  LIMITS,
  normaliseName,
  safeFilename,
  slugify,
  sha256Hex,
  isMacMetadataPath,
  assertSafeZipPath,
  classifyEntry,
  groupSingleLineEntries,
  groupFullLibraryEntries,
  matchShipFolder,
  matchLineFolder,
  buildContentAddressedPath,
  mimeFromExt
};
