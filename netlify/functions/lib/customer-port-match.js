/**
 * Shared port matching for customer itinerary journey maps.
 * Mirrors customer-itinerary enrichment (canonical / display / city / aliases).
 */

"use strict";

function foldPortKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPortIndex(portRows) {
  const map = new Map();
  const metaByKey = new Map();
  for (const row of portRows || []) {
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const coords = { lat, lng };
    const meta = {
      id: row.id || null,
      canonical_name: row.canonical_name || null,
      display_name: row.display_name || null,
      city: row.city || null,
      country: row.country || null
    };
    const aliasFields = Array.isArray(row.aliases)
      ? row.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
      : [];
    for (const field of [row.canonical_name, row.display_name, row.city, ...aliasFields]) {
      const key = foldPortKey(field);
      if (!key || map.has(key)) continue;
      map.set(key, coords);
      metaByKey.set(key, meta);
    }
  }
  return { portsByKey: map, metaByKey };
}

function matchPortCoordinates(stopName, portsByKey) {
  const key = foldPortKey(stopName);
  if (!key) return null;
  if (portsByKey.has(key)) return portsByKey.get(key);

  const paren = String(stopName || "").match(/\(([^)]+)\)/);
  if (paren) {
    const inner = foldPortKey(paren[1]);
    if (portsByKey.has(inner)) return portsByKey.get(inner);
  }
  const head = foldPortKey(String(stopName || "").replace(/\([^)]*\)/g, " "));
  if (portsByKey.has(head)) return portsByKey.get(head);

  const hits = [];
  for (const [k, coords] of portsByKey.entries()) {
    if (!k || k.length < 3) continue;
    if (k.includes(key) || key.includes(k)) hits.push(coords);
  }
  const unique = [...new Map(hits.map((h) => [`${h.lat},${h.lng}`, h])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function diagnosePortMatch(stopName, portsByKey, metaByKey = new Map()) {
  const key = foldPortKey(stopName);
  if (!key) return { status: "unresolved", method: null, hit: null };

  if (portsByKey.has(key)) {
    return {
      status: "matched",
      method: "exact_folded_key",
      hit: portsByKey.get(key),
      meta: metaByKey.get(key) || null
    };
  }

  const paren = String(stopName || "").match(/\(([^)]+)\)/);
  if (paren) {
    const inner = foldPortKey(paren[1]);
    if (portsByKey.has(inner)) {
      return {
        status: "matched",
        method: "parenthetical_inner",
        hit: portsByKey.get(inner),
        meta: metaByKey.get(inner) || null
      };
    }
  }

  const head = foldPortKey(String(stopName || "").replace(/\([^)]*\)/g, " "));
  if (portsByKey.has(head)) {
    return {
      status: "matched",
      method: "parenthetical_outer_or_head",
      hit: portsByKey.get(head),
      meta: metaByKey.get(head) || null
    };
  }

  const hits = [];
  for (const [k, coords] of portsByKey.entries()) {
    if (!k || k.length < 3) continue;
    if (k.includes(key) || key.includes(k)) {
      hits.push({ key: k, coords, meta: metaByKey.get(k) || null });
    }
  }
  const unique = [...new Map(hits.map((h) => [`${h.coords.lat},${h.coords.lng}`, h])).values()];
  if (unique.length === 1) {
    return {
      status: "matched",
      method: "unique_containment",
      hit: unique[0].coords,
      meta: unique[0].meta
    };
  }
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      method: "containment",
      hit: null,
      candidates: unique.map((u) => ({
        key: u.key,
        canonical_name: u.meta?.canonical_name || null,
        lat: u.coords.lat,
        lng: u.coords.lng
      }))
    };
  }
  return { status: "unresolved", method: null, hit: null };
}

module.exports = {
  foldPortKey,
  buildPortIndex,
  matchPortCoordinates,
  diagnosePortMatch
};
