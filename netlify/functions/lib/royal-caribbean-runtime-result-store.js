/**
 * Persist Royal Caribbean runtime proof results (Netlify Blobs with /tmp fallback).
 */

const fs = require("fs/promises");
const path = require("path");

const STORE_NAME = "royal-caribbean-runtime-proof";
const TMP_DIR = path.join("/tmp", "royal-caribbean-runtime-proof");

function storeKey(runId) {
  return `results/${String(runId).trim()}.json`;
}

async function getBlobStore() {
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch {
    return null;
  }
}

async function saveRuntimeProofResult(runId, payload) {
  const key = storeKey(runId);
  const serialized = JSON.stringify({ saved_at: new Date().toISOString(), ...payload });
  const store = await getBlobStore();
  if (store) {
    await store.set(key, serialized, { metadata: { run_id: String(runId) } });
    return { backend: "netlify_blobs", key };
  }
  await fs.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${String(runId).trim()}.json`);
  await fs.writeFile(file, serialized, "utf8");
  return { backend: "tmp", key: file };
}

async function loadRuntimeProofResult(runId) {
  const key = storeKey(runId);
  const store = await getBlobStore();
  if (store) {
    const raw = await store.get(key, { type: "text" });
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const file = path.join(TMP_DIR, `${String(runId).trim()}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  STORE_NAME,
  saveRuntimeProofResult,
  loadRuntimeProofResult
};
