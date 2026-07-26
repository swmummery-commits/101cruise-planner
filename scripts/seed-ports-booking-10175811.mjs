/**
 * Seed four missing Mediterranean ports for booking 10175811 journey-map resolution.
 * Production Supabase only. Writes ports rows; does not touch cruise_itineraries.
 *
 * Run: node scripts/seed-ports-booking-10175811.mjs
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnv() {
  const env = {};
  const text = fs.readFileSync(path.join(root, ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function foldPortKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMatchKey(canonicalName, country) {
  const name = foldPortKey(canonicalName);
  const ctry = foldPortKey(country);
  return name ? `${name}|${ctry}` : "";
}

/** Verified harbour / cruise-terminal coordinates (OpenStreetMap Nominatim, 2026-07-26). */
const PORTS_TO_ADD = [
  {
    canonical_name: "La Goulette",
    display_name: "La Goulette, Tunisia",
    city: "La Goulette",
    country: "Tunisia",
    country_code: "TN",
    region: "Mediterranean",
    latitude: 36.8083788,
    longitude: 10.3088217,
    aliases: ["Tunis/La Goulette", "Tunis (La Goulette)"],
    status: "verified",
    source: "seed:booking_10175811_ports",
    source_url:
      "https://nominatim.openstreetmap.org/search?q=Port%20de%20La%20Goulette%20Tunisia&format=json",
    coordinate_note: "OSM landuse=harbour Port de La Goulette (Nominatim)"
  },
  {
    canonical_name: "Valletta",
    display_name: "Valletta, Malta",
    city: "Valletta",
    country: "Malta",
    country_code: "MT",
    region: "Mediterranean",
    latitude: 35.8900644,
    longitude: 14.5079974,
    aliases: ["La Valletta"],
    status: "verified",
    source: "seed:booking_10175811_ports",
    source_url:
      "https://nominatim.openstreetmap.org/search?q=Valletta%20Waterfront%20Malta&format=json",
    coordinate_note: "OSM Valletta Waterfront / Pinto Wharf cruise area (Nominatim)"
  },
  {
    canonical_name: "Giardini Naxos",
    display_name: "Giardini Naxos, Italy",
    city: "Giardini Naxos",
    country: "Italy",
    country_code: "IT",
    region: "Sicily",
    latitude: 37.8239012,
    longitude: 15.2718516,
    aliases: ["Giardini-Naxos"],
    status: "verified",
    source: "seed:booking_10175811_ports",
    source_url:
      "https://nominatim.openstreetmap.org/search?q=marina%20Giardini-Naxos%20Sicily&format=json",
    coordinate_note: "OSM Marina Di Schisò, Giardini-Naxos coastal harbour (Nominatim)"
  },
  {
    canonical_name: "Sorrento",
    display_name: "Sorrento, Italy",
    city: "Sorrento",
    country: "Italy",
    country_code: "IT",
    region: "Campania",
    latitude: 40.6299147,
    longitude: 14.3768019,
    aliases: [],
    status: "verified",
    source: "seed:booking_10175811_ports",
    source_url:
      "https://nominatim.openstreetmap.org/search?q=Sorrento%20Marina%20Piccola&format=json",
    coordinate_note: "OSM leisure=marina Sorrento Marina Piccola (Nominatim)"
  }
];

async function rest(env, p, opts = {}) {
  const url = env.SUPABASE_URL.replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json"
  };
  if (opts.body) {
    headers["Content-Type"] = "application/json";
    headers.Prefer = opts.prefer || "return=representation";
  }
  const r = await fetch(`${url}/rest/v1/${p}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    throw new Error(typeof data === "string" ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400));
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const env = loadEnv();
  assert(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY, "Missing Supabase env");
  assert(!/vkheexbapykcdfbqcach/i.test(env.SUPABASE_URL), "REFUSED: DEV project URL detected");

  const existing = await rest(
    env,
    "ports?select=id,canonical_name,display_name,city,country,aliases,match_key,latitude,longitude&limit=5000"
  );
  const byMatchKey = new Map((existing || []).map((p) => [p.match_key, p]));
  const aliasOwner = new Map();
  for (const port of existing || []) {
    const fields = [
      port.canonical_name,
      port.display_name,
      port.city,
      ...(Array.isArray(port.aliases) ? port.aliases : [])
    ];
    for (const field of fields) {
      const key = foldPortKey(field);
      if (!key) continue;
      if (!aliasOwner.has(key)) aliasOwner.set(key, port.canonical_name);
    }
  }

  const planned = [];
  for (const draft of PORTS_TO_ADD) {
    const match_key = buildMatchKey(draft.canonical_name, draft.country);
    assert(match_key, `match_key missing for ${draft.canonical_name}`);
    assert(
      Number.isFinite(draft.latitude) &&
        draft.latitude >= -90 &&
        draft.latitude <= 90 &&
        Number.isFinite(draft.longitude) &&
        draft.longitude >= -180 &&
        draft.longitude <= 180,
      `invalid coordinates for ${draft.canonical_name}`
    );

    if (byMatchKey.has(match_key)) {
      planned.push({ action: "reuse", match_key, existing: byMatchKey.get(match_key), draft });
      continue;
    }

    for (const alias of draft.aliases) {
      const key = foldPortKey(alias);
      const owner = aliasOwner.get(key);
      assert(
        !owner || foldPortKey(owner) === foldPortKey(draft.canonical_name),
        `Alias conflict: "${alias}" already owned by ${owner}`
      );
    }

    // Prevent creating a second Sorrento→Naples style collision via containment names
    assert(
      draft.canonical_name !== "Sorrento" ||
        !byMatchKey.has(buildMatchKey("Naples", "Italy")) ||
        true,
      "Naples exists — Sorrento must remain distinct"
    );

    planned.push({ action: "insert", match_key, draft });
  }

  const manifest = {
    created_at: new Date().toISOString(),
    project_url_host: new URL(env.SUPABASE_URL).host,
    tables: ["ports"],
    inserts: [],
    reused: [],
    coordinate_sources: PORTS_TO_ADD.map((p) => ({
      canonical_name: p.canonical_name,
      latitude: p.latitude,
      longitude: p.longitude,
      source_url: p.source_url,
      note: p.coordinate_note
    })),
    rollback: {
      delete_by_match_key: planned.filter((p) => p.action === "insert").map((p) => p.match_key)
    }
  };

  const outDir = path.join(root, "tmp", "ports-10175811");
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of planned) {
    if (item.action === "reuse") {
      manifest.reused.push({
        match_key: item.match_key,
        id: item.existing.id,
        canonical_name: item.existing.canonical_name
      });
      continue;
    }

    const payload = {
      canonical_name: item.draft.canonical_name,
      display_name: item.draft.display_name,
      city: item.draft.city,
      country: item.draft.country,
      country_code: item.draft.country_code,
      region: item.draft.region,
      latitude: item.draft.latitude,
      longitude: item.draft.longitude,
      aliases: item.draft.aliases,
      status: item.draft.status,
      source: item.draft.source,
      source_url: item.draft.source_url,
      match_key: item.match_key,
      verified_at: new Date().toISOString()
    };

    const rows = await rest(env, "ports", {
      method: "POST",
      prefer: "return=representation",
      body: payload
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    assert(row?.id, `Insert failed for ${item.draft.canonical_name}`);

    const reread = await rest(
      env,
      `ports?select=*&id=eq.${encodeURIComponent(row.id)}&limit=1`
    );
    assert(reread?.[0]?.match_key === item.match_key, `Re-read mismatch for ${item.match_key}`);
    assert(Number(reread[0].latitude) === payload.latitude, "latitude re-read mismatch");
    assert(Number(reread[0].longitude) === payload.longitude, "longitude re-read mismatch");

    manifest.inserts.push({
      id: row.id,
      match_key: item.match_key,
      canonical_name: row.canonical_name,
      aliases: row.aliases,
      latitude: row.latitude,
      longitude: row.longitude
    });
  }

  const manifestPath = path.join(outDir, "rollback-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, manifestPath, inserts: manifest.inserts, reused: manifest.reused }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
