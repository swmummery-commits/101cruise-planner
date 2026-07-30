#!/usr/bin/env node
/**
 * Read-only Newsletter #78 Featured Cruise verification helper.
 * Loads .env internally — do not pass secrets on the command line.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

loadEnv();

const { listIssueCruiseIds } = require("../netlify/functions/lib/social-pack-data.js");
const { handler } = require("../netlify/functions/public-featured-cruise.js");

async function supabaseGet(pathSuffix) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env not configured");
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${pathSuffix}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(typeof data?.message === "string" ? data.message : text || `HTTP ${response.status}`);
  }
  return data;
}

async function loadNewsletter78Cruises() {
  const rows = await listIssueCruiseIds(78);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id).filter(Boolean);
  const select =
    "id,headline,destination_strip,departure_port,arrival_port,departure_date,return_date,nights,public_slug,publication_status,display_order,newsletter_number,cruise_line_id,cruise_ship_id,ci_cruise_lines(name),ci_cruise_ships(name)";
  const detailed = await supabaseGet(
    `featured_cruises?id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})&select=${encodeURIComponent(select)}&order=display_order.asc`
  );
  return Array.isArray(detailed) ? detailed : [];
}

function exploreMoreUrl(slug) {
  return `https://www.101cruise.com.au/cruise?slug=${encodeURIComponent(slug || "")}`;
}

function embedUrl(base, slug) {
  const b = (base || "http://127.0.0.1:8888").replace(/\/$/, "");
  return `${b}/cruise/${encodeURIComponent(slug)}?embed=1`;
}

function availabilityFromPayload(statusCode, body) {
  const cruise = body?.cruise || null;
  if (statusCode !== 200 || !cruise) {
    return {
      http: statusCode,
      ok: false,
      error: body?.error || body?.detail || "not_found"
    };
  }
  const research = cruise.research || {};
  const itinerary = cruise.itinerary || {};
  const facts = research.ship_facts || {};
  const shipFull = research.ship_full;
  const destFull = research.destination_full;
  const stops = Array.isArray(itinerary.stops) ? itinerary.stops : [];
  const portImages = stops.filter((s) => !s.is_sea_day && s.image?.url).length;
  const portCount = stops.filter((s) => !s.is_sea_day).length;

  const score =
    (cruise.hero?.url ? 2 : 0) +
    (cruise.route_map?.url ? 2 : 0) +
    (destFull ? 3 : 0) +
    (shipFull ? 3 : 0) +
    (stops.length ? 2 : 0) +
    (portImages ? 1 : 0) +
    (facts.guests != null ? 1 : 0) +
    (shipFull?.pauls_tip || destFull?.pauls_tip ? 1 : 0);

  return {
    http: 200,
    ok: true,
    identity: {
      headline: cruise.headline || "",
      destination_strip: cruise.destination_strip || "",
      cruise_line_name: cruise.cruise_line_name || "",
      ship_name: cruise.ship_name || "",
      departure_date: cruise.departure_date || "",
      return_date: cruise.return_date || "",
      nights: cruise.nights
    },
    availability: {
      hero: Boolean(cruise.hero?.url),
      route_map: Boolean(cruise.route_map?.url),
      destination_region: Boolean(cruise.destination_region),
      destination_research: Boolean(destFull),
      destination_season: Boolean(research.destination_season?.best_months?.length),
      ship_research: Boolean(shipFull),
      ship_teaser: Boolean(research.ship),
      ship_facts: Boolean(research.ship_facts),
      itinerary_stops: stops.length,
      port_count: portCount,
      port_images: portImages,
      pauls_tip: Boolean(shipFull?.pauls_tip || destFull?.pauls_tip || research.ship?.pauls_tip)
    },
    completeness_score: score
  };
}

async function callPublicFeaturedCruise(slug) {
  const result = await handler({
    httpMethod: "GET",
    queryStringParameters: { slug }
  });
  let body = {};
  try {
    body = result.body ? JSON.parse(result.body) : {};
  } catch {
    body = {};
  }
  return { statusCode: result.statusCode, body };
}

async function main() {
  const cruises = await loadNewsletter78Cruises();
  const report = {
    newsletter_number: 78,
    generated_at: new Date().toISOString(),
    cruises: []
  };

  for (const row of cruises) {
    const slug = String(row.public_slug || "").trim();
    const entry = {
      id: row.id,
      display_order: row.display_order,
      headline: row.headline,
      publication_status: row.publication_status,
      public_slug: slug,
      explore_more_url: exploreMoreUrl(slug),
      embed_url: embedUrl(process.env.BASE_URL, slug),
      api: null
    };

    if (!slug) {
      entry.api = { http: 0, ok: false, error: "missing_public_slug" };
    } else if (row.publication_status !== "published") {
      const api = await callPublicFeaturedCruise(slug);
      entry.api = availabilityFromPayload(api.statusCode, api.body);
      entry.api.note = `publication_status=${row.publication_status}`;
    } else {
      const api = await callPublicFeaturedCruise(slug);
      entry.api = availabilityFromPayload(api.statusCode, api.body);
    }

    report.cruises.push(entry);
  }

  const okCruises = report.cruises.filter((c) => c.api?.ok);
  okCruises.sort((a, b) => (b.api.completeness_score || 0) - (a.api.completeness_score || 0));
  report.most_complete = okCruises[0] || null;
  report.least_complete = okCruises.length ? okCruises[okCruises.length - 1] : null;

  const outPath = path.join(
    root,
    "generated-assets/destination-experience/featured-cruise-newsletter-78/newsletter-78-live-data-report.json"
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
