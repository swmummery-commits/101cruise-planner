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
  resolveCompoundLabelPort,
  isAmbiguousWithoutCountryContext
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
    if (isAmbiguousWithoutCountryContext(portName, ranked)) {
      return { row: null, method: "ambiguous", candidates: exactCanonical, ranked: ranked.map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score })) };
    }
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
    if (isAmbiguousWithoutCountryContext(portName, ranked)) {
      return {
        row: null,
        method: "ambiguous_alias",
        candidates: aliasHits,
        ranked: ranked.map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
      };
    }
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
    if (isAmbiguousWithoutCountryContext(portName, ranked)) {
      return {
        row: null,
        method: "ambiguous",
        candidates: ranked.map((r) => r.row),
        ranked: ranked.slice(0, 5).map((r) => ({ id: r.row.id, name: r.row.canonical_name, score: r.score }))
      };
    }
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

function parseQueryCountry(portName) {
  const parts = String(portName || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return { namePart: String(portName || "").trim(), countryPart: "" };
  return { namePart: parts.slice(0, -1).join(", "), countryPart: parts[parts.length - 1] };
}

function lookupCatalogueIdentity(portName, allRows) {
  const rows = (allRows || []).map((row) => ({
    ...row,
    hero_media_id: row.hero_media_id || "identity-only",
    image_status: row.image_status || "AUTO_APPROVED"
  }));

  const compound = resolveCompoundLabelPort(portName, rows);
  if (compound) return { row: compound, method: "compound_label" };

  const target = normaliseEntityKey(portName);
  const exactCanonical = rows.filter((row) => normaliseEntityKey(row.canonical_name) === target);
  if (exactCanonical.length === 1) return { row: exactCanonical[0], method: "exact_canonical" };

  const aliasHits = rows.filter((row) =>
    (Array.isArray(row.aliases) ? row.aliases : []).some((a) => normaliseEntityKey(a) === target)
  );
  if (aliasHits.length === 1) return { row: aliasHits[0], method: "alias" };

  const { namePart, countryPart } = parseQueryCountry(portName);
  const nameTarget = normaliseEntityKey(namePart);
  const countryTarget = normaliseEntityKey(countryPart);
  if (nameTarget && countryTarget) {
    const contextual = rows.filter((row) => {
      const nameHit =
        normaliseEntityKey(row.canonical_name) === nameTarget ||
        (Array.isArray(row.aliases) ? row.aliases : []).some((a) => normaliseEntityKey(a) === nameTarget);
      return nameHit && normaliseEntityKey(row.country) === countryTarget;
    });
    if (contextual.length === 1) return { row: contextual[0], method: "contextual_alias" };
  }

  const ranked = rankCataloguePortMatches(portName, rows);
  if (ranked.length) {
    if (isAmbiguousWithoutCountryContext(portName, ranked)) {
      return { row: null, method: "ambiguous" };
    }
    return { row: ranked[0].row, method: "ranked" };
  }

  return { row: null, method: "unresolved" };
}

function matchesExpect(row, expect) {
  if (expect === null) return !row;
  if (!row || !expect) return false;
  return Object.entries(expect).every(([k, v]) => String(row[k] || "") === String(v));
}

const KNOWN_CHECKS = [
  { query: "Sydney", canonical: { canonical_name: "Sydney", country: "Australia" }, public: { canonical_name: "Sydney", country: "Australia" } },
  { query: "Sydney (Nova Scotia)", canonical: { canonical_name: "Sydney Nova Scotia", country: "Canada" }, public: { canonical_name: "Sydney Nova Scotia", country: "Canada" } },
  { query: "Newcastle", canonical: { canonical_name: "Newcastle", country: "Australia" }, public: { canonical_name: "Newcastle", country: "Australia" } },
  { query: "Newcastle upon Tyne", canonical: { canonical_name: "Newcastle upon Tyne", country: "United Kingdom" }, public: { canonical_name: "Newcastle upon Tyne", country: "United Kingdom" } },
  { query: "Saint John", canonical: { canonical_name: "Saint John", country: "Canada" }, public: { canonical_name: "Saint John", country: "Canada" } },
  { query: "Saint John, New Brunswick", canonical: { canonical_name: "Saint John", country: "Canada" }, public: { canonical_name: "Saint John", country: "Canada" } },
  { query: "St John's", canonical: null, public: null, note: "ambiguous bare name (Newfoundland vs Antigua)" },
  { query: "St Johns Newfoundland", canonical: { canonical_name: "St Johns Newfoundland", country: "Canada" }, public: { canonical_name: "St Johns Newfoundland", country: "Canada" } },
  { query: "St John's, Newfoundland", canonical: { canonical_name: "St Johns Newfoundland", country: "Canada" }, public: { canonical_name: "St Johns Newfoundland", country: "Canada" } },
  { query: "St John's, Antigua", canonical: { canonical_name: "St Johns Antigua", country: "Antigua and Barbuda" }, public: { canonical_name: "St Johns Antigua", country: "Antigua and Barbuda" } },
  { query: "St Johns Antigua", canonical: { canonical_name: "St Johns Antigua", country: "Antigua and Barbuda" }, public: { canonical_name: "St Johns Antigua", country: "Antigua and Barbuda" } },
  { query: "Victoria BC", canonical: { canonical_name: "Victoria BC", country: "Canada" }, public: { canonical_name: "Victoria BC", country: "Canada" } },
  { query: "Albany", canonical: { canonical_name: "Albany", country: "Australia" }, public: { canonical_name: "Albany", country: "Australia" } },
  { query: "Tokyo", canonical: { canonical_name: "Tokyo", country: "Japan" }, public: { canonical_name: "Tokyo", country: "Japan" } },
  { query: "Yokohama", canonical: { canonical_name: "Yokohama", country: "Japan" }, public: { canonical_name: "Yokohama", country: "Japan" } },
  { query: "Tokyo / Yokohama", canonical: { canonical_name: "Yokohama", country: "Japan" }, public: { canonical_name: "Yokohama", country: "Japan" } },
  { query: "Vancouver", canonical: { canonical_name: "Vancouver", country: "Canada" }, public: { canonical_name: "Vancouver", country: "Canada" } },
  { query: "Southampton", canonical: { canonical_name: "Southampton", country: "United Kingdom" }, public: { canonical_name: "Southampton", country: "United Kingdom" } },
  { query: "Miami", canonical: { canonical_name: "Miami", country: "United States", region: "Florida" }, public: { canonical_name: "Miami", country: "United States", region: "Florida" } },
  { query: "Fort Lauderdale", canonical: { canonical_name: "Fort Lauderdale", country: "United States" }, public: null, note: "catalogue record; no approved public image" },
  { query: "Palma de Mallorca", canonical: { canonical_name: "Palma de Mallorca" }, public: { canonical_name: "Palma de Mallorca" } },
  { query: "Valencia", canonical: { canonical_name: "Valencia", country: "Spain" }, public: { canonical_name: "Valencia", country: "Spain" } },
  { query: "Rome (Civitavecchia)", canonical: { canonical_name: "Civitavecchia", country: "Italy" }, public: { canonical_name: "Civitavecchia", country: "Italy" } },
  { query: "Civitavecchia", canonical: { canonical_name: "Civitavecchia", country: "Italy" }, public: { canonical_name: "Civitavecchia", country: "Italy" } },
  { query: "Port Chalmers", canonical: { canonical_name: "Port Chalmers", country: "New Zealand" }, public: { canonical_name: "Port Chalmers", country: "New Zealand" } },
  { query: "Dunedin / Port Chalmers", canonical: { canonical_name: "Port Chalmers", country: "New Zealand" }, public: { canonical_name: "Port Chalmers", country: "New Zealand" } },
  { query: "Costa Maya", canonical: { canonical_name: "Costa Maya", country: "Mexico" }, public: null, note: "correct identity; no approved public image" },
  { query: "Mahahual", canonical: { canonical_name: "Costa Maya", country: "Mexico" }, public: null, note: "alias identity; no approved public image" },
  { query: "Mahahual, Mexico", canonical: { canonical_name: "Costa Maya", country: "Mexico" }, public: null, note: "alias identity with country; no approved public image" },
  { query: "Ensenada", canonical: { canonical_name: "Ensenada", country: "Mexico" }, public: null, note: "catalogue record; excluded from approved public image resolver" }
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
  const allCatalogueRows = await fetchAllPaginated(
    root,
    "ports?select=id,canonical_name,display_name,city,country,country_code,region,aliases,match_key,hero_media_id,image_status"
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
    const identity = lookupCatalogueIdentity(check.query, allCatalogueRows);
    const publicResult = lookupCataloguePortWithMethod(check.query, index, approvedRows);
    const canonicalOk = matchesExpect(identity.row, check.canonical);
    const publicOk = matchesExpect(publicResult.row, check.public);
    let category = "correct_canonical_resolution";
    if (check.canonical === null && check.public === null && canonicalOk && publicOk) {
      category = "correct_unresolved_ambiguity";
    } else if (canonicalOk && check.public === null && !publicResult.row) {
      category = "correct_canonical_no_public_image";
    } else if (!canonicalOk) {
      category = "wrong_canonical_resolution";
    } else if (canonicalOk && !publicOk && check.public !== null) {
      category = "wrong_public_media_resolution";
    } else if (canonicalOk && !publicOk && check.public === null && publicResult.row) {
      category = "wrong_public_media_resolution";
    }
    return {
      query: check.query,
      note: check.note || null,
      category,
      canonical_ok: canonicalOk,
      public_ok: publicOk,
      ok: canonicalOk && publicOk,
      identity: identity.row
        ? {
            port_id: identity.row.id,
            canonical_name: identity.row.canonical_name,
            country: identity.row.country,
            image_status: identity.row.image_status,
            method: identity.method
          }
        : { method: identity.method, resolved: false },
      public: portDto(publicResult.row, publicResult.method, {
        ranked: publicResult.ranked,
        candidate_count: publicResult.candidates?.length || 0
      }),
      expected: { canonical: check.canonical, public: check.public }
    };
  });

  const knownSummary = {
    correct_canonical_resolutions: knownVerification.filter((c) =>
      ["correct_canonical_resolution", "correct_canonical_no_public_image"].includes(c.category)
    ).length,
    correct_unresolved_ambiguities: knownVerification.filter((c) => c.category === "correct_unresolved_ambiguity").length,
    correct_canonical_no_public_image: knownVerification.filter((c) => c.category === "correct_canonical_no_public_image").length,
    wrong_canonical_resolutions: knownVerification.filter((c) => c.category === "wrong_canonical_resolution").length,
    wrong_public_media_resolutions: knownVerification.filter((c) => c.category === "wrong_public_media_resolution").length
  };

  const wrongCanonical = knownVerification.filter((c) => c.category === "wrong_canonical_resolution");
  const wrongPublicMedia = knownVerification.filter((c) => c.category === "wrong_public_media_resolution");

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
      known_check_summary: knownSummary,
      wrong_canonical_resolutions: knownSummary.wrong_canonical_resolutions,
      wrong_public_media_resolutions: knownSummary.wrong_public_media_resolutions,
      explore_port_cards_checked: cardsChecked,
      canonical_media_mismatches: mismatches,
      unresolved_port_cards: unresolvedCards
    },
    distinct_resolutions: distinctResolutions,
    compound_port_labels: compoundLabels,
    ambiguous_lookup_keys: ambiguousWithWinner,
    known_verification: knownVerification,
    wrong_canonical_resolutions: wrongCanonical,
    wrong_public_media_resolutions: wrongPublicMedia,
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
  console.log("Known summary:", JSON.stringify(report.summary.known_check_summary));
  console.log("Wrong canonical:", report.summary.wrong_canonical_resolutions);
  console.log("Wrong public media:", report.summary.wrong_public_media_resolutions);
  console.log("Explore cards checked:", report.summary.explore_port_cards_checked);
  console.log("Canonical/media mismatches:", report.summary.canonical_media_mismatches);
  console.log("Report:", out);
  if (wrongCanonical.length) {
    console.log("\nWrong canonical resolutions:");
    for (const w of wrongCanonical) console.log(" ", JSON.stringify({ query: w.query, identity: w.identity, expected: w.expected.canonical }));
  }
  if (wrongPublicMedia.length) {
    console.log("\nWrong public media resolutions:");
    for (const w of wrongPublicMedia) console.log(" ", JSON.stringify({ query: w.query, public: w.public, expected: w.expected.public }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
