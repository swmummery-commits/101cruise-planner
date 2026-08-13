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

function initBlobsFromEvent(event) {
  if (!event?.blobs) return;
  try {
    const { connectLambda } = require("@netlify/blobs");
    connectLambda(event);
  } catch (error) {
    console.error("royal-caribbean-runtime-result-store:connectLambda", error?.message || error);
  }
}

async function getBlobStore(event = null) {
  initBlobsFromEvent(event);
  try {
    const { getStore } = require("@netlify/blobs");
    const siteID = String(process.env.SITE_ID || process.env.NETLIFY_SITE_ID || "").trim() || undefined;
    return getStore({
      name: STORE_NAME,
      consistency: "strong",
      ...(siteID ? { siteID } : {})
    });
  } catch (error) {
    console.error("royal-caribbean-runtime-result-store:getBlobStore", error?.message || error);
    return null;
  }
}

async function saveRuntimeProofResult(runId, payload, options = {}) {
  const key = storeKey(runId);
  const serialized = JSON.stringify({ saved_at: new Date().toISOString(), ...payload });
  const store = await getBlobStore(options.event);
  if (store) {
    try {
      await store.set(key, serialized, { metadata: { run_id: String(runId) } });
      return { backend: "netlify_blobs", key };
    } catch (error) {
      console.error("royal-caribbean-runtime-result-store:save", error?.message || error);
    }
  }
  await fs.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${String(runId).trim()}.json`);
  await fs.writeFile(file, serialized, "utf8");
  return { backend: "tmp", key: file };
}

async function loadRuntimeProofResult(runId, options = {}) {
  const key = storeKey(runId);
  const store = await getBlobStore(options.event);
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
  initBlobsFromEvent,
  saveRuntimeProofResult,
  loadRuntimeProofResult
};
