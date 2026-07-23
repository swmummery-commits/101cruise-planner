/**
 * Sprint 13D — Structured itinerary + Ports matching helpers.
 * Pure logic for Featured Cruise editor, newsletter preview, and offline tests.
 * Does not generate route maps.
 */
(function (global) {
  "use strict";

  const STOP_TYPES = [
    { value: "port_call", label: "Port Call" },
    { value: "embarkation", label: "Embarkation" },
    { value: "disembarkation", label: "Disembarkation" },
    { value: "at_sea", label: "At Sea" },
    { value: "scenic_cruising", label: "Scenic Cruising" },
    { value: "overnight_port", label: "Overnight Port" },
    { value: "other", label: "Other" }
  ];

  const GEOGRAPHIC_STOP_TYPES = new Set([
    "port_call",
    "embarkation",
    "disembarkation",
    "overnight_port"
  ]);

  const ROUTE_MAP_STATUSES = {
    CURRENT: "current",
    NEEDS_REGENERATION: "needs_regeneration",
    MISSING: "missing",
    MANUAL: "manual"
  };

  function stopTypeLabel(value) {
    const found = STOP_TYPES.find((t) => t.value === value);
    return found ? found.label : String(value || "");
  }

  function isGeographicStopType(stopType) {
    return GEOGRAPHIC_STOP_TYPES.has(String(stopType || "").trim());
  }

  function isAtSeaStopType(stopType) {
    return String(stopType || "").trim() === "at_sea";
  }

  /** Strip combining marks (accents) for matching only. */
  function stripDiacritics(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  /**
   * Normalise port/place text for comparison. Does not alter display wording.
   */
  function normalizePortText(value) {
    let text = stripDiacritics(value);
    text = text.toLowerCase();
    text = text.replace(/[’']/g, "");
    text = text.replace(/&/g, " and ");
    text = text.replace(/[./\\_+]+/g, " ");
    text = text.replace(/[^\w\s(),-]/g, " ");
    text = text.replace(/\s+/g, " ").trim();
    return text;
  }

  function normalizeCountry(value) {
    return normalizePortText(value);
  }

  function buildMatchKey(canonicalName, country) {
    const name = normalizePortText(canonicalName);
    const ctry = normalizeCountry(country);
    if (!name) return "";
    return ctry ? `${name}|${ctry}` : `${name}|`;
  }

  /**
   * Split "City (Alias), Region, Country" style strings.
   * Returns { portText, countryText, bracketInner, bracketOuter }.
   */
  function parseEnteredPortParts(raw) {
    const entered = String(raw || "").trim();
    if (!entered) {
      return { portText: "", countryText: "", bracketInner: "", nameCore: "" };
    }
    const parts = entered.split(",").map((p) => p.trim()).filter(Boolean);
    let countryText = "";
    let namePart = entered;
    if (parts.length >= 2) {
      countryText = parts[parts.length - 1];
      namePart = parts.slice(0, -1).join(", ");
    }
    let bracketInner = "";
    const bracketMatch = namePart.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    let nameCore = namePart;
    if (bracketMatch) {
      nameCore = bracketMatch[1].trim();
      bracketInner = bracketMatch[2].trim();
    }
    return { portText: entered, countryText, bracketInner, nameCore };
  }

  function aliasList(port) {
    const raw = port?.aliases;
    if (Array.isArray(raw)) return raw.map((a) => String(a || "").trim()).filter(Boolean);
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map((a) => String(a || "").trim()).filter(Boolean);
        }
      } catch (_err) {
        /* ignore */
      }
    }
    return [];
  }

  function portSearchHaystacks(port) {
    const names = [
      port.canonical_name,
      port.display_name,
      port.city,
      ...aliasList(port)
    ]
      .map((n) => String(n || "").trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  function formatAutocompleteLabel(port) {
    if (!port) return "";
    if (port.display_name) return String(port.display_name);
    const city = String(port.city || port.canonical_name || "").trim();
    const region = String(port.region || "").trim();
    const country = String(port.country || "").trim();
    const left = region && region.toLowerCase() !== city.toLowerCase() ? `${city}, ${region}` : city;
    return country ? `${left}, ${country}` : left;
  }

  /**
   * Score a catalogue port against entered text. Higher is better.
   * Returns { score, tier: 'strong'|'likely'|'weak', reasons[] }.
   */
  function scorePortMatch(enteredPortText, enteredCountryText, port) {
    const parsed = parseEnteredPortParts(enteredPortText);
    const countryEntered = normalizeCountry(enteredCountryText || parsed.countryText);
    const nameNorm = normalizePortText(parsed.nameCore || parsed.portText);
    const fullNorm = normalizePortText(enteredPortText);
    const bracketNorm = normalizePortText(parsed.bracketInner);
    const portCountry = normalizeCountry(port.country);
    const reasons = [];

    if (!nameNorm && !fullNorm) {
      return { score: 0, tier: "weak", reasons };
    }

    const candidates = portSearchHaystacks(port).map(normalizePortText);
    const canonical = normalizePortText(port.canonical_name);
    const display = normalizePortText(port.display_name);
    const city = normalizePortText(port.city);

    let score = 0;
    const countryExact = countryEntered && portCountry && countryEntered === portCountry;
    const countryMissing = !countryEntered;

    if (countryEntered && portCountry && countryEntered !== portCountry) {
      return { score: 0, tier: "weak", reasons: ["country_mismatch"] };
    }

    const exactNameHit =
      candidates.includes(nameNorm) ||
      candidates.includes(fullNorm) ||
      (bracketNorm && candidates.includes(bracketNorm));

    const matchKeyEntered = buildMatchKey(parsed.nameCore || enteredPortText, countryEntered || port.country);
    if (port.match_key && matchKeyEntered && port.match_key === matchKeyEntered) {
      score = 100;
      reasons.push("exact_match_key");
    } else if (canonical && (canonical === nameNorm || canonical === fullNorm)) {
      score = countryExact || countryMissing ? 98 : 80;
      reasons.push("exact_canonical");
    } else if (display && (display === fullNorm || display === nameNorm)) {
      score = countryExact || countryMissing ? 96 : 78;
      reasons.push("exact_display");
    } else if (exactNameHit) {
      score = countryExact || countryMissing ? 94 : 76;
      reasons.push("exact_alias_or_city");
    } else if (
      bracketNorm &&
      (canonical === bracketNorm || candidates.includes(bracketNorm)) &&
      (nameNorm === city || nameNorm === canonical || candidates.includes(nameNorm))
    ) {
      // Athens (Piraeus) ↔ Piraeus (Athens)
      score = countryExact || countryMissing ? 88 : 70;
      reasons.push("bracket_swap_alias");
    } else if (
      nameNorm &&
      (canonical.includes(nameNorm) ||
        nameNorm.includes(canonical) ||
        candidates.some((c) => c.includes(nameNorm) || nameNorm.includes(c)))
    ) {
      score = countryExact ? 72 : 55;
      reasons.push("partial_name");
    }

    if (countryExact && score > 0) {
      score += 4;
      reasons.push("country_align");
    }

    let tier = "weak";
    if (score >= 92) tier = "strong";
    else if (score >= 70) tier = "likely";

    return { score, tier, reasons };
  }

  /**
   * Classify matches for one entered port against a ports catalogue.
   * @returns {{ status: 'strong'|'likely'|'ambiguous'|'none', matches: object[], primary: object|null }}
   */
  function classifyPortMatches(enteredPortText, enteredCountryText, ports) {
    const scored = (ports || [])
      .map((port) => {
        const result = scorePortMatch(enteredPortText, enteredCountryText, port);
        return { port, ...result };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || String(a.port.canonical_name).localeCompare(String(b.port.canonical_name)));

    if (!scored.length) {
      return { status: "none", matches: [], primary: null };
    }

    const top = scored[0];
    const strong = scored.filter((s) => s.tier === "strong");
    if (strong.length === 1 && strong[0].score >= 92) {
      return { status: "strong", matches: strong, primary: strong[0].port };
    }
    if (strong.length > 1) {
      return { status: "ambiguous", matches: strong, primary: null };
    }

    const nearTop = scored.filter((s) => s.score >= top.score - 8 && s.score >= 70);
    if (nearTop.length > 1) {
      return { status: "ambiguous", matches: nearTop, primary: null };
    }
    if (top.tier === "likely" || top.tier === "strong") {
      return { status: "likely", matches: [top], primary: top.port };
    }
    return { status: "none", matches: [], primary: null };
  }

  function searchPorts(query, ports, { limit = 12 } = {}) {
    const q = normalizePortText(query);
    if (!q) return [];
    const scored = [];
    for (const port of ports || []) {
      const labels = portSearchHaystacks(port);
      const country = normalizeCountry(port.country);
      let best = 0;
      for (const label of labels) {
        const n = normalizePortText(label);
        if (!n) continue;
        if (n === q) best = Math.max(best, 100);
        else if (n.startsWith(q)) best = Math.max(best, 90);
        else if (n.includes(q)) best = Math.max(best, 75);
        else if (q.includes(n) && n.length >= 3) best = Math.max(best, 60);
      }
      if (country && country.includes(q)) best = Math.max(best, 40);
      if (best > 0) scored.push({ port, score: best });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        String(a.port.canonical_name || "").localeCompare(String(b.port.canonical_name || ""))
    );
    // Collapse duplicate canonical ids (aliases must not appear as separate ports).
    const seen = new Set();
    const out = [];
    for (const row of scored) {
      if (seen.has(row.port.id)) continue;
      seen.add(row.port.id);
      out.push(row.port);
      if (out.length >= limit) break;
    }
    return out;
  }

  function blankStop(order = 1, extras = {}) {
    return {
      localId: extras.localId || `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      id: extras.id || null,
      display_order: order,
      // Day is optional sailing-day metadata — never invent consecutive days from list order.
      day_number: Object.prototype.hasOwnProperty.call(extras, "day_number")
        ? extras.day_number
        : "",
      stop_date: extras.stop_date || "",
      stop_type: extras.stop_type || "port_call",
      port_id: extras.port_id || null,
      port: extras.port || null,
      entered_port_text: extras.entered_port_text || "",
      entered_country_text: extras.entered_country_text || "",
      arrival_time: extras.arrival_time || "",
      departure_time: extras.departure_time || "",
      is_overnight: Boolean(extras.is_overnight),
      notes: extras.notes || "",
      matchDecision: extras.matchDecision || null // 'use_existing' | 'create_new' | null
    };
  }

  function normalizeStopOrder(stops) {
    return (stops || []).map((stop, index) => ({
      ...stop,
      display_order: index + 1
    }));
  }

  function mapStopFromDb(row, portsById = {}) {
    const port = row.port_id ? portsById[row.port_id] || row.ports || null : null;
    return blankStop(row.display_order || 1, {
      id: row.id,
      localId: row.id || undefined,
      day_number: row.day_number,
      stop_date: row.stop_date || "",
      stop_type: row.stop_type || "port_call",
      port_id: row.port_id || null,
      port,
      entered_port_text: row.entered_port_text || "",
      entered_country_text: row.entered_country_text || "",
      arrival_time: row.arrival_time || "",
      departure_time: row.departure_time || "",
      is_overnight: Boolean(row.is_overnight),
      notes: row.notes || ""
    });
  }

  /**
   * Parse legacy pipe-separated itinerary_summary into structured draft rows.
   * Does not invent geographic facts beyond comma country suffix.
   *
   * Accepts: "Barcelona, Spain | Palma de Mallorca, Spain | Lisbon, Portugal"
   */
  function parseLegacyItinerarySummary(summary) {
    const parts = String(summary || "")
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return { stops: [], reliable: true };

    const stops = parts.map((part, index) => {
      const parsed = parseEnteredPortParts(part);
      const lower = part.toLowerCase();
      let stopType = "port_call";
      if (/^at\s*sea$/.test(lower) || lower === "sea day") stopType = "at_sea";
      else if (/scenic/.test(lower)) stopType = "scenic_cruising";
      return blankStop(index + 1, {
        day_number: "",
        stop_type: stopType,
        // Keep full pasted label for newsletter PORTS OF CALL wording.
        entered_port_text: stopType === "at_sea" ? "" : part,
        entered_country_text: stopType === "at_sea" ? "" : parsed.countryText || ""
      });
    });

    return { stops, reliable: true };
  }

  /**
   * Build ordered itinerary stops from a pasted port list.
   * First stop → embarkation, last → disembarkation (when 2+ geographic ports).
   */
  function buildStopsFromPortList(summary) {
    const parsed = parseLegacyItinerarySummary(summary);
    const stops = parsed.stops || [];
    if (!stops.length) return { stops: [], reliable: true, portCount: 0 };

    const geoIndexes = [];
    stops.forEach((stop, index) => {
      if (!isAtSeaStopType(stop.stop_type) && isGeographicStopType(stop.stop_type)) {
        geoIndexes.push(index);
      } else if (
        !isAtSeaStopType(stop.stop_type) &&
        stop.stop_type !== "scenic_cruising" &&
        String(stop.entered_port_text || "").trim()
      ) {
        geoIndexes.push(index);
      }
    });

    if (geoIndexes.length === 1) {
      stops[geoIndexes[0]].stop_type = "embarkation";
    } else if (geoIndexes.length >= 2) {
      stops[geoIndexes[0]].stop_type = "embarkation";
      stops[geoIndexes[geoIndexes.length - 1]].stop_type = "disembarkation";
    }

    return {
      stops: normalizeStopOrder(stops),
      reliable: true,
      portCount: geoIndexes.length
    };
  }

  /**
   * Assign sailing-day numbers only when they are knowable.
   *
   * - Embarkation → Day 1
   * - Disembarkation → Day (nights + 1) when nights is set
   * - If geographic stops exactly fill every day (count === nights + 1),
   *   assign sequential Day 1…N (no room for sea days)
   * - Otherwise leave intermediate port days blank — sea days make them unknown
   *
   * Stop order (display_order) is independent and always 1…N.
   */
  function applyKnownDayNumbers(stops, nights, options = {}) {
    const forceClearMiddle = options.forceClearMiddle !== false;
    const ordered = normalizeStopOrder(stops || []).map((s) => ({ ...s }));
    const nightsNum = nights === "" || nights == null ? null : Number(nights);
    const hasNights = Number.isFinite(nightsNum) && nightsNum >= 0;
    const lastDay = hasNights ? nightsNum + 1 : null;

    const geoIndexes = [];
    ordered.forEach((stop, index) => {
      if (isAtSeaStopType(stop.stop_type)) return;
      if (isGeographicStopType(stop.stop_type) || stop.stop_type === "scenic_cruising") {
        geoIndexes.push(index);
      }
    });

    const fullPacked = Boolean(lastDay && geoIndexes.length === lastDay);

    for (let i = 0; i < ordered.length; i += 1) {
      const stop = ordered[i];
      if (isAtSeaStopType(stop.stop_type)) {
        if (forceClearMiddle) stop.day_number = "";
        continue;
      }

      if (stop.stop_type === "embarkation") {
        stop.day_number = 1;
        continue;
      }

      if (stop.stop_type === "disembarkation") {
        stop.day_number = lastDay != null ? lastDay : "";
        continue;
      }

      if (fullPacked) {
        const geoPos = geoIndexes.indexOf(i);
        stop.day_number = geoPos >= 0 ? geoPos + 1 : "";
        continue;
      }

      // Intermediate ports — day unknown when sea days exist.
      const dayNum =
        stop.day_number === "" || stop.day_number == null ? null : Number(stop.day_number);
      const looksInvented =
        dayNum != null && Number.isFinite(dayNum) && dayNum === Number(stop.display_order);
      if (forceClearMiddle || looksInvented) {
        stop.day_number = "";
      }
    }

    return ordered;
  }

  function customerFacingPortLabel(stop) {
    const entered = String(stop.entered_port_text || "").trim();
    if (entered) return entered;
    if (stop.port) return formatAutocompleteLabel(stop.port);
    return "";
  }

  /** Compact PORTS OF CALL list — geographic stops only, preserve display wording. */
  function buildPortsJoinedFromStops(stops) {
    const labels = [];
    for (const stop of stops || []) {
      if (isAtSeaStopType(stop.stop_type)) continue;
      if (stop.stop_type === "other" && !String(stop.entered_port_text || "").trim() && !stop.port_id) {
        continue;
      }
      if (!isGeographicStopType(stop.stop_type) && stop.stop_type !== "scenic_cruising") {
        if (!String(stop.entered_port_text || "").trim()) continue;
      }
      const label = customerFacingPortLabel(stop);
      if (label) labels.push(label);
    }
    return labels.join(" | ");
  }

  /**
   * Deterministic route signature from map-relevant stops.
   * Excludes At Sea, notes, times.
   */
  function buildRouteSignature(stops) {
    const parts = [];
    const ordered = normalizeStopOrder(stops || []);
    for (const stop of ordered) {
      if (isAtSeaStopType(stop.stop_type)) continue;
      if (!isGeographicStopType(stop.stop_type) && stop.stop_type !== "scenic_cruising") continue;
      const portKey = stop.port_id || normalizePortText(stop.entered_port_text) || "";
      if (!portKey && stop.stop_type === "scenic_cruising") {
        parts.push(`${stop.display_order}:scenic_cruising:`);
        continue;
      }
      if (!portKey) continue;
      parts.push(`${stop.display_order}:${stop.stop_type}:${portKey}`);
    }
    return parts.join(";");
  }

  function hasRouteMapAsset(cruiseOrDraft) {
    return Boolean(
      cruiseOrDraft?.route_map_media_id ||
        String(cruiseOrDraft?.route_map_image_url || "").trim()
    );
  }

  /**
   * Compute next route_map_status given previous status/signature and new signature.
   */
  function nextRouteMapStatus({ previousStatus, previousSignature, nextSignature, hasMap }) {
    if (!hasMap) return ROUTE_MAP_STATUSES.MISSING;
    const prevSig = String(previousSignature || "");
    const nextSig = String(nextSignature || "");
    if (prevSig && nextSig && prevSig !== nextSig) {
      return ROUTE_MAP_STATUSES.NEEDS_REGENERATION;
    }
    const prev = String(previousStatus || "").trim();
    if (prev === ROUTE_MAP_STATUSES.NEEDS_REGENERATION && prevSig === nextSig) {
      return ROUTE_MAP_STATUSES.NEEDS_REGENERATION;
    }
    if (prev === ROUTE_MAP_STATUSES.MANUAL) return ROUTE_MAP_STATUSES.MANUAL;
    if (prev === ROUTE_MAP_STATUSES.CURRENT) return ROUTE_MAP_STATUSES.CURRENT;
    return ROUTE_MAP_STATUSES.MANUAL;
  }

  function timeLooksValid(value) {
    const raw = String(value || "").trim();
    if (!raw) return true;
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const [h, m] = raw.split(":").map(Number);
      return h >= 0 && h <= 23 && m >= 0 && m <= 59;
    }
    if (/^\d{1,2}:\d{2}\s*[AaPp][Mm]$/.test(raw)) return true;
    return false;
  }

  function validateStops(stops) {
    const errors = [];
    const list = stops || [];
    list.forEach((stop, index) => {
      const n = index + 1;
      const type = String(stop.stop_type || "").trim();
      if (!STOP_TYPES.some((t) => t.value === type)) {
        errors.push(`Stop ${n}: choose a valid stop type.`);
        return;
      }
      if (isGeographicStopType(type)) {
        const portText = String(stop.entered_port_text || "").trim();
        if (!stop.port_id && !portText) {
          errors.push(`Stop ${n}: enter a port or choose one from autocomplete.`);
        }
      }
      if (!timeLooksValid(stop.arrival_time)) {
        errors.push(`Stop ${n}: arrival time is not recognised (use HH:MM or leave blank).`);
      }
      if (!timeLooksValid(stop.departure_time)) {
        errors.push(`Stop ${n}: departure time is not recognised (use HH:MM or leave blank).`);
      }
    });

    const dayCounts = new Map();
    list.forEach((stop) => {
      const day = stop.day_number;
      if (day == null || day === "") return;
      const key = String(day);
      dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
    });
    // Multiple stops on one day are allowed — no error.
    return { ok: errors.length === 0, errors };
  }

  function rowStatusFlags(stop) {
    const flags = [];
    if (isAtSeaStopType(stop.stop_type)) {
      flags.push("At Sea");
      return flags;
    }
    if (!isGeographicStopType(stop.stop_type) && stop.stop_type !== "scenic_cruising") {
      if (stop.port_id) flags.push("Matched");
      return flags;
    }
    if (stop.port_id && stop.port) {
      const st = stop.port.status || "verified";
      if (st === "verified") flags.push("Matched");
      else if (st === "provisional") flags.push("Provisional");
      else flags.push("Needs Review");
      const lat = stop.port.latitude;
      const lng = stop.port.longitude;
      if (lat == null || lng == null || lat === "" || lng === "") {
        flags.push("Missing Coordinates");
      }
    } else if (String(stop.entered_port_text || "").trim()) {
      flags.push("Unresolved");
      if (!String(stop.entered_country_text || "").trim()) flags.push("Missing Country");
    } else {
      flags.push("Incomplete");
    }
    return flags;
  }

  function summarizePortStatus(stops) {
    let verified = 0;
    let provisional = 0;
    let needsReview = 0;
    let missingCountry = 0;
    let missingCoordinates = 0;
    let unresolved = 0;
    let mapped = 0;
    let geographic = 0;

    for (const stop of stops || []) {
      if (isAtSeaStopType(stop.stop_type)) continue;
      if (!isGeographicStopType(stop.stop_type) && stop.stop_type !== "scenic_cruising") continue;
      geographic += 1;
      if (stop.port_id && stop.port) {
        mapped += 1;
        const st = stop.port.status || "verified";
        if (st === "verified") verified += 1;
        else if (st === "provisional") provisional += 1;
        else needsReview += 1;
        if (stop.port.latitude == null || stop.port.longitude == null) missingCoordinates += 1;
      } else if (String(stop.entered_port_text || "").trim()) {
        unresolved += 1;
        if (!String(stop.entered_country_text || "").trim()) missingCountry += 1;
      }
    }

    return {
      totalStops: (stops || []).length,
      geographic,
      mapped,
      verified,
      provisional,
      needsReview,
      missingCountry,
      missingCoordinates,
      unresolved,
      readyForAutoMap:
        geographic > 0 &&
        unresolved === 0 &&
        missingCoordinates === 0 &&
        needsReview === 0
    };
  }

  function summarizeRouteMapReadiness(stops, cruiseOrDraft) {
    const portSummary = summarizePortStatus(stops);
    const hasMap = hasRouteMapAsset(cruiseOrDraft);
    const status = cruiseOrDraft?.route_map_status || (hasMap ? ROUTE_MAP_STATUSES.MANUAL : ROUTE_MAP_STATUSES.MISSING);
    return {
      ...portSummary,
      hasMap,
      routeMapStatus: status,
      statusLabel: {
        current: "Current",
        needs_regeneration: "Needs regeneration",
        missing: "Missing",
        manual: "Manual"
      }[status] || status
    };
  }

  function stopsToDbRows(stops, featuredCruiseId) {
    return normalizeStopOrder(stops).map((stop) => {
      const geographic = isGeographicStopType(stop.stop_type);
      const atSea = isAtSeaStopType(stop.stop_type);
      return {
        featured_cruise_id: featuredCruiseId,
        display_order: stop.display_order,
        day_number:
          stop.day_number === "" || stop.day_number == null ? null : Number(stop.day_number) || null,
        stop_date: stop.stop_date || null,
        stop_type: stop.stop_type,
        port_id: atSea ? null : stop.port_id || null,
        entered_port_text: atSea
          ? null
          : String(stop.entered_port_text || "").trim() || null,
        entered_country_text: atSea
          ? null
          : String(stop.entered_country_text || "").trim() || null,
        arrival_time: String(stop.arrival_time || "").trim() || null,
        departure_time: String(stop.departure_time || "").trim() || null,
        is_overnight: Boolean(stop.is_overnight) || stop.stop_type === "overnight_port",
        notes: String(stop.notes || "").trim() || null
      };
    });
  }

  function provisionalPortPayload({ enteredPortText, enteredCountryText, featuredCruiseId }) {
    const parsed = parseEnteredPortParts(enteredPortText);
    const canonical =
      String(parsed.nameCore || enteredPortText || "")
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim() || String(enteredPortText || "").trim();
    const country = String(enteredCountryText || parsed.countryText || "").trim() || null;
    const display = String(enteredPortText || "").trim() || canonical;
    return {
      canonical_name: canonical,
      display_name: display,
      city: canonical,
      country,
      aliases: [],
      status: "provisional",
      source: "featured_cruise_itinerary",
      source_featured_cruise_id: featuredCruiseId || null,
      match_key: buildMatchKey(canonical, country || ""),
      latitude: null,
      longitude: null
    };
  }

  const api = {
    STOP_TYPES,
    GEOGRAPHIC_STOP_TYPES,
    ROUTE_MAP_STATUSES,
    stopTypeLabel,
    isGeographicStopType,
    isAtSeaStopType,
    stripDiacritics,
    normalizePortText,
    normalizeCountry,
    buildMatchKey,
    parseEnteredPortParts,
    formatAutocompleteLabel,
    scorePortMatch,
    classifyPortMatches,
    searchPorts,
    blankStop,
    normalizeStopOrder,
    mapStopFromDb,
    parseLegacyItinerarySummary,
    buildStopsFromPortList,
    applyKnownDayNumbers,
    customerFacingPortLabel,
    buildPortsJoinedFromStops,
    buildRouteSignature,
    hasRouteMapAsset,
    nextRouteMapStatus,
    timeLooksValid,
    validateStops,
    rowStatusFlags,
    summarizePortStatus,
    summarizeRouteMapReadiness,
    stopsToDbRows,
    provisionalPortPayload,
    aliasList
  };

  global.FeaturedCruiseItinerary = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
