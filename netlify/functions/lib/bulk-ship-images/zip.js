/**
 * ZIP listing / extraction helpers for bulk ship images.
 */

"use strict";

const JSZip = require("jszip");
const { LIMITS, assertSafeZipPath, isMacMetadataPath } = require("./matching");

async function loadZip(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw Object.assign(new Error("ZIP payload must be a Buffer"), { statusCode: 400 });
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > LIMITS.maxZipBytes) {
    throw Object.assign(
      new Error(`ZIP exceeds ${Math.round(LIMITS.maxZipBytes / (1024 * 1024))} MB limit`),
      { statusCode: 400, code: "zip_too_large" }
    );
  }
  // ZIP local file header magic
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw Object.assign(new Error("File is not a ZIP archive"), { statusCode: 400, code: "not_zip" });
  }
  return JSZip.loadAsync(buf);
}

function listZipPaths(zip) {
  const paths = [];
  zip.forEach((relativePath, file) => {
    assertSafeZipPath(relativePath);
    if (file.dir) {
      paths.push(relativePath.endsWith("/") ? relativePath : `${relativePath}/`);
      return;
    }
    paths.push(relativePath);
  });
  return paths;
}

async function readZipEntry(zip, entryPath) {
  assertSafeZipPath(entryPath);
  if (isMacMetadataPath(entryPath)) {
    throw Object.assign(new Error("Refusing macOS metadata entry"), { code: "macos_meta" });
  }
  const file = zip.file(entryPath);
  if (!file || file.dir) {
    throw Object.assign(new Error(`ZIP entry not found: ${entryPath}`), { statusCode: 400 });
  }
  const data = await file.async("nodebuffer");
  if (data.length > LIMITS.maxImageBytes) {
    throw Object.assign(
      new Error(`Image exceeds ${Math.round(LIMITS.maxImageBytes / (1024 * 1024))} MB: ${entryPath}`),
      { statusCode: 400, code: "image_too_large" }
    );
  }
  return data;
}

async function estimateUncompressed(zip) {
  let total = 0;
  const files = [];
  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    assertSafeZipPath(relativePath);
    const size = Number(file._data?.uncompressedSize || 0);
    total += size;
    files.push(relativePath);
  });
  if (files.length > LIMITS.maxFiles) {
    throw Object.assign(
      new Error(`ZIP has ${files.length} files; maximum is ${LIMITS.maxFiles}`),
      { statusCode: 400, code: "too_many_files" }
    );
  }
  if (total > LIMITS.maxUncompressedBytes) {
    throw Object.assign(new Error("ZIP uncompressed size looks unsafe (decompression bomb)"), {
      statusCode: 400,
      code: "zip_bomb"
    });
  }
  return { total, fileCount: files.length };
}

module.exports = {
  loadZip,
  listZipPaths,
  readZipEntry,
  estimateUncompressed
};
