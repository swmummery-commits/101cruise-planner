/**
 * Build an official Shore Excursions Group sailing-specific deep link for My Cruise.
 *
 * GET /.netlify/functions/seg-sailing-link
 *   ?ship_name=Celebrity%20Equinox
 *   &cruise_line=Celebrity%20Cruises
 *   &departure_date=2027-09-18
 *   &nights=10
 */

"use strict";

const { resolveCruiseShip } = require("./lib/resolve-cruise-ship");

const SEG_BASE_URL = "https://www.shoreexcursionsgroup.com/results/";
const SEG_FALLBACK_URL = "https://www.shoreexcursionsgroup.com/?id=1721337&data=steve@101cruise.com.au&source=portal";
const SEG_AGENCY_ID = "1721337";
const SEG_AGENT_EMAIL = "steve@101cruise.com.au";
const SEG_SOURCE = "portal";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function normaliseDepartureDate(value) {
  const raw = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function normaliseNights(value) {
  const nights = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(nights) || nights < 1 || nights > 365) return null;
  return nights;
}

async function fetchJson(path) {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) throw new Error("Supabase server configuration is unavailable");

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
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
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return Array.isArray(data) ? data : [];
}

async function listMappedShips() {
  return fetchJson(
    "ci_cruise_ships?select=id,name,cruise_line_id,seg_ship_id,ci_cruise_lines(id,name,slug)&active=eq.true&seg_ship_id=not.is.null&order=name.asc&limit=5000"
  );
}

async function listShipAliases() {
  try {
    return await fetchJson(
      "cruise_ship_aliases?select=ship_id,cruise_line_id,raw_alias,normalised_alias,active&or=(active.is.null,active.eq.true)&limit=5000"
    );
  } catch (_error) {
    return [];
  }
}

function buildSegUrl(segShipId, departureDate, nights) {
  const url = new URL(SEG_BASE_URL);
  url.searchParams.set("shipId", String(segShipId));
  url.searchParams.set("arrival", departureDate);
  url.searchParams.set("nights", String(nights));
  url.searchParams.set("id", SEG_AGENCY_ID);
  url.searchParams.set("data", SEG_AGENT_EMAIL);
  url.searchParams.set("source", SEG_SOURCE);
  return url.toString();
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });

  const query = event.queryStringParameters || {};
  const shipName = String(query.ship_name || "").trim();
  const cruiseLine = String(query.cruise_line || "").trim();
  const departureDate = normaliseDepartureDate(query.departure_date);
  const nights = normaliseNights(query.nights);

  if (!shipName || !departureDate || !nights) {
    return jsonResponse(200, {
      ok: true,
      matched: false,
      reason: "INCOMPLETE_SAILING_DATA",
      url: SEG_FALLBACK_URL
    });
  }

  try {
    const [ships, aliases] = await Promise.all([listMappedShips(), listShipAliases()]);
    const resolution = resolveCruiseShip(ships, shipName, cruiseLine, aliases);

    if (resolution.status !== "matched" || !resolution.ship?.seg_ship_id) {
      return jsonResponse(200, {
        ok: true,
        matched: false,
        reason: resolution.status === "ambiguous" ? "SHIP_AMBIGUOUS" : "SEG_SHIP_ID_NOT_MAPPED",
        url: SEG_FALLBACK_URL
      });
    }

    return jsonResponse(200, {
      ok: true,
      matched: true,
      ship_name: resolution.ship.name,
      seg_ship_id: String(resolution.ship.seg_ship_id),
      url: buildSegUrl(resolution.ship.seg_ship_id, departureDate, nights)
    });
  } catch (error) {
    console.error("SEG sailing link lookup failed", error);
    return jsonResponse(500, {
      ok: false,
      matched: false,
      error: "SEG_LINK_LOOKUP_FAILED",
      url: SEG_FALLBACK_URL
    });
  }
};
