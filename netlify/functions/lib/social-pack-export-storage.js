/**
 * Upload Social Pack ZIP to private Supabase Storage and return a signed download URL.
 * Avoids Netlify ~6MB sync response limits for full-resolution packs.
 * Does not write Media Library / Featured Cruise / booking records.
 */

const crypto = require("crypto");

const BUCKET = "social-pack-exports";
const SIGN_EXPIRES_SEC = 60 * 60; // 1 hour
const FILE_SIZE_LIMIT = 50 * 1024 * 1024;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error("Supabase server access is not configured");
    err.statusCode = 500;
    err.calm = true;
    throw err;
  }
  return { url: url.replace(/\/$/, ""), key };
}

function buildObjectPath({ newsletterNumber, filename }) {
  const n = Number(newsletterNumber) || 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = crypto.randomUUID();
  const safeName =
    String(filename || "social-pack.zip")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "social-pack.zip";
  return `newsletter-${n}/${stamp}-${id}/${safeName}`;
}

async function ensureBucket() {
  const { url, key } = config();
  const listRes = await fetch(`${url}/storage/v1/bucket/${BUCKET}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (listRes.ok) return;
  const createRes = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      file_size_limit: FILE_SIZE_LIMIT,
      allowed_mime_types: ["application/zip", "application/x-zip-compressed"]
    })
  });
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text();
    const err = new Error("Social Pack download storage is not ready yet. Please try again shortly.");
    err.statusCode = 503;
    err.calm = true;
    err.detail = text.slice(0, 200);
    throw err;
  }
}

async function uploadZipAndSign({ buffer, filename, newsletterNumber }) {
  const { url, key } = config();
  await ensureBucket();

  const objectPath = buildObjectPath({ newsletterNumber, filename });
  const encoded = objectPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  const uploadRes = await fetch(`${url}/storage/v1/object/${BUCKET}/${encoded}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/zip",
      "x-upsert": "true",
      "cache-control": "private, max-age=3600",
      "content-disposition": `attachment; filename="${String(filename || "social-pack.zip").replace(/"/g, "")}"`
    },
    body: buffer
  });
  const uploadText = await uploadRes.text();
  let uploadData = null;
  try {
    uploadData = uploadText ? JSON.parse(uploadText) : null;
  } catch {
    uploadData = uploadText;
  }
  if (!uploadRes.ok) {
    const msg = uploadData?.message || uploadData?.error || uploadText || `HTTP ${uploadRes.status}`;
    const err = new Error(
      /bucket|not found/i.test(String(msg))
        ? "Social Pack download storage is not ready yet. Please try again shortly."
        : "We couldn’t prepare the download. Please try again."
    );
    err.statusCode = uploadRes.status === 404 ? 503 : 502;
    err.calm = true;
    err.detail = String(msg).slice(0, 200);
    throw err;
  }

  const signRes = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${encoded}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: SIGN_EXPIRES_SEC })
  });
  const signText = await signRes.text();
  let signData = null;
  try {
    signData = signText ? JSON.parse(signText) : null;
  } catch {
    signData = null;
  }
  if (!signRes.ok) {
    const err = new Error("We couldn’t prepare the download. Please try again.");
    err.statusCode = 502;
    err.calm = true;
    throw err;
  }

  const signedPath = signData?.signedURL || signData?.signedUrl || signData?.signed_url;
  if (!signedPath) {
    const err = new Error("We couldn’t prepare the download. Please try again.");
    err.statusCode = 502;
    err.calm = true;
    throw err;
  }

  let downloadUrl = signedPath.startsWith("http") ? signedPath : `${url}/storage/v1${signedPath}`;
  const dlName = encodeURIComponent(String(filename || "social-pack.zip"));
  downloadUrl += (downloadUrl.includes("?") ? "&" : "?") + `download=${dlName}`;

  return {
    bucket: BUCKET,
    objectPath,
    downloadUrl,
    filename: String(filename || "social-pack.zip"),
    bytes: Buffer.byteLength(buffer),
    expiresIn: SIGN_EXPIRES_SEC
  };
}

module.exports = {
  BUCKET,
  SIGN_EXPIRES_SEC,
  uploadZipAndSign,
  buildObjectPath,
  ensureBucket
};
