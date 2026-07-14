/**
 * Public read-only guided Drinks Calculator (V2) payload.
 *
 * GET /.netlify/functions/public-calculator-v2?line=<id|slug>
 *
 * Returns cruise-line rates + active beverage packages.
 * Uses server-side Supabase service credentials only.
 * No visitor input, no writes, no customer data.
 */

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60"
    },
    body: JSON.stringify(body)
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lineMatches(name, lineParam) {
  const raw = String(lineParam || "").trim().toLowerCase();
  if (!raw || !name) return false;
  const slug = slugify(name);
  const compact = slug.replace(/-/g, "");
  const rawCompact = raw.replace(/-/g, "");
  if (slug === raw || compact === rawCompact) return true;
  if (slug.startsWith(raw + "-") || slug.includes("-" + raw + "-") || slug.endsWith("-" + raw)) return true;
  if (compact.startsWith(rawCompact) && rawCompact.length >= 4) return true;
  return false;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function supabaseGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server access is not configured");
  }

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || `Supabase HTTP ${response.status}`;
    throw new Error(message);
  }

  return Array.isArray(data) ? data : [];
}

async function fetchActiveCalculatorRates() {
  const query = new URLSearchParams({
    select: [
      "cruise_line_id",
      "currency",
      "beer_price",
      "wine_price",
      "cocktail_price",
      "spirits_mixer_price",
      "premium_coffee_price",
      "soft_drink_price",
      "juice_price",
      "bottled_water_price",
      "gratuity_percent",
      "drinks_included_in_fare",
      "wifi_included",
      "wifi_package_price",
      "wifi_price_label",
      "wifi_notes",
      "specialty_dining_notes",
      "general_notes",
      "last_verified_at",
      "cruise_lines(id,name,logo_url,wifi_included_in_fare)"
    ].join(","),
    active: "eq.true"
  });
  return supabaseGet(`cruise_line_calculator_rates?${query.toString()}`);
}

async function fetchActivePackages(cruiseLineId) {
  const query = new URLSearchParams({
    select: [
      "id",
      "cruise_line_id",
      "package_name",
      "typical_daily_price",
      "currency",
      "wifi_included",
      "gratuities_included",
      "display_order",
      "notes",
      "last_verified_at"
    ].join(","),
    cruise_line_id: `eq.${cruiseLineId}`,
    active: "eq.true",
    order: "display_order.asc,package_name.asc"
  });
  return supabaseGet(`cruise_line_beverage_packages?${query.toString()}`);
}

function mapLine(row) {
  const cruiseLineId = row?.cruise_line_id;
  const cruiseLineName = String(row?.cruise_lines?.name || "").trim();
  if (cruiseLineId == null || !cruiseLineName) return null;

  return {
    cruise_line_id: cruiseLineId,
    cruise_line_name: cruiseLineName,
    cruise_line_slug: slugify(cruiseLineName),
    logo_url: String(row?.cruise_lines?.logo_url || "").trim() || null,
    currency: String(row?.currency || "USD").trim() || "USD",
    beer_price: toNumberOrNull(row?.beer_price),
    wine_price: toNumberOrNull(row?.wine_price),
    cocktail_price: toNumberOrNull(row?.cocktail_price),
    spirits_mixer_price: toNumberOrNull(row?.spirits_mixer_price),
    premium_coffee_price: toNumberOrNull(row?.premium_coffee_price),
    soft_drink_price: toNumberOrNull(row?.soft_drink_price),
    juice_price: toNumberOrNull(row?.juice_price),
    bottled_water_price: toNumberOrNull(row?.bottled_water_price),
    gratuity_percent: toNumberOrNull(row?.gratuity_percent),
    drinks_included_in_fare: row?.drinks_included_in_fare === true,
    wifi_included_in_fare: row?.cruise_lines?.wifi_included_in_fare === true,
    wifi_package_price: toNumberOrNull(row?.wifi_package_price),
    wifi_price_label: String(row?.wifi_price_label || "").trim() || null,
    wifi_notes: String(row?.wifi_notes || "").trim() || null,
    specialty_dining_notes: String(row?.specialty_dining_notes || "").trim() || null,
    general_notes: String(row?.general_notes || "").trim() || null,
    last_verified_at: row?.last_verified_at || null
  };
}

function mapPackage(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    package_name: String(row.package_name || "").trim(),
    typical_daily_price: toNumberOrNull(row.typical_daily_price),
    currency: String(row.currency || "USD").trim() || "USD",
    wifi_included: row.wifi_included === true,
    gratuities_included: row.gratuities_included === true,
    display_order: Number(row.display_order) || 0,
    notes: String(row.notes || "").trim() || null,
    last_verified_at: row.last_verified_at || null
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { success: true });
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Use GET to load guided calculator data."
    });
  }

  const lineParam = String(event.queryStringParameters?.line || "").trim();
  if (!lineParam) {
    return jsonResponse(400, {
      success: false,
      error: "LINE_REQUIRED",
      message: "Provide a cruise line via ?line="
    });
  }

  try {
    const rows = await fetchActiveCalculatorRates();
    const rates = rows.map(mapLine).filter(Boolean);

    const numericId = Number(lineParam);
    let match = null;
    if (Number.isFinite(numericId) && String(numericId) === lineParam) {
      match = rates.find(rate => Number(rate.cruise_line_id) === numericId) || null;
    }
    if (!match) {
      match = rates.find(rate => lineMatches(rate.cruise_line_name, lineParam)) || null;
    }

    if (!match) {
      return jsonResponse(404, {
        success: false,
        error: "LINE_NOT_FOUND",
        message: "No active calculator rates were found for that cruise line."
      });
    }

    const packageRows = await fetchActivePackages(match.cruise_line_id);
    const packages = packageRows
      .map(mapPackage)
      .filter(pkg => pkg && pkg.package_name)
      .sort((a, b) => {
        if (a.display_order !== b.display_order) return a.display_order - b.display_order;
        return a.package_name.localeCompare(b.package_name, undefined, { sensitivity: "base" });
      });

    return jsonResponse(200, {
      success: true,
      line: match,
      packages
    });
  } catch (error) {
    console.error("public-calculator-v2 error", error);
    return jsonResponse(500, {
      success: false,
      error: "CALCULATOR_UNAVAILABLE",
      message: "Calculator rates are not available right now."
    });
  }
};
