#!/usr/bin/env node
/**
 * Read-only verification that DEV media bootstrap objects exist.
 *
 * Env:
 *   SUPABASE_DEV_URL
 *   SUPABASE_DEV_SERVICE_ROLE_KEY
 *
 * Refuses any project other than vkheexbapykcdfbqcach.
 * Never prints credentials. Never writes.
 *
 *   node scripts/verify-dev-media-bootstrap.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXPECTED_REF = "vkheexbapykcdfbqcach";
const FORBIDDEN_REF = "xikbibxyinttllxamgao";

const EXPECTED_MEDIA_COLUMNS = [
  "id",
  "title",
  "alt_text",
  "media_type",
  "storage_bucket",
  "storage_path",
  "public_url",
  "file_name",
  "original_filename",
  "mime_type",
  "width",
  "height",
  "file_size_bytes",
  "content_hash",
  "import_source",
  "source_url",
  "cruise_line_id",
  "ship_id",
  "destination_name",
  "port_name",
  "tags",
  "is_default",
  "is_active",
  "created_at",
  "updated_at",
  "created_by"
];

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

function scrub(s) {
  return String(s || "")
    .replace(/eyJ[\w.-]+/g, "[redacted]")
    .replace(/sb_[a-z]+_[A-Za-z0-9_-]+/g, "[redacted]");
}

async function main() {
  const url = (process.env.SUPABASE_DEV_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_DEV_SERVICE_ROLE_KEY || "";

  if (!url || !key) {
    console.error("Missing SUPABASE_DEV_URL or SUPABASE_DEV_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  let ref;
  try {
    ref = new URL(url).hostname.split(".")[0];
  } catch {
    console.error("SUPABASE_DEV_URL is not a valid URL");
    process.exit(1);
  }

  if (ref === FORBIDDEN_REF) {
    console.error("REFUSED: URL points at production project. Aborting.");
    process.exit(2);
  }
  if (ref !== EXPECTED_REF) {
    console.error(
      `REFUSED: project ref is "${ref}", expected "${EXPECTED_REF}". Aborting.`
    );
    process.exit(2);
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    Prefer: "count=exact"
  };

  async function get(pathSuffix) {
    const res = await fetch(`${url}${pathSuffix}`, { headers });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { res, data };
  }

  async function probeTable(name, select = "id") {
    const { res, data } = await get(
      `/rest/v1/${name}?select=${encodeURIComponent(select)}&limit=1`
    );
    const cr = res.headers.get("content-range");
    let total = null;
    if (cr && cr.includes("/")) {
      const p = cr.split("/")[1];
      total = p === "*" ? null : Number(p);
    }
    const msg = String(data?.message || data?.error || "").toLowerCase();
    const missing =
      res.status === 404 ||
      data?.code === "PGRST205" ||
      data?.code === "42P01" ||
      msg.includes("could not find the table") ||
      msg.includes("does not exist");
    return {
      name,
      exists: res.ok ? true : missing ? false : null,
      http_status: res.status,
      row_count: Number.isFinite(total) ? total : null,
      error: res.ok
        ? null
        : scrub(data?.message || data?.error || `HTTP ${res.status}`)
    };
  }

  async function probeColumns(table, columns) {
    const results = {};
    for (const col of columns) {
      const { res, data } = await get(
        `/rest/v1/${table}?select=${encodeURIComponent(col)}&limit=1`
      );
      const msg = String(data?.message || data?.error || "").toLowerCase();
      const colMissing =
        res.status === 400 ||
        data?.code === "42703" ||
        msg.includes("column") ||
        msg.includes("does not exist");
      results[col] = res.ok ? "present" : colMissing ? "missing" : `http_${res.status}`;
    }
    return results;
  }

  async function probeBuckets() {
    const { res, data } = await get("/storage/v1/bucket");
    if (!res.ok) {
      return {
        ok: false,
        error: scrub(data?.message || data?.error || `HTTP ${res.status}`),
        buckets: {}
      };
    }
    const list = Array.isArray(data) ? data : [];
    const byId = Object.fromEntries(list.map((b) => [b.id || b.name, b]));
    function summarise(id) {
      const b = byId[id];
      if (!b) return { exists: false };
      return {
        exists: true,
        public: b.public,
        file_size_limit: b.file_size_limit,
        allowed_mime_types: b.allowed_mime_types || null
      };
    }
    return {
      ok: true,
      buckets: {
        "cruise-media": summarise("cruise-media"),
        "media-imports": summarise("media-imports")
      }
    };
  }

  const tables = {};
  for (const t of [
    "ci_cruise_lines",
    "ci_cruise_ships",
    "cruise_ship_aliases",
    "media_library"
  ]) {
    tables[t] = await probeTable(t);
  }

  let mediaColumns = null;
  if (tables.media_library.exists) {
    mediaColumns = await probeColumns("media_library", EXPECTED_MEDIA_COLUMNS);
  }

  const storage = await probeBuckets();

  // Index uniqueness cannot be fully inspected via REST; report guidance.
  const indexNotes = {
    inspectable_via_rest: false,
    expected_indexes: [
      "media_library_ship_content_hash_uidx",
      "media_library_line_content_hash_uidx",
      "media_library_content_hash_idx",
      "media_library_storage_path_uidx",
      "cruise_ship_aliases_line_norm_uidx"
    ],
    note: "Confirm indexes in DEV SQL Editor: SELECT indexname FROM pg_indexes WHERE tablename IN ('media_library','cruise_ship_aliases','ci_cruise_lines','ci_cruise_ships');"
  };

  const missingTables = Object.values(tables)
    .filter((t) => t.exists === false)
    .map((t) => t.name);
  const missingCols = mediaColumns
    ? Object.entries(mediaColumns)
        .filter(([, v]) => v === "missing")
        .map(([k]) => k)
    : null;

  const cruiseMediaOk = storage.buckets?.["cruise-media"]?.exists === true;
  const mediaImportsOk = storage.buckets?.["media-imports"]?.exists === true;

  let status = "ready";
  if (missingTables.length || !cruiseMediaOk || !mediaImportsOk) status = "incomplete";
  if (missingCols && missingCols.length) status = "incomplete";
  if (Object.values(tables).some((t) => t.exists == null)) status = "inconclusive";

  const report = {
    project_ref: ref,
    read_only: true,
    status,
    tables,
    media_library_columns: mediaColumns,
    storage,
    indexes: indexNotes,
    summary: {
      missing_tables: missingTables,
      missing_media_columns: missingCols,
      cruise_media_bucket: cruiseMediaOk,
      media_imports_bucket: mediaImportsOk,
      row_counts: Object.fromEntries(
        Object.values(tables).map((t) => [t.name, t.row_count])
      )
    }
  };

  console.log(JSON.stringify(report, null, 2));
  if (status !== "ready") process.exit(3);
}

main().catch((err) => {
  console.error("verify failed:", scrub(err.message));
  process.exit(1);
});
