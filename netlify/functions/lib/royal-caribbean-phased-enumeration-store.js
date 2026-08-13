/**
 * Royal Caribbean phased authoritative-enumeration store.
 *
 * Netlify Blobs is used only as transient orchestration state. Source products
 * are sharded so no single value approaches Netlify Blobs' per-value limit.
 * This module never writes to Supabase.
 */
const fs = require("fs/promises");
const path = require("path");

const STORE_NAME = "royal-caribbean-phased-enumeration";
const TMP_DIR = path.join("/tmp", STORE_NAME);
const PRODUCT_SHARD_SIZE = 150;

function clean(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
}
function phasePrefix(runId, phaseId) {
  return `runs/${clean(runId)}/phases/${clean(phaseId)}`;
}
function manifestKey(runId, phaseId) {
  return `${phasePrefix(runId, phaseId)}/manifest.json`;
}
function shardKey(runId, phaseId, index) {
  return `${phasePrefix(runId, phaseId)}/products-${String(index).padStart(3, "0")}.json`;
}

async function getBlobStore() {
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch {
    return null;
  }
}

async function writeText(key, value) {
  const store = await getBlobStore();
  if (store) {
    await store.set(key, value);
    return { backend: "netlify_blobs", key };
  }
  const file = path.join(TMP_DIR, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, "utf8");
  return { backend: "tmp", key: file };
}

async function readText(key) {
  const store = await getBlobStore();
  if (store) return store.get(key, { type: "text" });
  try {
    return await fs.readFile(path.join(TMP_DIR, key), "utf8");
  } catch {
    return null;
  }
}

async function saveEnumerationPhase(runId, phaseId, phaseResult) {
  const products = Array.isArray(phaseResult?.products) ? phaseResult.products : [];
  const shards = [];
  for (let start = 0, index = 0; start < products.length; start += PRODUCT_SHARD_SIZE, index += 1) {
    const chunk = products.slice(start, start + PRODUCT_SHARD_SIZE);
    const key = shardKey(runId, phaseId, index);
    await writeText(key, JSON.stringify(chunk));
    shards.push({ key, count: chunk.length });
  }

  const manifest = {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    run_id: String(runId),
    phase_id: String(phaseId),
    page_size: phaseResult?.page_size || null,
    results_total: phaseResult?.results_total || 0,
    pages_requested: phaseResult?.pages_requested || 0,
    raw_group_records: phaseResult?.raw_group_records || 0,
    unique_group_ids: phaseResult?.unique_group_ids || 0,
    unique_sailing_ids: phaseResult?.unique_sailing_ids || 0,
    duplicate_group_ids_suppressed: phaseResult?.duplicate_group_ids_suppressed || 0,
    duplicate_sailing_ids: phaseResult?.duplicate_sailing_ids || 0,
    started_at: phaseResult?.started_at || null,
    completed_at: phaseResult?.completed_at || null,
    duration_ms: phaseResult?.duration_ms || null,
    stop_at_total: phaseResult?.stop_at_total !== false,
    until_empty: phaseResult?.until_empty === true,
    shard_count: shards.length,
    product_count: products.length,
    shards
  };
  await writeText(manifestKey(runId, phaseId), JSON.stringify(manifest));
  return manifest;
}

async function loadEnumerationPhaseManifest(runId, phaseId) {
  const raw = await readText(manifestKey(runId, phaseId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadEnumerationPhase(runId, phaseId) {
  const manifest = await loadEnumerationPhaseManifest(runId, phaseId);
  if (!manifest) return null;
  const products = [];
  for (const shard of manifest.shards || []) {
    const raw = await readText(shard.key);
    if (!raw) return null;
    let rows;
    try { rows = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(rows)) return null;
    products.push(...rows);
  }
  return { ...manifest, products };
}

async function savePhasedRunState(runId, payload) {
  const key = `runs/${clean(runId)}/state.json`;
  const value = JSON.stringify({ saved_at: new Date().toISOString(), run_id: String(runId), ...payload });
  await writeText(key, value);
  return { key };
}

async function loadPhasedRunState(runId) {
  const raw = await readText(`runs/${clean(runId)}/state.json`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  STORE_NAME,
  PRODUCT_SHARD_SIZE,
  saveEnumerationPhase,
  loadEnumerationPhaseManifest,
  loadEnumerationPhase,
  savePhasedRunState,
  loadPhasedRunState
};
