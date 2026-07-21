/**
 * Cruise Line Fleet Audit — compare official fleet pages vs ci_cruise_ships.
 * Does NOT run AI research content generation.
 * Prefers official cruise line websites (Brave site: + fetch).
 */

const { braveSearch, getBraveApiKey } = require("./brave-search");
const { fetchSourceExcerpt } = require("./source-fetch");
const { generateStructuredJson, getLlmConfig } = require("./llm-provider");

function normaliseShipName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(ms|mv|ss|rms)\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ship|cruise)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainFromWebsite(websiteUrl) {
  try {
    const u = new URL(String(websiteUrl || "").trim());
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function slugifyShip(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Heuristic ship-name candidates from page text (fallback when LLM unavailable).
 */
function extractShipNamesHeuristic(text, lineName) {
  const raw = String(text || "");
  const lineBits = normaliseShipName(lineName).split(" ").filter(Boolean);
  const candidates = new Set();

  // Quoted names and Title Case multi-word tokens
  const patterns = [
    /["“]([A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+){0,3})["”]/g,
    /\b((?:MS|MV|SS)\s+[A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+){0,3})\b/g,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g
  ];

  for (const re of patterns) {
    let m;
    const clone = new RegExp(re.source, re.flags);
    while ((m = clone.exec(raw)) !== null) {
      const name = String(m[1] || "").trim();
      if (name.length < 3 || name.length > 48) continue;
      const norm = normaliseShipName(name);
      if (!norm || norm.split(" ").length > 5) continue;
      // Skip cruise line brand fragments and generic words
      if (lineBits.some((b) => b.length > 3 && norm === b)) continue;
      if (
        /^(our|fleet|ships|cruises|explore|learn|book|more|about|home|menu|contact|privacy|cookie)$/i.test(
          name
        )
      ) {
        continue;
      }
      candidates.add(name.replace(/\s+/g, " ").trim());
    }
  }

  return [...candidates];
}

async function extractShipNamesWithLlm(text, lineName) {
  const cfg = getLlmConfig();
  if (!cfg.configured) return null;
  try {
    const result = await generateStructuredJson({
      systemPrompt:
        "You extract cruise ship names from official fleet page text. Return JSON only: {\"ships\":[{\"name\":\"...\"}]}. Include only current fleet ships. Exclude hotels, ports, destinations, and brand slogans.",
      userPrompt: [
        `Cruise line: ${lineName}`,
        "Extract current ship names from this official page text:",
        String(text || "").slice(0, 10000)
      ].join("\n\n"),
      schemaName: "fleet_ships"
    });
    const parsed = JSON.parse(result.text);
    const ships = Array.isArray(parsed?.ships) ? parsed.ships : [];
    return ships
      .map((s) => String(s?.name || "").trim())
      .filter((n) => n.length >= 2);
  } catch {
    return null;
  }
}

async function resolveFleetPage({ lineName, websiteUrl, knownFleetPageUrl }) {
  const diagnostics = { queries: [], brave_hits: 0, method: null };
  if (knownFleetPageUrl) {
    diagnostics.method = "cached_fleet_page_url";
    return { url: knownFleetPageUrl, diagnostics };
  }

  const domain = domainFromWebsite(websiteUrl);
  const apiKey = getBraveApiKey();
  if (!apiKey) {
    const err = new Error("BRAVE_SEARCH_API_KEY is not configured");
    err.code = "search_provider_unavailable";
    err.statusCode = 503;
    throw err;
  }

  const queries = [];
  if (domain) {
    queries.push(`site:${domain} fleet ships`);
    queries.push(`site:${domain} our ships`);
  }
  queries.push(`"${lineName}" official fleet ships`);

  let best = null;
  for (const q of queries.slice(0, 3)) {
    diagnostics.queries.push(q);
    const hits = await braveSearch(apiKey, q, { count: 6, timeoutMs: 7000 });
    diagnostics.brave_hits += hits.length;
    for (const hit of hits) {
      const url = String(hit.url || "");
      if (!url) continue;
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        continue;
      }
      const path = url.toLowerCase();
      const looksFleet =
        /fleet|ships|our-ships|our_ships|ship-finder|meet-the-fleet|cruise-ships/.test(path) ||
        /fleet|ships/.test(String(hit.title || "").toLowerCase());
      const domainMatch = domain && (host === domain || host.endsWith(`.${domain}`));
      const score = (domainMatch ? 40 : 0) + (looksFleet ? 30 : 0) + 5;
      if (!best || score > best.score) {
        best = { url, title: hit.title || "", score, domainMatch };
      }
    }
  }

  if (!best) {
    return { url: websiteUrl || null, diagnostics: { ...diagnostics, method: "homepage_fallback" } };
  }
  diagnostics.method = best.domainMatch ? "brave_official_domain" : "brave_best_effort";
  return { url: best.url, diagnostics };
}

/**
 * Audit one cruise line against its official fleet page.
 * @param {{
 *   line: { id: string, name: string, website_url?: string, fleet_page_url?: string },
 *   dbShips: Array<{ id: string, name: string, active?: boolean, status?: string }>
 * }}
 */
async function auditCruiseLineFleet({ line, dbShips }) {
  const started = Date.now();
  const activeShips = (dbShips || []).filter((s) => s.active !== false);
  const findings = [];
  const diagnostics = {
    line_id: line.id,
    line_name: line.name,
    extract_method: null,
    official_names: [],
    duration_ms: 0
  };

  const fleet = await resolveFleetPage({
    lineName: line.name,
    websiteUrl: line.website_url,
    knownFleetPageUrl: line.fleet_page_url
  });
  diagnostics.fleet_resolve = fleet.diagnostics;

  if (!fleet.url) {
    findings.push({
      finding_type: "unable_to_verify",
      status_label: "Unable to Verify",
      ship_name: null,
      match_ship_id: null,
      reason: "No official website or fleet page URL available for this cruise line.",
      confidence: "low",
      source_url: null,
      payload_json: { ships_checked: activeShips.length }
    });
    diagnostics.duration_ms = Date.now() - started;
    return { findings, fleet_page_url: null, diagnostics, ships_checked: activeShips.length };
  }

  const fetched = await fetchSourceExcerpt(fleet.url, { timeoutMs: 8000 });
  const pageText = fetched.ok
    ? fetched.excerpt
    : "";

  if (!pageText || pageText.length < 120) {
    findings.push({
      finding_type: "unable_to_verify",
      status_label: "Unable to Verify",
      ship_name: null,
      match_ship_id: null,
      reason: fetched.error
        ? `Could not read fleet page (${fetched.error}).`
        : "Fleet page returned too little readable text.",
      confidence: "low",
      source_url: fleet.url,
      payload_json: { fetch_ok: fetched.ok }
    });
    diagnostics.duration_ms = Date.now() - started;
    return { findings, fleet_page_url: fleet.url, diagnostics, ships_checked: activeShips.length };
  }

  let officialNames = await extractShipNamesWithLlm(pageText, line.name);
  if (officialNames && officialNames.length) {
    diagnostics.extract_method = "llm";
  } else {
    officialNames = extractShipNamesHeuristic(pageText, line.name);
    diagnostics.extract_method = "heuristic";
  }
  diagnostics.official_names = officialNames;

  const officialNorm = new Map();
  for (const name of officialNames) {
    const key = normaliseShipName(name);
    if (key && !officialNorm.has(key)) officialNorm.set(key, name);
  }

  const dbNorm = new Map();
  for (const ship of activeShips) {
    const key = normaliseShipName(ship.name);
    if (key) dbNorm.set(key, ship);
  }

  // Presence check: DB ships mentioned on page even if extract missed them
  const pageLower = pageText.toLowerCase();
  for (const ship of activeShips) {
    const key = normaliseShipName(ship.name);
    if (!key) continue;
    if (officialNorm.has(key)) continue;
    if (pageLower.includes(String(ship.name).toLowerCase()) || pageLower.includes(key)) {
      officialNorm.set(key, ship.name);
    }
  }

  if (!officialNorm.size) {
    findings.push({
      finding_type: "unable_to_verify",
      status_label: "Unable to Verify",
      ship_name: null,
      match_ship_id: null,
      reason: "Could not extract a reliable ship list from the official page.",
      confidence: "low",
      source_url: fleet.url,
      payload_json: { extract_method: diagnostics.extract_method }
    });
    diagnostics.duration_ms = Date.now() - started;
    return { findings, fleet_page_url: fleet.url, diagnostics, ships_checked: activeShips.length };
  }

  // New ships
  for (const [key, name] of officialNorm.entries()) {
    if (dbNorm.has(key)) continue;
    // Fuzzy: official name contains db name or vice versa
    let fuzzy = null;
    for (const [dbKey, ship] of dbNorm.entries()) {
      if (key.includes(dbKey) || dbKey.includes(key)) {
        fuzzy = ship;
        break;
      }
    }
    if (fuzzy) {
      if (normaliseShipName(fuzzy.name) !== key) {
        findings.push({
          finding_type: "possible_rename",
          status_label: "Possible Rename",
          ship_name: name,
          match_ship_id: fuzzy.id,
          related_ship_id: fuzzy.id,
          reason: `Official list shows “${name}”; database has “${fuzzy.name}”. Manual review required.`,
          confidence: diagnostics.extract_method === "llm" ? "medium" : "low",
          source_url: fleet.url,
          payload_json: { official_name: name, db_name: fuzzy.name }
        });
      }
      continue;
    }
    findings.push({
      finding_type: "new_ship",
      status_label: "New Ship Found",
      ship_name: name,
      match_ship_id: null,
      reason: `“${name}” appears on the official fleet page but is not in the active ships table.`,
      confidence: diagnostics.extract_method === "llm" ? "high" : "medium",
      source_url: fleet.url,
      payload_json: { proposed_slug: slugifyShip(name) }
    });
  }

  // Possible retired / transfer
  for (const [key, ship] of dbNorm.entries()) {
    if (officialNorm.has(key)) continue;
    let fuzzyOfficial = null;
    for (const [ok, oname] of officialNorm.entries()) {
      if (key.includes(ok) || ok.includes(key)) {
        fuzzyOfficial = oname;
        break;
      }
    }
    if (fuzzyOfficial) continue;

    const onOtherLineHint = /transfer|sold|left the fleet|former/i.test(pageText);
    findings.push({
      finding_type: onOtherLineHint ? "possible_transfer" : "possible_retired",
      status_label: onOtherLineHint ? "Possible Transfer" : "Possible Retired Ship",
      ship_name: ship.name,
      match_ship_id: ship.id,
      related_ship_id: ship.id,
      reason: onOtherLineHint
        ? `“${ship.name}” is active in our database but was not found on the official fleet page (transfer language detected).`
        : `“${ship.name}” is active in our database but was not found on the official fleet page.`,
      confidence: diagnostics.extract_method === "llm" ? "medium" : "low",
      source_url: fleet.url,
      payload_json: { db_ship_id: ship.id }
    });
  }

  const actionable = findings.filter((f) => f.finding_type !== "no_changes");
  if (!actionable.length) {
    findings.push({
      finding_type: "no_changes",
      status_label: "No Changes",
      ship_name: null,
      match_ship_id: null,
      reason: `Official fleet matches ${activeShips.length} active ship${activeShips.length === 1 ? "" : "s"} in the database.`,
      confidence: "high",
      source_url: fleet.url,
      payload_json: { ships_checked: activeShips.length }
    });
  }

  diagnostics.duration_ms = Date.now() - started;
  return {
    findings,
    fleet_page_url: fleet.url,
    diagnostics,
    ships_checked: activeShips.length
  };
}

module.exports = {
  normaliseShipName,
  slugifyShip,
  domainFromWebsite,
  resolveFleetPage,
  auditCruiseLineFleet,
  extractShipNamesHeuristic
};
