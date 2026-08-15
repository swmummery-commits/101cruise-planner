/**
 * Azamara official-site discovery helpers — cruisetour exclusion and GTM duration.
 */

const AZAMARA_LINE_ID = "245e6de9-9ec2-480b-ab72-ed8943fe4f22";
const AZAMARA_CT_SUFFIX_RE = /-(CT[AB]\d+)\b/i;
const AZAMARA_PACKAGE_CODE_RE = /\b((?:JR|ON|PR|QS)\d{6}-\d{3}(?:-CT[AB]\d+)?)\b/i;

const CRUISETOUR_SEMANTICS_RE =
  /\b(?:cruisetour|cruise tour)\b/i;
const LAND_EXTENSION_SEMANTICS_RE =
  /\b(?:pre-cruise|post-cruise|land program(?:me)?|land extension|hotel stay|rocky mountaineer|denali(?: tour)?|riverboat(?: tour)?|goldleaf service)\b/i;
const COMBINATION_OCEAN_RE =
  /\b(?:combination cruise|grand voyage|circle (?:south america|pacific|voyage))\b/i;

function isAzamaraCruiseLine(cruiseLine) {
  if (!cruiseLine) return false;
  if (String(cruiseLine.id || "") === AZAMARA_LINE_ID) return true;
  return /azamara/i.test(String(cruiseLine.slug || "")) || /azamara/i.test(String(cruiseLine.name || ""));
}

function parseAzamaraPackageCodeFromUrl(url) {
  const m = String(url || "").match(/\/cruises\/((?:jr|on|pr|qs)\d{6}-\d{3}(?:-ct[ab]\d+)?)/i);
  return m ? m[1].toUpperCase() : null;
}

function parseAzamaraGtmDuration(value) {
  const m = String(value || "").match(/\b(\d{1,2})\s*[-–]?\s*night/i);
  if (!m) return null;
  const nights = Number(m[1]);
  if (!Number.isFinite(nights) || nights <= 0 || nights >= 100) return null;
  return nights;
}

function extractAzamaraGtmFromHtml(html) {
  const text = String(html || "");
  const attr = (name) => {
    const m = text.match(new RegExp(`data-gtm-${name}="([^"]*)"`, "i"));
    return m ? m[1].replace(/&amp;/g, "&") : null;
  };
  const gtmDuration = attr("duration");
  const gtmPackage = attr("package-code");
  return {
    gtm_duration: gtmDuration,
    package_code: gtmPackage ? String(gtmPackage).toUpperCase() : null,
    nights: parseAzamaraGtmDuration(gtmDuration),
    ship_name: attr("ship-name"),
    cruise_name: attr("cruise-name"),
    destination: attr("destination")
  };
}

function classifyAzamaraProduct({ packageCode, url, title, description, officialSailingId } = {}) {
  const pkg = String(
    packageCode || officialSailingId || parseAzamaraPackageCodeFromUrl(url) || ""
  ).toUpperCase();
  const urlStr = String(url || "");
  const blob = `${title || ""}\n${description || ""}`.toLowerCase();
  const ctSuffixMatch = pkg.match(AZAMARA_CT_SUFFIX_RE) || urlStr.match(AZAMARA_CT_SUFFIX_RE);
  const ctSuffix = ctSuffixMatch ? ctSuffixMatch[1].toUpperCase() : null;

  if (COMBINATION_OCEAN_RE.test(blob) && !ctSuffix) {
    return {
      productType: "ocean_combination",
      exclusionReason: null,
      ctSuffix: null
    };
  }

  if (ctSuffix) {
    return {
      productType: "cruisetour",
      exclusionReason: "policy_excluded_cruisetour",
      ctSuffix,
      ctVariant: /^CTA/i.test(ctSuffix) ? "CTA" : "CTB"
    };
  }

  if (CRUISETOUR_SEMANTICS_RE.test(blob) && LAND_EXTENSION_SEMANTICS_RE.test(blob)) {
    return {
      productType: "cruisetour",
      exclusionReason: "policy_excluded_cruisetour",
      ctSuffix: null,
      ctVariant: /\bpost-cruise\b/i.test(blob) ? "CTA" : /\bpre-cruise\b/i.test(blob) ? "CTB" : null
    };
  }

  if (CRUISETOUR_SEMANTICS_RE.test(blob) && !COMBINATION_OCEAN_RE.test(blob)) {
    return {
      productType: "cruisetour",
      exclusionReason: "policy_excluded_cruisetour",
      ctSuffix: null,
      ctVariant: null
    };
  }

  return {
    productType: "ocean_cruise",
    exclusionReason: null,
    ctSuffix: null
  };
}

function enrichStructuredVoyageFromHtml(structuredVoyage, html, url) {
  const gtm = extractAzamaraGtmFromHtml(html);
  const next = { ...(structuredVoyage || {}), source: structuredVoyage?.source || "azamara_gtm" };
  if (gtm.package_code) next.package_code = gtm.package_code;
  if (gtm.gtm_duration) next.gtm_duration = gtm.gtm_duration;
  if (gtm.nights) next.nights = gtm.nights;
  if (gtm.ship_name && !next.ship_name) next.ship_name = gtm.ship_name;
  if (gtm.cruise_name && !next.title) next.title = gtm.cruise_name;
  if (gtm.destination && !next.description) next.description = `Destination: ${gtm.destination}`;
  if (gtm.destination) next.gtm_destination = gtm.destination;
  if (!next.url && url) next.url = url;
  return next;
}

function mergeAzamaraStructuredVoyage(structuredVoyage, html, url) {
  if (!html) return structuredVoyage || null;
  return enrichStructuredVoyageFromHtml(structuredVoyage, html, url);
}

function validateAzamaraOceanDuration(candidate) {
  const reasons = [];
  const nights = candidate?.nights == null ? null : Number(candidate.nights);
  if (!Number.isFinite(nights) || nights <= 0) {
    reasons.push("Azamara cruise duration missing or invalid");
  }
  if (candidate?.departure_date && Number.isFinite(nights) && nights > 0 && !candidate.return_date) {
    reasons.push("Azamara return date could not be established");
  }
  return reasons;
}

function azamaraStaleSourceGate({ html, title, structuredVoyage, url } = {}) {
  if (!html) return null;
  const gtm = extractAzamaraGtmFromHtml(html);
  const pageTitle =
    title ||
    gtm.cruise_name ||
    (html.match(/<title>([^<]+)/i) || [])[1] ||
    "";
  const genericHomepage = /Award-Winning Small Ship Cruise Line/i.test(pageTitle);
  const missingSailingSignals = !gtm.package_code && !gtm.nights && !gtm.gtm_duration && !gtm.ship_name;
  if (genericHomepage && missingSailingSignals) {
    return {
      skip: true,
      reason: "source_stale_or_unavailable",
      signalScore: 0,
      diagnostics: {
        azamara_source_status: "stale_sitemap_or_homepage",
        url: url || null,
        page_title: pageTitle.slice(0, 120)
      }
    };
  }
  return null;
}

function azamaraPreBuildGate({ cruiseLine, url, title, description, structuredVoyage, officialSailingId, html }) {
  if (!isAzamaraCruiseLine(cruiseLine)) return null;
  const stale = azamaraStaleSourceGate({ html, title, structuredVoyage, url });
  if (stale) return stale;
  const product = classifyAzamaraProduct({
    packageCode: structuredVoyage?.package_code || structuredVoyage?.voyage_id,
    url,
    title,
    description,
    officialSailingId
  });
  if (product.exclusionReason) {
    return {
      skip: true,
      reason: product.exclusionReason,
      signalScore: 0,
      diagnostics: {
        azamara_product_type: product.productType,
        azamara_ct_suffix: product.ctSuffix
      }
    };
  }
  return null;
}

module.exports = {
  AZAMARA_LINE_ID,
  AZAMARA_CT_SUFFIX_RE,
  isAzamaraCruiseLine,
  parseAzamaraPackageCodeFromUrl,
  parseAzamaraGtmDuration,
  extractAzamaraGtmFromHtml,
  classifyAzamaraProduct,
  enrichStructuredVoyageFromHtml,
  mergeAzamaraStructuredVoyage,
  validateAzamaraOceanDuration,
  azamaraPreBuildGate,
  azamaraStaleSourceGate
};
