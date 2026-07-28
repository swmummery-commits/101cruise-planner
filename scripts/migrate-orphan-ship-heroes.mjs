#!/usr/bin/env node
/**
 * Migrate orphan / mismatched ship heroes into Media Library (cruise-media).
 *
 * Usage:
 *   node scripts/migrate-orphan-ship-heroes.mjs           # dry-run
 *   node scripts/migrate-orphan-ship-heroes.mjs --apply   # write
 *
 * Does not delete ship-images objects or booking/customer data.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  classifyShipHeroGaps,
  migrateOneShipHero,
  MEDIA_BUCKET
} = require("../netlify/functions/lib/migrate-orphan-ship-heroes.js");
const { setShipHero } = require("../netlify/functions/lib/set-ship-hero.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(restPath, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}${restPath}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    throw err;
  }
  return data;
}

async function listAllShipsWithHero() {
  const ships = [];
  let offset = 0;
  for (;;) {
    const batch = await supabase(
      `/rest/v1/ci_cruise_ships?select=id,name,hero_image_url,cruise_line_id&hero_image_url=not.is.null&order=id&limit=500&offset=${offset}`,
      { method: "GET" }
    );
    if (!Array.isArray(batch) || !batch.length) break;
    ships.push(...batch);
    if (batch.length < 500) break;
    offset += 500;
  }
  return ships;
}

async function mediaForShips(shipIds) {
  const map = new Map();
  for (const id of shipIds) map.set(id, []);
  // Chunk IN queries
  const chunkSize = 40;
  for (let i = 0; i < shipIds.length; i += chunkSize) {
    const chunk = shipIds.slice(i, i + chunkSize);
    const or = chunk.map((id) => `ship_id.eq.${id}`).join(",");
    const rows = await supabase(
      `/rest/v1/media_library?or=(${or})&media_type=eq.ship&select=id,ship_id,title,public_url,is_default,storage_bucket&limit=1000`,
      { method: "GET" }
    );
    for (const row of rows || []) {
      if (!map.has(row.ship_id)) map.set(row.ship_id, []);
      map.get(row.ship_id).push(row);
    }
  }
  return map;
}

async function fetchBytes(imageUrl) {
  const response = await fetch(imageUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  return buf;
}

async function uploadBytes(storagePath, bytes, contentType) {
  const { url, key } = config();
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "x-upsert": "true"
    },
    body: bytes
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${text.slice(0, 200)}`);
  }
}

async function insertMedia(row) {
  const rows = await supabase("/rest/v1/media_library", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function main() {
  loadEnv();
  const apply = process.argv.includes("--apply");
  const { url } = config();

  const ships = await listAllShipsWithHero();
  const mediaByShip = await mediaForShips(ships.map((s) => s.id));
  const { orphans, mismatches } = classifyShipHeroGaps(ships, mediaByShip);
  const items = [...orphans, ...mismatches];

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        ships_with_hero: ships.length,
        orphan_count: orphans.length,
        mismatch_count: mismatches.length,
        orphans: orphans.map((o) => ({ name: o.ship_name, id: o.ship_id })),
        mismatches: mismatches.map((m) => ({
          name: m.ship_name,
          id: m.ship_id,
          matching_media_id: m.matching_media_id
        }))
      },
      null,
      2
    )
  );

  if (!items.length) {
    console.log("Nothing to migrate.");
    return;
  }

  const results = [];
  for (const item of items) {
    const out = await migrateOneShipHero({
      item,
      fetchBytes,
      uploadBytes,
      insertMedia,
      setShipHero: (mediaId) => setShipHero({ mediaId, supabase }),
      supabaseUrl: url,
      dryRun: !apply
    });
    results.push(out);
    console.log(
      apply
        ? `OK ${item.ship_name}: ${out.action} → ${out.public_url || out.media_id}`
        : `DRY ${item.ship_name}: ${out.action} (${out.bytes || 0} bytes) → ${out.storage_path || out.media_id}`
    );
  }

  if (apply) {
    // Verify no orphans remain
    const ships2 = await listAllShipsWithHero();
    const media2 = await mediaForShips(ships2.map((s) => s.id));
    const after = classifyShipHeroGaps(ships2, media2);
    console.log(
      JSON.stringify(
        {
          verification: {
            remaining_orphans: after.orphans.length,
            remaining_mismatches: after.mismatches.length,
            migrated: results.length
          }
        },
        null,
        2
      )
    );
    if (after.orphans.length || after.mismatches.length) {
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
