/**
 * Read-only Brand Imaging filesystem scan.
 * Never renames, writes, converts, or deletes local files.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isImageExtension, classifyImageRole } from "./classify.js";
import { resolveLineFolderAlias, foldKey } from "./normalize.js";

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

export const DEFAULT_BRAND_IMAGING_ROOT =
  "/Users/stevemummery/Documents/101cruise/Brand Imaging";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Detect macOS iCloud / Dateless placeholders (logical size > 0, no local blocks).
 * Reading these would download from iCloud — audit must not trigger that.
 */
export function isCloudPlaceholderStat(st) {
  if (!st || !(st.size > 0)) return false;
  if (typeof st.blocks === "number" && st.blocks === 0) return true;
  // Some volumes report tiny allocated blocks relative to size
  if (typeof st.blocks === "number" && st.blocks > 0 && st.size > 1024 * 1024) {
    const allocated = st.blocks * 512;
    if (allocated < 4096) return true;
  }
  return false;
}

function readDimsFromBuffer(buffer) {
  try {
    return readImageDimensions(buffer);
  } catch {
    return { width: null, height: null };
  }
}

function sipsMeta(filePath) {
  try {
    const out = execFileSync(
      "sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", "-g", "space", filePath],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const width = Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1]) || null;
    const height = Number((out.match(/pixelHeight:\s*(\d+)/) || [])[1]) || null;
    const format = ((out.match(/format:\s*(\S+)/) || [])[1] || "").toLowerCase() || null;
    const space = ((out.match(/space:\s*(\S+)/) || [])[1] || "").toLowerCase() || null;
    return { width, height, format, colour_mode: space };
  } catch {
    return { width: null, height: null, format: null, colour_mode: null };
  }
}

function colourModeHint(ext, buffer) {
  const e = String(ext || "").toLowerCase();
  if (e === ".png" || e === ".jpg" || e === ".jpeg" || e === ".webp") return "rgb_or_rgba";
  if (e === ".tif" || e === ".tiff" || e === ".heic") return "unknown_probe_skipped";
  if (Buffer.isBuffer(buffer) && buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  }
  return null;
}

/**
 * Inspect one image file read-only.
 * Uses in-process header parsing for PNG/JPEG/WebP.
 * Uses read-only `sips -g` only for HEIC/TIFF (or when header dims fail).
 */
export function inspectLocalImage(filePath, { rootDir, lineFolder, shipFolder, lineFolderKind }) {
  const abs = path.resolve(filePath);
  const filename = path.basename(abs);
  const ext = path.extname(filename).toLowerCase();
  const relativePath = path.relative(rootDir, abs);

  let size = 0;
  let opens = false;
  let width = null;
  let height = null;
  let colourMode = null;
  let contentHash = null;
  let error = null;

  try {
    const st = fs.statSync(abs);
    size = st.size;
    if (size <= 0) {
      error = "empty_file";
    } else if (isCloudPlaceholderStat(st)) {
      // Do not read — would trigger iCloud download / alter local materialisation.
      opens = false;
      error = "icloud_placeholder_not_downloaded";
      colourMode = null;
      contentHash = null;
    } else {
      const needsSips = ext === ".heic" || ext === ".tif" || ext === ".tiff";
      const headerBytes = Math.min(size, needsSips ? 64 * 1024 : 2 * 1024 * 1024);
      const fd = fs.openSync(abs, "r");
      let header;
      try {
        header = Buffer.alloc(headerBytes);
        fs.readSync(fd, header, 0, header.length, 0);
      } finally {
        fs.closeSync(fd);
      }

      const dims = readDimsFromBuffer(header);
      if (dims.width && dims.height) {
        width = dims.width;
        height = dims.height;
        opens = true;
        colourMode = colourModeHint(ext, header);
      }

      // sips only for HEIC/TIFF — bulk JPEG/PNG use in-process header parsing.
      if (!opens && needsSips) {
        const meta = sipsMeta(abs);
        if (meta.width && meta.height) {
          width = meta.width;
          height = meta.height;
          opens = true;
        }
        if (meta.colour_mode) colourMode = meta.colour_mode;
      }

      contentHash = sha256File(abs);
      if (!opens && contentHash) {
        error = error || "dimensions_unreadable";
      } else if (opens) {
        error = null;
      }
    }
  } catch (e) {
    opens = false;
    error = e.message || "read_failed";
  }

  const aspect =
    width && height ? Number((width / height).toFixed(4)) : null;

  return {
    absolute_path: abs,
    filename,
    extension: ext,
    file_size_bytes: size,
    width,
    height,
    aspect_ratio: aspect,
    colour_mode: colourMode,
    opens_successfully: opens,
    content_hash: contentHash,
    parent_cruise_line_folder: lineFolder || null,
    parent_ship_folder: shipFolder || null,
    relative_path: relativePath,
    apparent_role: classifyImageRole({
      filename,
      relativePath,
      lineFolderKind
    }),
    inspect_error: error
  };
}

/**
 * Walk Brand Imaging root. Returns line folders, ship folders, and images.
 * @param {string} [rootDir]
 * @param {{ onProgress?: (n:number, path:string) => void }} [opts]
 */
export function scanBrandImagingRoot(
  rootDir = DEFAULT_BRAND_IMAGING_ROOT,
  opts = {}
) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error(`Brand Imaging root not found: ${root}`), {
      code: "brand_imaging_missing"
    });
  }

  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const lineFolders = [];
  const shipFolders = [];
  const images = [];
  const skippedNonImages = [];

  function pushImage(filePath, meta) {
    const img = inspectLocalImage(filePath, meta);
    images.push(img);
    if (onProgress && images.length % 50 === 0) {
      onProgress(images.length, filePath);
    }
  }

  const topEntries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of topEntries) {
    if (ent.name.startsWith(".")) continue;
    const topPath = path.join(root, ent.name);

    if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (isImageExtension(ext)) {
        pushImage(topPath, {
          rootDir: root,
          lineFolder: null,
          shipFolder: null,
          lineFolderKind: "root"
        });
      } else {
        skippedNonImages.push(topPath);
      }
      continue;
    }

    if (!ent.isDirectory()) continue;

    const lineMeta = resolveLineFolderAlias(ent.name);
    const lineRec = {
      folder_name: ent.name.trim(),
      absolute_path: topPath,
      kind: lineMeta.kind,
      soft_key: lineMeta.soft_key || foldKey(ent.name),
      alias_hint: lineMeta.alias_hint || null
    };
    lineFolders.push(lineRec);

    let children;
    try {
      children = fs.readdirSync(topPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const childPath = path.join(topPath, child.name);

      if (child.isFile()) {
        const ext = path.extname(child.name).toLowerCase();
        if (isImageExtension(ext)) {
          pushImage(childPath, {
            rootDir: root,
            lineFolder: lineRec.folder_name,
            shipFolder: null,
            lineFolderKind: lineMeta.kind
          });
        } else {
          skippedNonImages.push(childPath);
        }
        continue;
      }

      if (!child.isDirectory()) continue;

      if (lineMeta.kind === "non_line") {
        walkImagesRecursive(
          childPath,
          root,
          lineRec.folder_name,
          child.name,
          lineMeta.kind,
          pushImage,
          skippedNonImages
        );
        shipFolders.push({
          folder_name: child.name.trim(),
          absolute_path: childPath,
          parent_line_folder: lineRec.folder_name,
          parent_line_kind: "non_line",
          is_ship_folder: false
        });
        continue;
      }

      const shipRec = {
        folder_name: child.name.trim(),
        absolute_path: childPath,
        parent_line_folder: lineRec.folder_name,
        parent_line_kind: "line",
        is_ship_folder: true
      };
      shipFolders.push(shipRec);

      walkImagesRecursive(
        childPath,
        root,
        lineRec.folder_name,
        shipRec.folder_name,
        "line",
        pushImage,
        skippedNonImages
      );
    }
  }

  return {
    root_dir: root,
    line_folders: lineFolders,
    ship_folders: shipFolders,
    images,
    skipped_non_image_files: skippedNonImages.length,
    totals: {
      line_folders: lineFolders.length,
      ship_folders: shipFolders.filter((s) => s.is_ship_folder).length,
      non_ship_subfolders: shipFolders.filter((s) => !s.is_ship_folder).length,
      images: images.length
    }
  };
}

function walkImagesRecursive(
  dir,
  rootDir,
  lineFolder,
  shipFolder,
  lineFolderKind,
  pushImage,
  skippedNonImages
) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkImagesRecursive(
        p,
        rootDir,
        lineFolder,
        shipFolder,
        lineFolderKind,
        pushImage,
        skippedNonImages
      );
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (isImageExtension(ext)) {
      pushImage(p, {
        rootDir,
        lineFolder,
        shipFolder,
        lineFolderKind
      });
    } else {
      skippedNonImages.push(p);
    }
  }
}
