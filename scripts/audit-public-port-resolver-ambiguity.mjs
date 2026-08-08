#!/usr/bin/env node
/**
 * Read-only public port resolver ambiguity audit.
 *   node scripts/audit-public-port-resolver-ambiguity.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, fetchAllPaginated } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  indexPortsCatalogue,
  nameKeysForLookup,
  portLookupKeys,
  hasValidPortImage,
  rankCataloguePortMatches,
  resolveCompoundLabelPort
} = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));
const { normaliseEntityKey } = require(path.join(root, "netlify/functions/lib/research-normalize.js"));

function loadDestinationContent() {
  const src = fs.readFileSync(path.join(root, "public-tools/cruise-finder/destination-content.js"), "utf8");
  const match = src.match(/const CONTENT = (\{[\s\S]*?\n  \});/);
  if (!match) throw new Error("Could not parse destination-content.js");
  return eval("(" + match[1] + ")");
}

function lookupCataloguePortWithMethod(portName, catalogueIndex, catalogueRows) {
  const target = normaliseEntityKey(portName);
  if (!target) return { row: null, method: "unresolved", candidates: [] };

  const rows = Array.isArray(catalogueRows) && catalogueRows.length
    ? catalogueRows.filter(hasValidPortImage)
    : [...catalogueIndex.values()];

  const compoundHit = resolveCompoundLabelPort(portName, rows);
  if (compoundHit) {
    return { row: compoundHit, method: "compound_label", candidates: [compoundHit] };
  }

  const exactCanonical = rows.filter((row) => normaliseEntityKey(row.canonical_name) === target);
  if (exactCanonical.length === 1) {
    return { row: exactCanonical[0], method: "exact_canonical", candidates: exactCanonical };
  }
  if (exactCanonical.length > 1) {
    const ranked = rankCataloguePortMatches(portName, exactCanonical);
    return {
      row: ranked[0]?.row || exactCanonical[0],
      method: "ranked_disambiguated",
      candidates: exactCanonical,
      ranked: ranked.map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
    };
  }

  const exactDisplay = rows.filter((row) => normaliseEntityKey(row.display_name) === target);
  if (exactDisplay.length === 1) {
    return { row: exactDisplay[0], method: "exact_display", candidates: exactDisplay };
  }

  const aliasHits = rows.filter((row) =>
    (Array.isArray(row.aliases) ? row.aliases : []).some((a) => normaliseEntityKey(a) === target)
  );
  if (aliasHits.length === 1) {
    return { row: aliasHits[0], method: "alias", candidates: aliasHits };
  }
  if (aliasHits.length > 1) {
    const ranked = rankCataloguePortMatches(portName, aliasHits);
    return {
      row: ranked[0]?.row || aliasHits[0],
      method: "ranked_disambiguated",
      candidates: aliasHits,
      ranked: ranked.map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
    };
  }

  const exactCity = rows.filter((row) => normaliseEntityKey(row.city) === target);
  if (exactCity.length === 1) {
    return { row: exactCity[0], method: "exact_city", candidates: exactCity };
  }

  const ranked = rankCataloguePortMatches(portName, rows);
  if (ranked.length) {
    return {
      row: ranked[0].row,
      method: ranked.length > 1 && ranked[0].score === ranked[1].score ? "ranked_tie" : "ranked_disambiguated",
      candidates: ranked.map((r) => r.row),
      ranked: ranked.slice(0, 5).map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
    };
  }

  for (const key of nameKeysForLookup(portName)) {
    const hits = rows.filter((row) => portLookupKeys(row).has(key));
    if (hits.length === 1) {
      return { row: hits[0], method: "index_key", candidates: hits, matched_key: key };
    }
    if (hits.length > 1) {
      const tieRank = rankCataloguePortMatches(portName, hits);
      return {
        row: tieRank[0]?.row || hits[0],
        method: "ranked_disambiguated",
        candidates: hits,
        matched_key: key,
        ranked: tieRank.map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
      };
    }
    const indexHit = catalogueIndex?.get(key);
    if (indexHit) {
      return { row: indexHit, method: "index_first_wins", candidates: [indexHit], matched_key: key };
    }
  }

  return { row: null, method: "unresolved", candidates: [] };
}

function portDto(row, method, extra = {}) {
  if (!row) return { method, resolved: false, ...extra };
  return {
    method,
    resolved: true,
    port_id: row.id,
    canonical_name: row.canonical_name,
    display_name: row.display_name,
    city: row.city,
    region: row.region,
    country: row.country,
    hero_media_id: row.hero_media_id,
    image_status: row.image_status,
    ...extra
  };
}

function findAmbiguousKeys(approvedRows) {
  const keyOwners = new Map();
  for (const row of approvedRows) {
    for (const key of portLookupKeys(row)) {
      if (!keyOwners.has(key)) keyOwners.set(key, []);
      const list = keyOwners.get(key);
      if (!list.some((p) => p.id === row.id)) list.push(row);
    }
  }
  const collisions = [];
  for (const [key, owners] of keyOwners.entries()) {
    if (owners.length <= 1) continue;
    collisions.push({
      lookup_term: key,
      candidates: owners.map((p) => ({
        id: p.id,
        canonical_name: p.canonical_name,
        country: p.country,
        image_status: p.image_status
      }))
    });
  }
  return collisions.sort((a, b) => a.lookup_term.localeCompare(b.lookup_term));
}

const KNOWN_CHECKS = [
  { query: "Sydney", expect: { canonical_name: "Sydney", country: "Australia" } },
  { query: "Sydney (Nova Scotia)", expect: { canonical_name: "Sydney Nova Scotia", country: "Canada" } },
  { query: "Newcastle", expect: { canonical_name: "Newcastle", country: "Australia" } },
  { query: "Newcastle upon Tyne", expect: { canonical_name: "Newcastle upon Tyne", country: "United Kingdom" } },
  { query: "Saint John", expect: { canonical_name: "Saint John", country: "Canada" } },
  { query: "St John's", expect: { canonical_name: "St John's", country: "Canada" } },
  { query: "Victoria BC", expect: { canonical_name: "Victoria BC", country: "Canada" } },
  { query: "Albany", expect: { canonical_name: "Albany", country: "Australia" } },
  { query: "Tokyo", expect: { canonical_name: "Tokyo", country: "Japan" } },
  { query: "Yokohama", expect: { canonical_name: "Yokohama", country: "Japan" } },
  { query: "Tokyo / Yokohama", expect: { canonical_name: "Yokohama", country: "Japan" } },
  { query: "Vancouver", expect: { canonical_name: "Vancouver", country: "Canada" } },
  { query: "Southampton", expect: { canonical_name: "Southampton", country: "United Kingdom" } },
  { query: "Miami", expect: { canonical_name: "Miami", country: "Florida" } },
  { query: "Fort Lauderdale", expect: null },
  { query: "Palma de Mallorca", expect: { canonical_name: "Palma de Mallorca" } },
  { query: "Valencia", expect: { canonical_name: "Valencia", country: "Spain" } },
  { query: "Rome (Civitavecchia)", expect: { canonical_name: "Civitavecchia", country: "Italy" } },
  { query: "Civitavecchia", expect: { canonical_name: "Civitavecchia", country: "Italy" } },
  { query: "Port Chalmers", expect: { canonical_name: "Port Chalmers", country: "New Zealand" } },
  { query: "Dunedin / Port Chalmers", expect: { canonical_name: "Port Chalmers", country: "New Zealand" } },
  { query: "Costa Maya", expect: null },
  { query: "Mahahual", expect: { canonical_name: "Costa Maya", country: "Mexico" } },
  { query: "Ensenada", expect: null }
];

async function fetchLiveMedia(slug, portNames) {
  const base = process.env.PUBLIC_MEDIA_BASE || "https://admirable-tiramisu-d4da8a.netlify.app";
  const params = new URLSearchParams({ slug });
  if (portNames.length) params.set("ports", portNames.join("|"));
  const res = await fetch(`${base}/.netlify/functions/public-destination-media?${params}`);
  if (!res.ok) return { error: res.status };
  return res.json();
}

async function main() {
  const rest = createSupabaseRest(root);
  const content = loadDestinationContent();
  const approvedRows = await fetchAllPaginated(
    root,
    "ports?hero_media_id=not.is.null&image_status=in.(MANUAL,AUTO_APPROVED)" +
      "&select=id,canonical_name,display_name,city,country,country_code,region,aliases,match_key,hero_media_id,image_status"
  );
  const index = indexPortsCatalogue(approvedRows);

  const publicNames = [];
  const byDestination = [];
  for (const [slug, cfg] of Object.entries(content)) {
    const names = [...new Set([...(cfg.popular_ports || []), ...(cfg.departure_ports || [])])];
    byDestination.push({ slug, names });
    publicNames.push(...names.map((n) => ({ name: n, slug })));
  }
  const distinctNames = [...new Set(publicNames.map((p) => p.name))];

  const compoundLabels = [];
  for (const [slug, cfg] of Object.entries(content)) {
    const names = [...new Set([...(cfg.popular_ports || []), ...(cfg.departure_ports || [])])];
    for (const label of names) {
      if (!/[/()]|&|\bvia\b/i.test(label)) continue;
      const result = lookupCataloguePortWithMethod(label, index, approvedRows);
      compoundLabels.push({
        destination_slug: slug,
        label,
        configured_canonical: cfg.port_canonical_names?.[label] || null,
        ...portDto(result.row, result.method)
      });
    }
  }

  const resolutions = [];
  for (const entry of publicNames) {
    const result = lookupCataloguePortWithMethod(entry.name, index, approvedRows);
    resolutions.push({
      destination_slug: entry.slug,
      requested_name: entry.name,
      ...portDto(result.row, result.method, {
        ranked: result.ranked,
        candidate_count: result.candidates?.length || 0,
        matched_key: result.matched_key || null
      })
    });
  }

  const distinctResolutions = distinctNames.map((name) => {
    const result = lookupCataloguePortWithMethod(name, index, approvedRows);
    return {
      requested_name: name,
      ...portDto(result.row, result.method, {
        ranked: result.ranked,
        candidate_count: result.candidates?.length || 0
      })
    };
  });

  const ambiguousKeys = findAmbiguousKeys(approvedRows);
  const ambiguousWithWinner = ambiguousKeys.map((c) => {
    const winner = lookupCataloguePortWithMethod(c.lookup_term.replace(/-/g, " "), index, approvedRows);
    return {
      lookup_term: c.lookup_term,
      candidate_1: c.candidates[0],
      candidate_2: c.candidates[1] || c.candidates[c.candidates.length - 1],
      all_candidates: c.candidates,
      current_winner: winner.row
        ? { id: winner.row.id, canonical_name: winner.row.canonical_name, method: winner.method }
        : null,
      enough_context_without_destination: c.candidates.every((p) => p.canonical_name !== c.lookup_term.replace(/-/g, " "))
    };
  });

  const knownVerification = KNOWN_CHECKS.map((check) => {
    const result = lookupCataloguePortWithMethod(check.query, index, approvedRows);
    const row = result.row;
    let ok = false;
    if (check.expect === null) ok = !row;
    else if (row && check.expect) {
      ok = Object.entries(check.expect).every(([k, v]) => String(row[k] || "") === String(v));
    }
    return {
      query: check.query,
      ok,
      ...portDto(row, result.method),
      expected: check.expect
    };
  });

  const wrongResolutions = [];
  for (const check of knownVerification) {
    if (!check.ok) {
      wrongResolutions.push({
        requested_port: check.query,
        wrong_canonical: check.canonical_name || null,
        wrong_port_id: check.port_id || null,
        correct_canonical: check.expected,
        cause: check.method
      });
    }
  }

  const mediaByPortId = new Map(approvedRows.map((p) => [p.hero_media_id, p.id]));
  const imageConsistency = [];
  let cardsChecked = 0;
  let mismatches = 0;
  let unresolvedCards = 0;

  for (const dest of byDestination) {
    const popular = content[dest.slug]?.popular_ports || [];
    if (!popular.length) continue;
    const live = await fetchLiveMedia(dest.slug, popular);
    const catalogue = live.catalogue_port_media || [];
    for (const name of popular) {
      cardsChecked++;
      const resolver = lookupCataloguePortWithMethod(name, index, approvedRows);
      const catEntry = catalogue.find((c) => c.port_name === name);
      if (!resolver.row) {
        unresolvedCards++;
        imageConsistency.push({ slug: dest.slug, port: name, status: "unresolved_no_image" });
        continue;
      }
      if (!catEntry) {
        unresolvedCards++;
        imageConsistency.push({ slug: dest.slug, port: name, status: "no_api_media", canonical_id: resolver.row.id });
        continue;
      }
      const mediaPortId = [...approvedRows, ...(await rest.get("ports?select=id,hero_media_id,image_status&image_status=in.(MANUAL,AUTO_APPROVED)&limit=2000"))].find(
        (p) => p.hero_media_id === catEntry.id
      )?.id;
      const ok = catEntry.id === resolver.row.hero_media_id;
      if (!ok) {
        mismatches++;
        imageConsistency.push({
          slug: dest.slug,
          port: name,
          status: "mismatch",
          resolver_port_id: resolver.row.id,
          resolver_canonical: resolver.row.canonical_name,
          media_id: catEntry.id,
          media_title: catEntry.title
        });
      }
    }
  }

  const destinationPorts = await fetchAllPaginated(
    root,
    "destination_ports?active=eq.true&select=id,name,slug,destination_id,hero_media_id"
  );

  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      public_port_name_usages: publicNames.length,
      distinct_public_port_names: distinctNames.length,
      ambiguous_lookup_keys: ambiguousKeys.length,
      resolved_public_names: distinctResolutions.filter((r) => r.resolved).length,
      unresolved_public_names: distinctResolutions.filter((r) => !r.resolved).length,
      known_checks_passed: knownVerification.filter((c) => c.ok).length,
      known_checks_total: knownVerification.length,
      wrong_resolutions: wrongResolutions.length,
      explore_port_cards_checked: cardsChecked,
      canonical_media_mismatches: mismatches,
      unresolved_port_cards: unresolvedCards
    },
    distinct_resolutions: distinctResolutions,
    compound_port_labels: compoundLabels,
    ambiguous_lookup_keys: ambiguousWithWinner,
    known_verification: knownVerification,
    wrong_resolutions: wrongResolutions,
    image_consistency_issues: imageConsistency.filter((x) => x.status !== undefined && x.status !== "unresolved_no_image"),
    destination_ports_architecture: {
      active_destination_port_rows: destinationPorts.length,
      rows_with_port_id_fk: 0,
      rows_with_hero_media_id: destinationPorts.filter((r) => r.hero_media_id).length,
      note: "destination_ports has no ports.id FK; Cruise Finder Explore uses destination-content.js names resolved via public-destination-media catalogue lookup"
    },
    resolutions_by_destination: resolutions
  };

  const out = path.join(root, "reports/public-port-resolver-ambiguity-audit.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log("=== PUBLIC PORT RESOLVER AMBIGUITY AUDIT ===");
  console.log("Distinct public port names:", report.summary.distinct_public_port_names);
  console.log("Resolved:", report.summary.resolved_public_names);
  console.log("Unresolved:", report.summary.unresolved_public_names);
  console.log("Ambiguous lookup keys:", report.summary.ambiguous_lookup_keys);
  console.log("Known checks:", report.summary.known_checks_passed + "/" + report.summary.known_checks_total);
  console.log("Wrong resolutions:", report.summary.wrong_resolutions);
  console.log("Explore cards checked:", report.summary.explore_port_cards_checked);
  console.log("Canonical/media mismatches:", report.summary.canonical_media_mismatches);
  console.log("Report:", out);
  if (wrongResolutions.length) {
    console.log("\nWrong resolutions:");
    for (const w of wrongResolutions) console.log(" ", JSON.stringify(w));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
