/**
 * Azamara official sitemap discovery adapter — productionised catch-up logic.
 */

const discovery = require("./cruise-discovery");
const { extractSitemapLocs } = require("./cruise-discovery-structured");
const { parseRoutePortPair } = require("./discovery-departure-port");
const {
  resolveAzamaraDestination,
  preferAzamaraDestinationHits
} = require("./azamara-destination-mapping");
const {
  classifyAzamaraProduct,
  extractAzamaraGtmFromHtml,
  enrichStructuredVoyageFromHtml,
  azamaraStaleSourceGate,
  AZAMARA_LINE_ID
} = require("./azamara-discovery-source");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { publicBookingMinimumDepartureDate } = require("./public-discovered-cruise-inventory");

const ADAPTER_ID = "azamara_official_sitemap";
const ADAPTER_VERSION = "2026-08-16-weekly";
const SITEMAP_URL = "https://www.azamara.com/sitemap.xml";
const PACKAGE_RE = /\/cruises\/((jr|on|pr|qs)(\d{2})(\d{2})(\d{2})-(\d{3})(?:-(ct[ab]\d+))?)/i;
const OFFICIAL_SAILING_RE = /^(JR|ON|PR|QS)\d{6}-\d{3}$/i;
const SHIP_PREFIX = { jr: "Journey", on: "Onward", pr: "Pursuit", qs: "Quest" };

const {
  buildCandidateFromSource,
  matchDestination,
  pickDestinationFromHits,
  destinationMentionedInText,
  extractRawSignals,
  normaliseCandidate,
  validateCruise,
  externalKey
} = discovery;

function defaultFetchText(url, maxBytes = 600000) {
  return fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(45000)
  }).then(async (res) => ({ status: res.status, text: (await res.text()).slice(0, maxBytes) }));
}

function parsePackageFromUrl(url) {
  const m = String(url).match(PACKAGE_RE);
  if (!m) return null;
  const prefix = m[2].toLowerCase();
  const fullCode = `${m[2].toUpperCase()}${m[3]}${m[4]}${m[5]}-${m[6]}${m[7] ? `-${m[7].toUpperCase()}` : ""}`;
  const year = Number(m[3]) >= 70 ? 1900 + Number(m[3]) : 2000 + Number(m[3]);
  return {
    fullCode,
    departure: `${year}-${m[4]}-${m[5]}`,
    prefix,
    url: String(url).replace(/\/(fares|shore-excursions)\/?$/, ""),
    isCruisetour: Boolean(m[7])
  };
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

function isOfficialAzamaraRecord(row) {
  const sailingId = String(row?.official_sailing_id || "").trim().toUpperCase();
  if (!OFFICIAL_SAILING_RE.test(sailingId)) return false;
  const raw = row?.raw_extract || {};
  if (raw.azamara_package_code || raw.azamara_catchup_batch) return true;
  if (raw.discovery_11d2?.adapter === ADAPTER_ID) return true;
  if (raw.structured_source === ADAPTER_ID) return true;
  return OFFICIAL_SAILING_RE.test(sailingId);
}

function isLegacyGenericAzamaraRow(row) {
  if (isOfficialAzamaraRecord(row)) return false;
  const url = String(row?.official_url || "");
  if (/blog|\/destinations\/|\/experiences\//i.test(url)) return true;
  if (!row?.official_sailing_id && !row?.departure_date) return true;
  return false;
}

function classifyDestinationQuality({ title, gtmDestination, destHits, selectedDest, selectedId }) {
  const titleNorm = String(title || "").toLowerCase().replace(/&amp;/g, "&");
  const selectedName = selectedDest?.name || null;
  if (!selectedId || !selectedName) return { quality: "D", reason: "unresolved destination" };
  const japanTitle = /japan|tokyo|kobe|nagasaki|yokohama|osaka|hiroshima/.test(titleNorm);
  if (japanTitle && selectedName === "Africa") {
    return { quality: "C", reason: "Japan title with Africa destination" };
  }
  const filteredHits = preferAzamaraDestinationHits(destHits, title, gtmDestination);
  if (filteredHits.length > 1) {
    const titleHits = filteredHits.filter((h) => destinationMentionedInText(h.dest, title));
    if (titleHits.some((h) => h.dest.id === selectedId)) {
      return { quality: "A", reason: "title destination wins" };
    }
    if (/combo|grand voyage/i.test(gtmDestination || "")) {
      return { quality: "B", reason: "COMBO/GTM ambiguity" };
    }
    return { quality: "B", reason: "multiple hits" };
  }
  return { quality: "A", reason: "single clear destination" };
}

function candidateChanged(existing, candidate) {
  if (!existing || !candidate) return false;
  return (
    existing.ship_id !== candidate.ship_id ||
    existing.destination_id !== candidate.destination_id ||
    existing.departure_date !== candidate.departure_date ||
    existing.return_date !== candidate.return_date ||
    existing.nights !== candidate.nights ||
    String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
    String(existing.itinerary || "") !== String(candidate.itinerary || "") ||
    String(existing.official_url || "") !== String(candidate.official_url || "")
  );
}

function buildAzamaraCandidatePayload({
  candidate,
  gtmPackage,
  product,
  gtm,
  runId,
  identity_key
}) {
  return {
    ...candidate,
    official_sailing_id: gtmPackage,
    identity_key,
    cruise_line_id: candidate.cruise_line_id || AZAMARA_LINE_ID,
    external_key: externalKey({
      cruiseLineId: candidate.cruise_line_id || AZAMARA_LINE_ID,
      officialUrl: candidate.official_url,
      departureDate: candidate.departure_date,
      shipId: candidate.ship_id,
      nights: candidate.nights
    }),
    raw_extract: {
      ...(candidate.raw_extract || {}),
      azamara_package_code: gtmPackage,
      azamara_product_type: product.productType,
      azamara_gtm_duration: gtm.gtm_duration,
      structured_source: ADAPTER_ID,
      discovery_11d2: {
        adapter: ADAPTER_ID,
        adapter_version: ADAPTER_VERSION,
        source_method: "official_sitemap",
        sailing_score: 100,
        positive_signals: ["official_sitemap", "official_gtm"]
      },
      azamara_weekly_run_id: runId || null
    }
  };
}

async function simulateAzamaraDiscovery({
  cruiseLine,
  ships,
  destinations,
  shipAliases = [],
  destinationAliases = [],
  existingOfficialBySailingId = new Map(),
  today,
  fetchImpl = null,
  progressCallback = null,
  maxUrls = null,
  runId = null
} = {}) {
  const fetchText = fetchImpl || defaultFetchText;
  const minDep = publicBookingMinimumDepartureDate(today);
  const outcome_counts = {
    recognised_existing_unchanged: 0,
    recognised_existing_changed: 0,
    new_candidate: 0,
    policy_excluded_cruisetour: 0,
    source_stale_or_unavailable: 0,
    http_source_failure: 0,
    validation_failed: 0,
    within_cutoff: 0,
    dest_quality_excluded: 0,
    matcher_picker_mismatch: 0
  };

  let sitemapRes;
  try {
    sitemapRes = await fetchText(SITEMAP_URL, 5000000);
  } catch (error) {
    return {
      fetch_result: { ok: false, error: error.message, sitemap_url: SITEMAP_URL },
      products: [],
      outcome_counts,
      quality_gate_metrics: { duplicate_official_sailing_ids: 0, duplicate_official_identities: 0 },
      source_eligible_official_ids: []
    };
  }

  if (sitemapRes.status !== 200) {
    return {
      fetch_result: { ok: false, status: sitemapRes.status, sitemap_url: SITEMAP_URL },
      products: [],
      outcome_counts,
      quality_gate_metrics: { duplicate_official_sailing_ids: 0, duplicate_official_identities: 0 },
      source_eligible_official_ids: []
    };
  }

  const locs = extractSitemapLocs(sitemapRes.text, SITEMAP_URL);
  const parsedByCode = new Map();
  for (const url of locs) {
    const p = parsePackageFromUrl(url);
    if (!p || p.departure < minDep) {
      if (p && p.departure < minDep) outcome_counts.within_cutoff += 1;
      continue;
    }
    if (!parsedByCode.has(p.fullCode) || p.url.length < parsedByCode.get(p.fullCode).url.length) {
      parsedByCode.set(p.fullCode, p);
    }
  }

  let parsed = [...parsedByCode.values()].sort(
    (a, b) => a.departure.localeCompare(b.departure) || a.fullCode.localeCompare(b.fullCode)
  );
  if (maxUrls != null) parsed = parsed.slice(0, Math.max(0, Number(maxUrls)));

  const products = [];
  const source_eligible_official_ids = [];
  const batchSailingIds = new Set();
  const batchIdentityKeys = new Set();
  let urls_processed = 0;
  let http_failures = 0;
  let stale_dead = 0;

  for (const item of parsed) {
    urls_processed += 1;
    if (progressCallback && urls_processed % 25 === 0) progressCallback({ urls_processed, total: parsed.length });

    if (item.isCruisetour) {
      outcome_counts.policy_excluded_cruisetour += 1;
      products.push({
        official_sailing_id: item.fullCode,
        url: item.url,
        disposition: "policy_excluded_cruisetour",
        product_type: "cruisetour"
      });
      continue;
    }

    let html;
    try {
      html = await fetchText(item.url);
    } catch {
      http_failures += 1;
      outcome_counts.http_source_failure += 1;
      products.push({
        official_sailing_id: item.fullCode,
        url: item.url,
        disposition: "http_source_failure"
      });
      continue;
    }

    if (html.status !== 200) {
      http_failures += 1;
      outcome_counts.http_source_failure += 1;
      products.push({
        official_sailing_id: item.fullCode,
        url: item.url,
        disposition: "http_source_failure",
        http_status: html.status
      });
      continue;
    }

    const gtm = extractAzamaraGtmFromHtml(html.text);
    const gtmPackage = (gtm.package_code || item.fullCode).toUpperCase();
    const title = gtm.cruise_name || (html.text.match(/<title>([^<]+)/i) || [])[1] || "";
    const description =
      (html.text.match(/name="description"\s+content="([^"]*)"/i) || [])[1] ||
      (html.text.match(/property="og:description"\s+content="([^"]*)"/i) || [])[1] ||
      "";
    const excerpt = gtm.destination ? `Destination: ${gtm.destination}` : "";

    const stale = azamaraStaleSourceGate({
      html: html.text,
      title,
      structuredVoyage: { package_code: gtmPackage },
      url: item.url
    });
    if (stale) {
      stale_dead += 1;
      outcome_counts.source_stale_or_unavailable += 1;
      products.push({
        official_sailing_id: gtmPackage,
        url: item.url,
        disposition: "source_stale_or_unavailable",
        title: title.slice(0, 120)
      });
      continue;
    }

    const product = classifyAzamaraProduct({
      packageCode: gtmPackage,
      url: item.url,
      title,
      description,
      officialSailingId: gtmPackage
    });
    if (product.exclusionReason) {
      outcome_counts.policy_excluded_cruisetour += 1;
      products.push({
        official_sailing_id: gtmPackage,
        url: item.url,
        disposition: "policy_excluded_cruisetour",
        product_type: product.productType
      });
      continue;
    }

    const structuredVoyage = enrichStructuredVoyageFromHtml(
      {
        title,
        description,
        url: item.url,
        ship_name: gtm.ship_name,
        departure_date: item.departure,
        package_code: gtmPackage,
        source: "azamara_gtm"
      },
      html.text,
      item.url
    );

    if (!structuredVoyage?.nights) {
      outcome_counts.validation_failed += 1;
      products.push({
        official_sailing_id: gtmPackage,
        url: item.url,
        disposition: "validation_failed",
        failure: "missing_gtm_duration"
      });
      continue;
    }

    const built = buildCandidateFromSource({
      title,
      description,
      url: item.url,
      excerpt,
      cruiseLine,
      ships,
      destinations,
      preferredDestination: null,
      shipAliases,
      destinationAliases,
      structuredVoyage,
      html: html.text
    });

    if (!built || built.skip) {
      outcome_counts.validation_failed += 1;
      products.push({
        official_sailing_id: gtmPackage,
        url: item.url,
        disposition: "validation_failed",
        failure: built?.reason || "skip"
      });
      continue;
    }

    const candidate = built.candidate;
    const reasons = validateCruise(candidate);
    if (reasons.length || built.status !== "active") {
      outcome_counts.validation_failed += 1;
      products.push({
        official_sailing_id: gtmPackage,
        url: item.url,
        disposition: "validation_failed",
        validationReasons: reasons
      });
      continue;
    }

    if (!candidate.nights || !candidate.return_date) {
      outcome_counts.validation_failed += 1;
      products.push({ official_sailing_id: gtmPackage, disposition: "validation_failed", failure: "missing_duration" });
      continue;
    }

    const expectedReturn = addDaysIso(candidate.departure_date, candidate.nights);
    if (expectedReturn !== candidate.return_date) {
      outcome_counts.validation_failed += 1;
      products.push({
        official_sailing_id: gtmPackage,
        disposition: "validation_failed",
        failure: "inconsistent_return_date"
      });
      continue;
    }

    const shipName = ships.find((s) => s.id === candidate.ship_id)?.name;
    const expectedShip = SHIP_PREFIX[item.prefix];
    if (expectedShip && shipName !== expectedShip) {
      outcome_counts.validation_failed += 1;
      products.push({ official_sailing_id: gtmPackage, disposition: "validation_failed", failure: "ship_prefix_mismatch" });
      continue;
    }

    const raw = extractRawSignals({ title, description, excerpt, url: item.url, structuredVoyage });
    const normalised = normaliseCandidate(raw);
    const routePair =
      parseRoutePortPair(description) ||
      parseRoutePortPair(title) ||
      (structuredVoyage?.route_from && structuredVoyage?.route_to
        ? { from: structuredVoyage.route_from, to: structuredVoyage.route_to }
        : null);
    const destHitsRaw = matchDestination(normalised.blob, destinations, destinationAliases);
    const destHits = preferAzamaraDestinationHits(destHitsRaw, title, gtm.destination);
    const selectedByPicker = pickDestinationFromHits(destHits, title);
    const azResolved = resolveAzamaraDestination({
      title,
      description,
      excerpt,
      gtmDestination: gtm.destination,
      routeFrom: routePair?.from || structuredVoyage?.route_from,
      routeTo: routePair?.to || structuredVoyage?.route_to,
      destinations,
      destinationAliases,
      matchDestination,
      pickDestinationFromHits
    });
    const quality = classifyDestinationQuality({
      title,
      gtmDestination: gtm.destination,
      destHits: destHitsRaw,
      selectedDest: candidate.matched_destination,
      selectedId: candidate.destination_id
    });

    if (quality.quality === "C" || quality.quality === "D") {
      outcome_counts.dest_quality_excluded += 1;
      products.push({
        official_sailing_id: gtmPackage,
        disposition: "validation_failed",
        failure: "dest_quality_" + quality.quality
      });
      continue;
    }

    if (quality.quality === "B") {
      outcome_counts.dest_quality_excluded += 1;
      products.push({
        official_sailing_id: gtmPackage,
        disposition: "validation_failed",
        failure: "dest_quality_B"
      });
      continue;
    }

    if (
      selectedByPicker &&
      selectedByPicker.id !== candidate.destination_id &&
      !(azResolved?.destination && azResolved.destination.id === candidate.destination_id)
    ) {
      outcome_counts.matcher_picker_mismatch += 1;
      products.push({ official_sailing_id: gtmPackage, disposition: "validation_failed", failure: "matcher_picker_mismatch" });
      continue;
    }

    const identity_key = cruiseIdentityKey({
      cruiseLineId: cruiseLine.id,
      shipId: candidate.ship_id,
      departureDate: candidate.departure_date,
      officialUrl: candidate.official_url,
      nights: candidate.nights,
      returnDate: candidate.return_date,
      officialSailingId: gtmPackage
    });

    if (batchSailingIds.has(gtmPackage)) {
      outcome_counts.validation_failed += 1;
      continue;
    }
    if (batchIdentityKeys.has(identity_key)) {
      outcome_counts.validation_failed += 1;
      continue;
    }
    batchSailingIds.add(gtmPackage);
    batchIdentityKeys.add(identity_key);

    const payload = buildAzamaraCandidatePayload({
      candidate: { ...candidate, cruise_line_id: cruiseLine.id },
      gtmPackage,
      product,
      gtm,
      runId,
      identity_key
    });

    source_eligible_official_ids.push(gtmPackage);
    const existing = existingOfficialBySailingId.get(gtmPackage) || null;
    let disposition;
    if (existing) {
      disposition = candidateChanged(existing, payload) ? "recognised_existing_changed" : "recognised_existing_unchanged";
      if (disposition === "recognised_existing_changed") outcome_counts.recognised_existing_changed += 1;
      else outcome_counts.recognised_existing_unchanged += 1;
    } else {
      disposition = "new_candidate";
      outcome_counts.new_candidate += 1;
    }

    products.push({
      official_sailing_id: gtmPackage,
      url: item.url,
      title: title.slice(0, 160),
      ship: shipName,
      departure: payload.departure_date,
      return_date: payload.return_date,
      nights: payload.nights,
      departure_port: payload.departure_port,
      raw_route: payload.departure_port_meta?.rawValue || payload.departure_port,
      destination: payload.matched_destination?.name,
      destination_id: payload.destination_id,
      product_type: product.productType,
      dest_quality: quality.quality,
      disposition,
      candidate: payload,
      existing_row: existing,
      identity_key,
      gtm_destination: gtm.destination
    });
  }

  const sailingIds = products.filter((p) => p.candidate).map((p) => p.official_sailing_id);
  const identities = products.filter((p) => p.identity_key).map((p) => p.identity_key);

  return {
    fetch_result: {
      ok: true,
      sitemap_url: SITEMAP_URL,
      sitemap_locs: locs.length,
      eligible_urls: parsed.length,
      urls_target: parsed.length,
      urls_processed,
      http_failures,
      stale_dead,
      pagination: { exhausted: true, zero_progress_pages: 0 }
    },
    products,
    outcome_counts,
    quality_gate_metrics: {
      duplicate_official_sailing_ids: sailingIds.length - new Set(sailingIds).size,
      duplicate_official_identities: identities.length - new Set(identities).size
    },
    source_eligible_official_ids
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SITEMAP_URL,
  SHIP_PREFIX,
  OFFICIAL_SAILING_RE,
  isOfficialAzamaraRecord,
  isLegacyGenericAzamaraRow,
  simulateAzamaraDiscovery,
  classifyDestinationQuality,
  candidateChanged,
  buildAzamaraCandidatePayload,
  parsePackageFromUrl
};
