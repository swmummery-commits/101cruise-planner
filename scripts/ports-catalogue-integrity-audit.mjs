#!/usr/bin/env node
/**
 * Read-only (or --apply) canonical ports catalogue integrity audit.
 *
 *   node scripts/ports-catalogue-integrity-audit.mjs
 *   node scripts/ports-catalogue-integrity-audit.mjs --json reports/ports-catalogue-integrity-audit.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, fetchAllPaginated } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findDuplicateCanonicalPorts, normalizeIdentity } = require(path.join(
  root,
  "scripts/lib/port-canonical-integrity.cjs"
));

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,latitude,longitude,aliases,status,match_key,source,source_url,source_featured_cruise_id,verified_at,created_at,updated_at,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at";

const REFERENCE_TABLES = [
  { table: "featured_cruise_itinerary_stops", column: "port_id" },
  { table: "cruise_sailings", column: "departure_port_id" },
  { table: "cruise_sailings", column: "arrival_port_id" },
  { table: "cruise_sailing_itinerary", column: "port_id" }
];

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseAliases(raw) {
  if (Array.isArray(raw)) return raw.map((a) => String(a || "").trim()).filter(Boolean);
  return [];
}

function isSuspiciousName(name) {
  const n = String(name || "").trim();
  if (!n) return { suspicious: true, reason: "blank" };
  if (/^\d+$/.test(n)) return { suspicious: true, reason: "numeric" };
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(n)) return { suspicious: true, reason: "month" };
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(n)) {
    return { suspicious: true, reason: "month" };
  }
  if (/\b(20\d{2}|19\d{2})\b/.test(n) && n.length < 20) return { suspicious: true, reason: "year_or_date" };
  if (/\b\d+\s*(nights?|days?)\b/i.test(n)) return { suspicious: true, reason: "duration" };
  if (/\b(embark|disembark|at sea|sea day)\b/i.test(n)) return { suspicious: true, reason: "itinerary_label" };
  if (/^airport\b/i.test(n)) return { suspicious: true, reason: "airport" };
  return { suspicious: false, reason: null };
}

function coordKey(lat, lon) {
  if (lat == null || lon == null) return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return `${la.toFixed(3)}|${lo.toFixed(3)}`;
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function imageRank(status) {
  const s = String(status || "").toUpperCase();
  if (s === "MANUAL") return 4;
  if (s === "AUTO_APPROVED") return 3;
  if (s === "NEEDS_REVIEW") return 2;
  if (s === "NO_IMAGE") return 1;
  return 0;
}

function pickCanonicalKeep(group) {
  return [...group].sort((a, b) => {
    const ir = imageRank(b.image_status) - imageRank(a.image_status);
    if (ir) return ir;
    const vr = (b.status === "verified" ? 1 : 0) - (a.status === "verified" ? 1 : 0);
    if (vr) return vr;
    if (a.hero_media_id && !b.hero_media_id) return -1;
    if (b.hero_media_id && !a.hero_media_id) return 1;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  })[0];
}

async function countReferences(rest, portId) {
  const counts = {};
  for (const { table, column } of REFERENCE_TABLES) {
    try {
      const rows = await rest.get(
        `${table}?select=id&${column}=eq.${encodeURIComponent(portId)}&limit=1000`
      );
      counts[`${table}.${column}`] = Array.isArray(rows) ? rows.length : 0;
    } catch (error) {
      if (/schema cache|PGRST205|Could not find the table/i.test(String(error.message || ""))) {
        counts[`${table}.${column}`] = 0;
        continue;
      }
      throw error;
    }
  }
  counts.total = Object.values(counts).reduce((s, n) => s + n, 0);
  return counts;
}

async function loadAllReferences(rest) {
  const refs = {};
  for (const { table, column } of REFERENCE_TABLES) {
    try {
      const rows = await fetchAllPaginated(root, `${table}?select=id,${column}&${column}=not.is.null`);
      refs[`${table}.${column}`] = rows || [];
    } catch (error) {
      if (/schema cache|PGRST205|Could not find the table/i.test(String(error.message || ""))) {
        refs[`${table}.${column}`] = [];
        refs[`${table}.${column}__missing`] = true;
        continue;
      }
      throw error;
    }
  }
  return refs;
}

async function loadMedia(rest, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const rows = await rest.get(
      `media_library?select=id,title,public_url,media_type,is_active&id=in.(${chunk.join(",")})`
    );
    for (const row of rows || []) map.set(row.id, row);
  }
  return map;
}

async function main() {
  const rest = createSupabaseRest(root);
  const ports = await fetchAllPaginated(root, `ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc`);
  const portIds = new Set(ports.map((p) => p.id));
  const refs = await loadAllReferences(rest);

  const imageStatusCounts = {};
  for (const p of ports) {
    const s = String(p.image_status || "NULL").toUpperCase();
    imageStatusCounts[s] = (imageStatusCounts[s] || 0) + 1;
  }

  const exactNameCountry = new Map();
  for (const p of ports) {
    const k = `${norm(p.canonical_name)}|${norm(p.country)}`;
    if (!exactNameCountry.has(k)) exactNameCountry.set(k, []);
    exactNameCountry.get(k).push(p);
  }
  const exactDuplicates = [...exactNameCountry.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([k, g]) => ({ key: k, ports: g }));

  const matchKeyGroups = new Map();
  for (const p of ports) {
    const mk = String(p.match_key || "").trim();
    if (!mk) continue;
    if (!matchKeyGroups.has(mk)) matchKeyGroups.set(mk, []);
    matchKeyGroups.get(mk).push(p);
  }
  const matchKeyDuplicates = [...matchKeyGroups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([k, g]) => ({ key: k, ports: g }));

  const blankMatchKeys = ports.filter((p) => !String(p.match_key || "").trim());
  const duplicateMatchKeysInDb = matchKeyDuplicates;

  const aliasCollisions = [];
  const canonicalNames = new Map(ports.map((p) => [norm(p.canonical_name), p]));
  for (const p of ports) {
    for (const alias of parseAliases(p.aliases)) {
      const an = norm(alias);
      if (!an) continue;
      const owner = canonicalNames.get(an);
      if (owner && owner.id !== p.id) {
        aliasCollisions.push({
          alias,
          aliasOwner: { id: p.id, canonical_name: p.canonical_name, country: p.country },
          canonicalOwner: { id: owner.id, canonical_name: owner.canonical_name, country: owner.country }
        });
      }
    }
  }

  const sameNameGroups = new Map();
  for (const p of ports) {
    const n = norm(p.canonical_name);
    if (!n) continue;
    if (!sameNameGroups.has(n)) sameNameGroups.set(n, []);
    sameNameGroups.get(n).push(p);
  }
  const sameNameDifferentCountry = [...sameNameGroups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([name, g]) => ({ name, ports: g }));

  const coordGroups = new Map();
  for (const p of ports) {
    const ck = coordKey(p.latitude, p.longitude);
    if (!ck) continue;
    if (!coordGroups.has(ck)) coordGroups.set(ck, []);
    coordGroups.get(ck).push(p);
  }
  const coordDuplicates = [...coordGroups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([k, g]) => ({ coord: k, ports: g }));

  const suspicious = [];
  for (const p of ports) {
    const check = isSuspiciousName(p.canonical_name);
    if (check.suspicious) {
      const refCounts = await countReferences(rest, p.id);
      suspicious.push({ ...p, reason: check.reason, references: refCounts });
    }
  }

  const coordIssues = {
    nullCoords: ports.filter((p) => p.latitude == null || p.longitude == null),
    zeroZero: ports.filter((p) => Number(p.latitude) === 0 && Number(p.longitude) === 0),
    swappedSuspect: ports.filter((p) => {
      const la = Number(p.latitude);
      const lo = Number(p.longitude);
      return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) > 90;
    })
  };

  const geoContradictions = [];
  for (const p of ports) {
    const issues = [];
    const country = norm(p.country);
    const region = norm(p.region);
    const city = norm(p.city);
    if (country && city && city === country) issues.push("city_equals_country");
    if (region && country && region.includes("alaska") && !country.includes("united states") && country !== "usa") {
      issues.push("alaska_region_country_mismatch");
    }
    if (p.country_code && p.country) {
      const cc = String(p.country_code).toUpperCase();
      if (cc === "US" && !/united states|usa|u\.s\./i.test(String(p.country))) {
        issues.push("country_code_us_mismatch");
      }
    }
    if (issues.length) geoContradictions.push({ id: p.id, canonical_name: p.canonical_name, country: p.country, region: p.region, city: p.city, issues });
  }

  const brokenMedia = [];
  const mediaIds = ports.map((p) => p.hero_media_id).filter(Boolean);
  const mediaMap = await loadMedia(rest, mediaIds);
  for (const p of ports) {
    if (!p.hero_media_id) continue;
    const media = mediaMap.get(p.hero_media_id);
    if (!media) brokenMedia.push({ id: p.id, canonical_name: p.canonical_name, hero_media_id: p.hero_media_id, issue: "missing_media_row" });
    else if (!media.public_url) brokenMedia.push({ id: p.id, canonical_name: p.canonical_name, hero_media_id: p.hero_media_id, issue: "missing_public_url" });
    else if (media.is_active === false) brokenMedia.push({ id: p.id, canonical_name: p.canonical_name, hero_media_id: p.hero_media_id, issue: "inactive_media" });
  }

  const orphanedRefs = [];
  for (const [key, rows] of Object.entries(refs)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const col = key.split(".")[1];
      const pid = row[col];
      if (pid && !portIds.has(pid)) orphanedRefs.push({ table: key, row_id: row.id, port_id: pid });
    }
  }

  const duplicateFinder = findDuplicateCanonicalPorts(ports);

  const miami = ports.filter((p) => /miami/i.test(p.canonical_name));
  const fortLauderdale = ports.filter((p) => /fort lauderdale/i.test(p.canonical_name));

  const protectedSameName = sameNameDifferentCountry.filter(({ name }) =>
    ["sydney", "newcastle", "saint john", "st john", "st johns", "victoria", "albany", "palma", "southampton", "darwin"].some(
      (x) => name.includes(x) || name === x
    )
  );

  const customerDestPairs = [
    "Civitavecchia",
    "Port Chalmers",
    "Benoa",
    "Phu My",
    "Laem Chabang",
    "Keelung",
    "San Pedro",
    "Chan May",
    "Mahahual",
    "Athinios",
    "Santorini",
    "Yokohama",
    "Tokyo",
    "Los Angeles",
    "Dunedin",
    "Bangkok",
    "Ho Chi Minh",
    "Da Nang",
    "Costa Maya",
    "Livorno",
    "Florence",
    "Valencia",
    "Palma"
  ].map((term) => ({
    term,
    matches: ports.filter(
      (p) =>
        norm(p.canonical_name).includes(norm(term)) ||
        parseAliases(p.aliases).some((a) => norm(a).includes(norm(term))) ||
        norm(p.display_name || "").includes(norm(term))
    )
  }));

  const report = {
    generated_at: new Date().toISOString(),
    starting: {
      total_ports: ports.length,
      image_status_counts: imageStatusCounts,
      status_counts: ports.reduce((acc, p) => {
        acc[p.status || "null"] = (acc[p.status || "null"] || 0) + 1;
        return acc;
      }, {})
    },
    reference_tables: REFERENCE_TABLES.map((r) => r.table + "." + r.column),
    duplicates: {
      exact_name_country: exactDuplicates,
      match_key: matchKeyDuplicates,
      identity_finder: duplicateFinder,
      same_name_different_country: sameNameDifferentCountry,
      coord_rounded: coordDuplicates
    },
    alias_collisions: aliasCollisions,
    suspicious_records: suspicious,
    match_key: {
      blank: blankMatchKeys.map((p) => ({ id: p.id, canonical_name: p.canonical_name, country: p.country })),
      duplicates: duplicateMatchKeysInDb
    },
    coordinates: {
      null_count: coordIssues.nullCoords.length,
      zero_zero: coordIssues.zeroZero.map((p) => ({ id: p.id, canonical_name: p.canonical_name })),
      swapped_suspect: coordIssues.swappedSuspect.map((p) => ({ id: p.id, canonical_name: p.canonical_name, lat: p.latitude, lon: p.longitude })),
      duplicate_coords: coordDuplicates
    },
    geography_contradictions: geoContradictions,
    media_integrity: { broken: brokenMedia },
    orphaned_references: orphanedRefs,
    miami_fort_lauderdale: { miami, fortLauderdale },
    protected_same_name_groups: protectedSameName,
    customer_destination_mappings: customerDestPairs,
    consolidation_candidates: []
  };

  for (const dup of [...exactDuplicates, ...matchKeyDuplicates]) {
    const keep = pickCanonicalKeep(dup.ports);
    const remove = dup.ports.filter((p) => p.id !== keep.id);
    for (const r of remove) {
      const refCounts = await countReferences(rest, r.id);
      report.consolidation_candidates.push({
        reason: dup.key,
        keep: { id: keep.id, canonical_name: keep.canonical_name, country: keep.country, image_status: keep.image_status },
        remove: { id: r.id, canonical_name: r.canonical_name, country: r.country, image_status: r.image_status },
        references: refCounts
      });
    }
  }

  const jsonArgIdx = process.argv.indexOf("--json");
  const jsonPath =
    process.argv.find((a) => a.startsWith("--json="))?.slice(7) ||
    (jsonArgIdx >= 0 ? process.argv[jsonArgIdx + 1] : null) ||
    (process.argv.includes("--json") ? "reports/ports-catalogue-integrity-audit-pre.json" : null);

  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.join(root, jsonPath)), { recursive: true });
    fs.writeFileSync(path.join(root, jsonPath), JSON.stringify(report, null, 2));
  }

  console.log("=== PORTS CATALOGUE INTEGRITY AUDIT ===");
  console.log("Total ports:", report.starting.total_ports);
  console.log("Image status:", JSON.stringify(report.starting.image_status_counts));
  console.log("Exact name+country duplicates:", exactDuplicates.length);
  console.log("Match key duplicates:", matchKeyDuplicates.length);
  console.log("Identity finder duplicates:", duplicateFinder.length);
  console.log("Alias collisions:", aliasCollisions.length);
  console.log("Suspicious records:", suspicious.length, suspicious.map((s) => s.canonical_name));
  console.log("Blank match_keys:", blankMatchKeys.length);
  console.log("Null coords:", coordIssues.nullCoords.length);
  console.log("Coord duplicates (3dp):", coordDuplicates.length);
  console.log("Broken media links:", brokenMedia.length);
  console.log("Orphaned refs:", orphanedRefs.length);
  console.log("Consolidation candidates:", report.consolidation_candidates.length);
  console.log("Miami records:", miami.length, miami.map((p) => `${p.canonical_name}|${p.country}`));
  console.log("Fort Lauderdale records:", fortLauderdale.length, fortLauderdale.map((p) => `${p.canonical_name}|${p.country}`));
  if (jsonPath) console.log("Report written:", jsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
