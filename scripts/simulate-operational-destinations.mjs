#!/usr/bin/env node
/**
 * Read-only per-sailing priority-line simulation with operational destination resolver.
 * Follows individual sailing URLs from listing pages — no candidate writes.
 *
 *   node scripts/simulate-operational-destinations.mjs
 *   node scripts/simulate-operational-destinations.mjs --cap=10
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { fetchSourceExcerpt } = require(path.join(root, "netlify/functions/lib/source-fetch"));
const {
  extractStructuredSailingSources,
  extractStructuredVoyages,
  structuredExcerptHint,
  canonicalUrl
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-structured"));
const { resolveOperationalDestination } = require(
  path.join(root, "netlify/functions/lib/discovery-destination-resolver")
);
const { buildCandidateFromSource } = require(path.join(root, "netlify/functions/lib/cruise-discovery"));
const { resolveShipForLine } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
const { provesIndividualSailing } = require(path.join(root, "netlify/functions/lib/discovery-non-sailing-filter"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(
  path.join(root, "netlify/functions/lib/destination-classification")
);

const PRIORITY_SLUGS = [
  "holland-america-line",
  "princess-cruises",
  "celebrity-cruises",
  "norwegian-cruise-line",
  "virgin-voyages",
  "atlas-cruises",
  "explora-journeys",
  "seabourn-cruise-line"
];

const fetchCache = new Map();

function parseArgs(argv) {
  const capArg = argv.find((a) => a.startsWith("--cap="));
  return { sailingCap: capArg ? Number(capArg.slice("--cap=".length)) || 10 : 10 };
}

function catalogueDestinations(dbDestinations) {
  const bySlug = Object.fromEntries((dbDestinations || []).map((d) => [d.slug, d]));
  return OPERATIONAL_DESTINATION_CATALOGUE.map((cat) => {
    const row = bySlug[cat.slug];
    return (
      row || {
        id: null,
        name: cat.name,
        slug: cat.slug,
        primary_region: cat.primary_region,
        status: cat.public_status,
        classification_enabled: cat.classification_enabled
      }
    );
  });
}

async function cachedFetch(url) {
  const key = canonicalUrl(url);
  if (fetchCache.has(key)) return fetchCache.get(key);
  const result = await fetchSourceExcerpt(url, {
    timeoutMs: 12000,
    maxExcerptChars: 600000,
    includeHtml: true
  });
  fetchCache.set(key, result);
  return result;
}

function sameOriginOrAllowed(url, line) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const roots = new Set();
    for (const raw of [line.cruise_search_url, line.website_url]) {
      if (!raw) continue;
      const h = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
      roots.add(h);
      const parts = h.split(".");
      if (parts.length >= 2) roots.add(parts.slice(-2).join("."));
    }
    for (const root of roots) {
      if (host === root || host.endsWith(`.${root}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function dedupeSailingUrls(urls, cap, line) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    if (!sameOriginOrAllowed(raw, line)) continue;
    const key = canonicalUrl(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= cap) break;
  }
  return out;
}

function extractPageTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function extractMetaDescription(html) {
  const m = String(html || "").match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

function classifyLineBlocker(result) {
  if (result.fetch_failures > 0 && result.individual_pages_fetched === 0) return "fetch_blocked";
  if (result.sailing_urls_found === 0) return "listing_links_not_individual_voyages";
  if (result.genuine_sailings === 0 && result.non_sailing_rejected > 0) return "listing_pages_not_sailings";
  if (result.genuine_sailings === 0 && result.structured_voyages_on_listing === 0) {
    return "page_requires_javascript_or_api";
  }
  if (result.complete_high_confidence === 0 && result.destination_unresolved > 0) return "destination_resolution_failed";
  if (result.complete_high_confidence === 0 && result.ship_resolution_failed > 0) return "ship_extraction_failed";
  if (result.complete_high_confidence === 0 && result.date_extraction_failed > 0) return "date_extraction_failed";
  if (result.complete_high_confidence === 0 && result.port_extraction_failed > 0) return "departure_port_extraction_failed";
  if (result.genuine_sailings === 0) return "no_genuine_current_sailings";
  return null;
}

async function processSailingPage({ url, line, lineShips, destinations }) {
  const fetched = await cachedFetch(url);
  if (!fetched.ok) {
    return { url, fetch_ok: false, fetch_error: fetched.error || "fetch_failed", rejected: true };
  }

  const html = fetched.html || "";
  const title = extractPageTitle(html);
  const description = extractMetaDescription(html);
  const excerpt = structuredExcerptHint(html);
  const voyages = extractStructuredVoyages(html, url);
  const structured = voyages.voyages?.[0] || null;

  const built = buildCandidateFromSource({
    title: structured?.title || title,
    description: structured?.description || description,
    url,
    excerpt,
    cruiseLine: line,
    ships: lineShips,
    destinations,
    preferredDestination: null,
    structuredVoyage: structured
  });

  if (!built || built.skip) {
    return {
      url,
      fetch_ok: true,
      title: structured?.title || title,
      rejected: true,
      reject_reason: built?.reason || "no_candidate",
      structured_source: structured?.source || null
    };
  }

  const candidate = built.candidate || {};
  const shipResolution = resolveShipForLine({
    rawShipName: candidate.ship_name_guess || structured?.ship_name,
    cruiseLineId: line.id,
    cruiseLineName: line.name,
    ships: lineShips,
    aliases: [],
    extract: { title, description, excerpt }
  });

  const dest = resolveOperationalDestination({
    title: candidate.raw_extract?.title || title,
    description: candidate.raw_extract?.description || description,
    itinerary: candidate.itinerary,
    structuredDestination: structured?.destination || null,
    departurePort: candidate.departure_port || structured?.departure_port,
    arrivalPort: structured?.arrival_port || null,
    nights: candidate.nights || structured?.nights,
    destinations
  });

  const individual = provesIndividualSailing({
    ship_id: candidate.ship_id || shipResolution.ship?.id,
    departure_date: candidate.departure_date || structured?.departure_date,
    departure_port: candidate.departure_port || structured?.departure_port,
    shipResolution,
    ships: lineShips,
    ship_name_guess: candidate.ship_name_guess
  });

  const complete =
    individual.proven &&
    dest.status === "resolved" &&
    dest.confidence === "high" &&
    (built.reasons || []).length === 0;

  return {
    url,
    fetch_ok: true,
    title: candidate.raw_extract?.title || title,
    rejected: false,
    voyage_id: structured?.voyage_id || null,
    ship_resolved: Boolean(candidate.ship_id || shipResolution.resolved),
    ship_name: shipResolution.ship?.name || candidate.ship_name_guess || structured?.ship_name,
    departure_date: candidate.departure_date || structured?.departure_date,
    departure_port: candidate.departure_port || structured?.departure_port,
    nights: candidate.nights || structured?.nights,
    destination_key: dest.destinationKey,
    destination_status: dest.status,
    destination_confidence: dest.confidence,
    complete_high_confidence: complete,
    validation_reasons: built.reasons || [],
    structured_source: structured?.source || null,
    individual_proven: individual.proven,
    individual_missing: individual.missing
  };
}

async function simulateLine(line, destinations, ships, sailingCap) {
  const sourceUrl = line.cruise_search_url || line.website_url;
  const lineShips = (ships || []).filter((s) => s.cruise_line_id === line.id);
  const result = {
    cruise_line: line.name,
    slug: line.slug,
    listing_url: sourceUrl,
    listing_fetched: false,
    sailing_urls_found: 0,
    individual_urls_deduped: 0,
    individual_pages_fetched: 0,
    fetch_failures: 0,
    structured_voyages_on_listing: 0,
    genuine_sailings: 0,
    complete_high_confidence: 0,
    incomplete_genuine: 0,
    ship_resolution_success: 0,
    ship_resolution_failed: 0,
    date_extraction_success: 0,
    date_extraction_failed: 0,
    port_extraction_success: 0,
    port_extraction_failed: 0,
    destination_resolved: 0,
    destination_ambiguous: 0,
    destination_unresolved: 0,
    duplicates_suppressed: 0,
    non_sailing_rejected: 0,
    projected_activations: 0,
    projected_maintenance: 0,
    projected_steve_reviews: 0,
    destination_counts: {},
    examples: [],
    primary_blocker: null,
    adapter_needed: null
  };

  if (!sourceUrl) {
    result.primary_blocker = "source_configuration_incorrect";
    result.adapter_needed = "missing_cruise_search_url";
    return result;
  }

  const listing = await cachedFetch(sourceUrl);
  result.listing_fetched = listing.ok;
  if (!listing.ok) {
    result.fetch_failures += 1;
    result.primary_blocker = "fetch_blocked";
    return result;
  }

  const structuredListing = extractStructuredSailingSources(listing.html, sourceUrl);
  const listingVoyages = extractStructuredVoyages(listing.html, sourceUrl);
  result.structured_voyages_on_listing = listingVoyages.voyages?.length || 0;
  result.sailing_urls_found = structuredListing.sailingUrls?.length || 0;

  const urlPool = [
    ...(listingVoyages.voyages || []).map((v) => v.url).filter(Boolean),
    ...(structuredListing.sailingUrls || [])
  ];
  const sailingUrls = dedupeSailingUrls(urlPool, sailingCap, line);
  result.individual_urls_deduped = sailingUrls.length;
  result.duplicates_suppressed = Math.max(0, urlPool.length - sailingUrls.length);

  for (const url of sailingUrls) {
    const page = await processSailingPage({ url, line, lineShips, destinations });
    if (!page.fetch_ok) {
      result.fetch_failures += 1;
      continue;
    }
    result.individual_pages_fetched += 1;

    if (page.rejected) {
      result.non_sailing_rejected += 1;
      continue;
    }

    result.genuine_sailings += 1;
    if (page.ship_resolved) result.ship_resolution_success += 1;
    else result.ship_resolution_failed += 1;
    if (page.departure_date) result.date_extraction_success += 1;
    else result.date_extraction_failed += 1;
    if (page.departure_port) result.port_extraction_success += 1;
    else result.port_extraction_failed += 1;

    if (page.destination_status === "resolved") {
      result.destination_resolved += 1;
      const key = page.destination_key || "unknown";
      result.destination_counts[key] = (result.destination_counts[key] || 0) + 1;
    } else if (page.destination_status === "ambiguous") {
      result.destination_ambiguous += 1;
      result.projected_steve_reviews += 1;
    } else {
      result.destination_unresolved += 1;
      result.projected_maintenance += 1;
    }

    if (page.complete_high_confidence) {
      result.complete_high_confidence += 1;
      result.projected_activations += 1;
    } else if (page.individual_proven) {
      result.incomplete_genuine += 1;
      if (page.destination_status !== "resolved") result.projected_maintenance += 1;
      else result.projected_steve_reviews += 1;
    }

    if (result.examples.length < 3) {
      result.examples.push({
        url: page.url,
        title: page.title,
        ship: page.ship_name,
        departure_date: page.departure_date,
        departure_port: page.departure_port,
        destination: page.destination_key,
        complete: page.complete_high_confidence
      });
    }
  }

  result.most_common_destination =
    Object.entries(result.destination_counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  result.primary_blocker = classifyLineBlocker(result);
  if (result.primary_blocker === "page_requires_javascript_or_api" && structuredListing.apiHints?.length) {
    result.adapter_needed = "official_api_endpoint_not_yet_parsed";
  } else if (result.primary_blocker === "listing_links_not_individual_voyages") {
    result.adapter_needed = "specialised_listing_adapter";
  }
  return result;
}

async function main() {
  const { sailingCap } = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const [lines, dbDest, ships] = await Promise.all([
    sb.get(
      `ci_cruise_lines?slug=in.(${PRIORITY_SLUGS.map((s) => encodeURIComponent(s)).join(",")})&select=id,name,slug,website_url,cruise_search_url`
    ),
    sb.get("destinations?select=id,name,slug,status,primary_region"),
    sb.get("ci_cruise_ships?active=eq.true&select=id,name,cruise_line_id&limit=5000")
  ]);

  const destinations = catalogueDestinations(dbDest);
  const perLine = [];
  for (const line of lines || []) {
    process.stderr.write(`Simulating ${line.name} (up to ${sailingCap} sailings)…\n`);
    perLine.push(await simulateLine(line, destinations, ships, sailingCap));
  }

  const totalComplete = perLine.reduce((a, r) => a + r.complete_high_confidence, 0);
  const totalGenuine = perLine.reduce((a, r) => a + r.genuine_sailings, 0);
  const totalResolved = perLine.reduce((a, r) => a + r.destination_resolved, 0);
  const linesWithSailings = perLine.filter((r) => r.genuine_sailings > 0).length;
  const resolutionRate =
    totalGenuine > 0 ? Math.round((totalResolved / totalGenuine) * 1000) / 10 : 0;

  const acceptanceGate = {
    four_lines_with_sailings: linesWithSailings >= 4,
    twenty_five_complete_sailings: totalComplete >= 25,
    destination_resolution_80pct: resolutionRate >= 80,
    steve_reviews_lte_5: perLine.reduce((a, r) => a + r.projected_steve_reviews, 0) <= 5,
    passed:
      linesWithSailings >= 4 &&
      totalComplete >= 25 &&
      resolutionRate >= 80 &&
      perLine.reduce((a, r) => a + r.projected_steve_reviews, 0) <= 5
  };

  const summary = {
    lines: perLine.length,
    sailing_cap_per_line: sailingCap,
    lines_with_genuine_sailings: linesWithSailings,
    total_genuine_sailings: totalGenuine,
    total_complete_high_confidence: totalComplete,
    destination_resolution_rate_pct: resolutionRate,
    total_resolved: totalResolved,
    total_ambiguous: perLine.reduce((a, r) => a + r.destination_ambiguous, 0),
    total_unresolved: perLine.reduce((a, r) => a + r.destination_unresolved, 0),
    projected_activations: perLine.reduce((a, r) => a + r.projected_activations, 0),
    projected_maintenance: perLine.reduce((a, r) => a + r.projected_maintenance, 0),
    projected_steve_reviews: perLine.reduce((a, r) => a + r.projected_steve_reviews, 0),
    acceptance_gate: acceptanceGate,
    alaska_only_model: "Would assign Alaska when only published destination exists",
    operational_model: "Resolves multiple regions from catalogue without Alaska fallback"
  };

  const report = {
    generated_at: new Date().toISOString(),
    mode: "operational_destination_per_sailing_simulation",
    writes_performed: false,
    summary,
    per_line: perLine
  };

  const out = path.join(root, "reports/operational-destination-simulation.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("Report:", out);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
