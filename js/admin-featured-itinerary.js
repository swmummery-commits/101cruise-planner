/**
 * Sprint 13D — Featured Cruise structured itinerary editor (Admin).
 * Depends on FeaturedCruiseItinerary + supabaseClient on window.
 */
(function (global) {
  "use strict";

  const I = () => global.FeaturedCruiseItinerary;

  let stops = [];
  let portsCache = [];
  let portsLoaded = false;
  let legacySummary = "";
  let needsStructuring = false;
  let structuredLoaded = false;
  let matchPrompt = null; // { localId, entered, country, candidates, status }
  let autocomplete = { localId: null, query: "", open: false };
  let draggedLocalId = null;
  let dragFromHandle = false;
  let routeMapStatus = "missing";
  let routeMapSignature = "";
  let sectionOpen = true;
  /** @type {Set<string>|null} null = auto-open stops that need attention */
  let openStopIds = null;
  let portListPaste = "";
  let portListBusy = false;
  let portListMessage = "";
  let portListMessageTone = "";

  function stopNeedsAttention(stop) {
    const flags = I().rowStatusFlags(stop);
    return flags.some((f) =>
      /Unresolved|Missing|Needs Review|Incomplete|Provisional/i.test(String(f))
    );
  }

  function isStopOpen(stop) {
    if (openStopIds instanceof Set) return openStopIds.has(stop.localId);
    return stopNeedsAttention(stop);
  }

  function ensureOpenStopSet() {
    if (openStopIds instanceof Set) return openStopIds;
    openStopIds = new Set(stops.filter(stopNeedsAttention).map((s) => s.localId));
    return openStopIds;
  }

  function toggleSection() {
    captureFromDom();
    sectionOpen = !sectionOpen;
    rerender();
  }

  function toggleStop(localId) {
    captureFromDom();
    const set = ensureOpenStopSet();
    if (set.has(localId)) set.delete(localId);
    else set.add(localId);
    rerender();
  }

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function client() {
    return global.supabaseClient || global.window?.supabaseClient;
  }

  function reset() {
    stops = [];
    legacySummary = "";
    needsStructuring = false;
    structuredLoaded = false;
    matchPrompt = null;
    autocomplete = { localId: null, query: "", open: false };
    draggedLocalId = null;
    dragFromHandle = false;
    routeMapStatus = "missing";
    routeMapSignature = "";
    sectionOpen = true;
    openStopIds = null;
    portListPaste = "";
    portListBusy = false;
    portListMessage = "";
    portListMessageTone = "";
  }

  function getStops() {
    return stops;
  }

  function setStops(next) {
    stops = I().normalizeStopOrder(next || []);
  }

  async function ensurePortsLoaded({ force = false } = {}) {
    if (portsLoaded && !force) return portsCache;
    const sb = client();
    if (!sb) return portsCache;
    const { data, error } = await sb
      .from("ports")
      .select(
        "id,canonical_name,display_name,city,country,country_code,region,latitude,longitude,aliases,status,match_key,source"
      )
      .order("canonical_name", { ascending: true })
      .limit(2000);
    if (error) {
      console.warn("ports load skipped", error.message);
      portsLoaded = true;
      return portsCache;
    }
    portsCache = data || [];
    portsLoaded = true;
    return portsCache;
  }

  function portsByIdMap() {
    const map = {};
    for (const port of portsCache) map[port.id] = port;
    return map;
  }

  async function loadForCruise(cruise) {
    reset();
    routeMapStatus = cruise?.route_map_status || "missing";
    routeMapSignature = cruise?.route_map_itinerary_signature || "";
    legacySummary = String(cruise?.itinerary_summary || "").trim();
    await ensurePortsLoaded();
    const sb = client();
    if (!sb || !cruise?.id) {
      if (legacySummary) {
        const parsed = I().parseLegacyItinerarySummary(legacySummary);
        stops = parsed.stops;
        needsStructuring = false;
        structuredLoaded = false;
      } else {
        stops = [I().blankStop(1, { stop_type: "embarkation" })];
      }
      return;
    }

    const { data, error } = await sb
      .from("featured_cruise_itinerary_stops")
      .select("*")
      .eq("featured_cruise_id", cruise.id)
      .order("display_order", { ascending: true });

    if (error) {
      // Table may not exist yet before migration — fall back to legacy.
      console.warn("itinerary stops load skipped", error.message);
      if (legacySummary) {
        const parsed = I().parseLegacyItinerarySummary(legacySummary);
        stops = parsed.stops;
        needsStructuring = false;
      } else {
        stops = [I().blankStop(1, { stop_type: "embarkation" })];
      }
      return;
    }

    if (data?.length) {
      const byId = portsByIdMap();
      stops = data.map((row) => I().mapStopFromDb(row, byId));
      structuredLoaded = true;
      needsStructuring = false;
      return;
    }

    if (legacySummary) {
      const parsed = I().parseLegacyItinerarySummary(legacySummary);
      stops = parsed.stops;
      needsStructuring = true;
      structuredLoaded = false;
      return;
    }

    stops = [I().blankStop(1, { stop_type: "embarkation" })];
  }

  function initNewCruise() {
    reset();
    stops = [I().blankStop(1, { stop_type: "embarkation" }), I().blankStop(2, { stop_type: "at_sea" })];
    ensurePortsLoaded();
  }

  function captureFromDom() {
    capturePortListPasteFromDom();
    if (!document.getElementById("fcItineraryList")) return stops;
    const next = [];
    document.querySelectorAll("#fcItineraryList .fc-itin-row").forEach((row, index) => {
      const localId = row.getAttribute("data-local-id") || `stop-${index + 1}`;
      const prev = stops.find((s) => s.localId === localId) || {};
      const stopType = row.querySelector("[data-fc-itin='stop_type']")?.value || "port_call";
      const atSea = I().isAtSeaStopType(stopType);
      next.push({
        ...prev,
        localId,
        id: prev.id || null,
        display_order: index + 1,
        day_number: row.querySelector("[data-fc-itin='day_number']")?.value || "",
        stop_date: row.querySelector("[data-fc-itin='stop_date']")?.value || "",
        stop_type: stopType,
        entered_port_text: atSea ? "" : row.querySelector("[data-fc-itin='port']")?.value || "",
        entered_country_text: atSea ? "" : row.querySelector("[data-fc-itin='country']")?.value || "",
        arrival_time: row.querySelector("[data-fc-itin='arrival']")?.value || "",
        departure_time: row.querySelector("[data-fc-itin='departure']")?.value || "",
        is_overnight:
          Boolean(row.querySelector("[data-fc-itin='overnight']")?.checked) ||
          stopType === "overnight_port",
        notes: row.querySelector("[data-fc-itin='notes']")?.value || "",
        port_id: atSea ? null : prev.port_id || null,
        port: atSea ? null : prev.port || null,
        matchDecision: prev.matchDecision || null
      });
    });
    stops = I().normalizeStopOrder(next);
    return stops;
  }

  function syncSummaryIntoDraft(draft) {
    if (!draft) return;
    const joined = I().buildPortsJoinedFromStops(stops);
    draft.itinerary_summary = joined || legacySummary || draft.itinerary_summary || "";
    draft.route_map_status = routeMapStatus;
    draft.route_map_itinerary_signature = routeMapSignature;
    draft.itinerary_stops = stops;
  }

  function findStop(localId) {
    return stops.find((s) => s.localId === localId);
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function addStop() {
    captureFromDom();
    stops.push(
      I().blankStop(stops.length + 1, {
        day_number: "",
        stop_type: "port_call"
      })
    );
    needsStructuring = false;
    rerender();
  }

  function duplicateStop(localId) {
    captureFromDom();
    const idx = stops.findIndex((s) => s.localId === localId);
    if (idx < 0) return;
    const copy = I().blankStop(idx + 2, {
      ...stops[idx],
      id: null,
      localId: undefined,
      matchDecision: null
    });
    stops.splice(idx + 1, 0, copy);
    stops = I().normalizeStopOrder(stops);
    rerender();
  }

  function removeStop(localId) {
    captureFromDom();
    stops = I().normalizeStopOrder(stops.filter((s) => s.localId !== localId));
    if (!stops.length) stops = [I().blankStop(1, { stop_type: "at_sea" })];
    rerender();
  }

  function clearPortMatch(localId) {
    captureFromDom();
    const stop = findStop(localId);
    if (!stop) return;
    stop.port_id = null;
    stop.port = null;
    stop.matchDecision = null;
    rerender();
  }

  function selectPort(localId, portId) {
    captureFromDom();
    const stop = findStop(localId);
    const port = portsCache.find((p) => p.id === portId);
    if (!stop || !port) return;
    stop.port_id = port.id;
    stop.port = port;
    stop.matchDecision = "use_existing";
    if (!String(stop.entered_port_text || "").trim()) {
      stop.entered_port_text = I().formatAutocompleteLabel(port);
    }
    if (!String(stop.entered_country_text || "").trim() && port.country) {
      stop.entered_country_text = port.country;
    }
    autocomplete = { localId: null, query: "", open: false };
    matchPrompt = null;
    rerender();
  }

  function onPortInput(localId, value) {
    captureFromDom();
    const stop = findStop(localId);
    if (stop) {
      stop.entered_port_text = value;
      if (stop.port_id && stop.port) {
        const normalizedEntered = I().normalizePortText(value);
        const hay = I()
          .aliasList(stop.port)
          .concat([stop.port.canonical_name, stop.port.display_name, stop.port.city])
          .map((x) => I().normalizePortText(x))
          .filter(Boolean);
        const stillRelated = hay.some(
          (h) => h === normalizedEntered || normalizedEntered.includes(h) || h.includes(normalizedEntered)
        );
        if (!stillRelated) {
          stop.port_id = null;
          stop.port = null;
          stop.matchDecision = null;
        }
      }
    }
    autocomplete = { localId, query: value, open: Boolean(String(value || "").trim()) };
    rerender();
  }

  function onStopTypeChange(localId, value) {
    captureFromDom();
    const stop = findStop(localId);
    if (!stop) return;
    stop.stop_type = value;
    if (I().isAtSeaStopType(value)) {
      stop.port_id = null;
      stop.port = null;
      stop.entered_port_text = "";
      stop.entered_country_text = "";
    }
    if (value === "overnight_port") stop.is_overnight = true;
    rerender();
  }

  function importLegacyNow() {
    if (!legacySummary) return;
    const parsed = I().parseLegacyItinerarySummary(legacySummary);
    stops = parsed.stops;
    needsStructuring = false;
    matchPrompt = null;
    rerender();
  }

  function capturePortListPasteFromDom() {
    const el = document.getElementById("fcPortListPaste");
    if (el) portListPaste = el.value || "";
    return portListPaste;
  }

  async function authHeaders() {
    if (typeof global.adminAuthHeaders === "function") {
      return global.adminAuthHeaders({ "Content-Type": "application/json" });
    }
    const sb = client();
    const { data } = await sb.auth.getSession();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session?.access_token || ""}`
    };
  }

  async function createOrLinkPortForStop(working, featuredCruiseId) {
    const entered = String(working.entered_port_text || "").trim();
    if (!entered) return working;
    if (I().isAtSeaStopType(working.stop_type)) return working;

    const classified = I().classifyPortMatches(
      entered,
      working.entered_country_text,
      portsCache
    );

    // Frictionless paste: strong or unique likely → use existing.
    if (classified.primary && (classified.status === "strong" || classified.status === "likely")) {
      working.port_id = classified.primary.id;
      working.port = classified.primary;
      working.matchDecision = "use_existing";
      return working;
    }

    // Ambiguous with a clear top score → use top; otherwise create provisional.
    if (classified.status === "ambiguous" && classified.matches?.length) {
      const top = classified.matches[0];
      const second = classified.matches[1];
      const topScore = Number(top.score) || 0;
      const secondScore = Number(second?.score) || 0;
      if (topScore >= 85 && topScore - secondScore >= 8 && top.port) {
        working.port_id = top.port.id;
        working.port = top.port;
        working.matchDecision = "use_existing";
        return working;
      }
    }

    const payload = I().provisionalPortPayload({
      enteredPortText: entered,
      enteredCountryText: working.entered_country_text,
      featuredCruiseId
    });
    const existing = portsCache.find((p) => p.match_key && p.match_key === payload.match_key);
    if (existing) {
      working.port_id = existing.id;
      working.port = existing;
      working.matchDecision = "use_existing";
      return working;
    }

    const sb = client();
    const { data, error } = await sb.from("ports").insert(payload).select("*").single();
    if (error) {
      if (/duplicate|unique/i.test(error.message || "")) {
        await ensurePortsLoaded({ force: true });
        const again = portsCache.find((p) => p.match_key === payload.match_key);
        if (again) {
          working.port_id = again.id;
          working.port = again;
          working.matchDecision = "use_existing";
          return working;
        }
      }
      throw new Error(`Could not create port “${entered}”: ${error.message}`);
    }
    portsCache.push(data);
    working.port_id = data.id;
    working.port = data;
    working.matchDecision = "create_new";
    return working;
  }

  async function geocodeMissingPorts(portIds) {
    const ids = [...new Set((portIds || []).filter(Boolean))];
    if (!ids.length) return { updated: 0, failed: 0, results: [] };
    const headers = await authHeaders();
    const response = await fetch("/.netlify/functions/geocode-ports", {
      method: "POST",
      headers,
      body: JSON.stringify({ port_ids: ids })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || data.error || `Geocode failed (HTTP ${response.status})`);
    }
    for (const row of data.results || []) {
      if (!row.ok || row.latitude == null || row.longitude == null) continue;
      const cached = portsCache.find((p) => p.id === row.id);
      if (cached) {
        cached.latitude = row.latitude;
        cached.longitude = row.longitude;
      }
      for (const stop of stops) {
        if (stop.port_id === row.id && stop.port) {
          stop.port = { ...stop.port, latitude: row.latitude, longitude: row.longitude };
        }
      }
    }
    return data;
  }

  /**
   * Paste "City, Country | City, Country | …" → structured stops + Ports rows + coordinates.
   */
  async function applyPortListPaste() {
    capturePortListPasteFromDom();
    const raw = String(portListPaste || "").trim();
    if (!raw) {
      portListMessage = "Paste a pipe-separated port list first.";
      portListMessageTone = "error";
      rerender();
      return;
    }

    const built = I().buildStopsFromPortList(raw);
    if (!built.stops.length) {
      portListMessage = "No ports found in that list. Use: City, Country | City, Country";
      portListMessageTone = "error";
      rerender();
      return;
    }

    const replaceExisting =
      !stops.length ||
      window.confirm(
        `Replace the current ${stops.length} itinerary stop${stops.length === 1 ? "" : "s"} with ${built.stops.length} ports from your list?`
      );
    if (!replaceExisting) return;

    try {
      portListBusy = true;
      portListMessage = "Splitting ports and matching the Ports database…";
      portListMessageTone = "running";
      matchPrompt = null;
      rerender();

      await ensurePortsLoaded({ force: true });
      const featuredCruiseId =
        (typeof global.getEditingFeaturedCruiseId === "function"
          ? global.getEditingFeaturedCruiseId()
          : null) || null;

      let next = built.stops.map((s) => ({ ...s }));
      for (let i = 0; i < next.length; i += 1) {
        next[i] = await createOrLinkPortForStop(next[i], featuredCruiseId);
      }
      stops = I().normalizeStopOrder(next);
      needsStructuring = false;
      legacySummary = I().buildPortsJoinedFromStops(stops) || raw;

      const draft =
        typeof global.getFeaturedFormDraft === "function" ? global.getFeaturedFormDraft() : null;
      if (draft) syncSummaryIntoDraft(draft);

      const missingCoordIds = stops
        .filter(
          (s) =>
            s.port_id &&
            s.port &&
            (s.port.latitude == null || s.port.longitude == null)
        )
        .map((s) => s.port_id);

      if (missingCoordIds.length) {
        portListMessage = `Looking up coordinates for ${missingCoordIds.length} port${missingCoordIds.length === 1 ? "" : "s"}…`;
        portListMessageTone = "running";
        rerender();
        const geo = await geocodeMissingPorts(missingCoordIds);
        const failed = Number(geo.failed) || 0;
        const updated = Number(geo.updated) || 0;
        const summary = I().summarizePortStatus(stops);
        portListMessage = failed
          ? `Applied ${stops.length} ports. Coordinates updated for ${updated}; ${failed} still need coordinates (add manually or retry).`
          : `Applied ${stops.length} ports. ${updated} new coordinate${updated === 1 ? "" : "s"} saved. ${
              summary.readyForAutoMap ? "Ready for Generate Route Map after you save." : "Review any remaining flags, then save."
            }`;
        portListMessageTone = failed ? "error" : "success";
      } else {
        const summary = I().summarizePortStatus(stops);
        portListMessage = `Applied ${stops.length} ports from your list.${
          summary.readyForAutoMap ? " Ready for Generate Route Map after you save." : ""
        }`;
        portListMessageTone = "success";
      }

      openStopIds = new Set(stops.filter(stopNeedsAttention).map((s) => s.localId));
      sectionOpen = true;
    } catch (error) {
      portListMessage = error.message || "Could not apply the port list.";
      portListMessageTone = "error";
    } finally {
      portListBusy = false;
      rerender();
    }
  }

  function onDragHandleDown() {
    dragFromHandle = true;
  }

  function onDragStart(event, localId) {
    if (!dragFromHandle) {
      event.preventDefault();
      return;
    }
    draggedLocalId = localId;
    event.currentTarget.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", localId);
  }

  function onDragEnd(event) {
    event.currentTarget?.classList.remove("is-dragging");
    draggedLocalId = null;
    dragFromHandle = false;
  }

  function allowDrop(event) {
    event.preventDefault();
  }

  function onDrop(event) {
    event.preventDefault();
    captureFromDom();
    if (!draggedLocalId) return;
    const list = document.getElementById("fcItineraryList");
    if (!list) return;
    const dragged = list.querySelector(`.fc-itin-row[data-local-id="${CSS.escape(String(draggedLocalId))}"]`);
    if (!dragged) return;
    const rows = Array.from(list.querySelectorAll(".fc-itin-row:not(.is-dragging)"));
    let after = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        after = row;
        break;
      }
    }
    if (after) list.insertBefore(dragged, after);
    else list.appendChild(dragged);
    captureFromDom();
    draggedLocalId = null;
    dragFromHandle = false;
    rerender();
  }

  function resolveMatchUseExisting() {
    if (!matchPrompt?.candidates?.length) return;
    selectPort(matchPrompt.localId, matchPrompt.candidates[0].id);
  }

  function resolveMatchCreateNew() {
    if (!matchPrompt) return;
    captureFromDom();
    const stop = findStop(matchPrompt.localId);
    if (stop) {
      stop.port_id = null;
      stop.port = null;
      stop.matchDecision = "create_new";
    }
    matchPrompt = null;
    rerender();
  }

  function resolveAmbiguous(portId) {
    if (!matchPrompt) return;
    selectPort(matchPrompt.localId, portId);
  }

  function dismissMatchPrompt() {
    matchPrompt = null;
    rerender();
  }

  /**
   * Prepare stops for save: auto-link strong matches, surface likely/ambiguous, create provisional.
   * @returns {{ ok: boolean, errors: string[], stops: object[], createdPorts: object[] }}
   */
  async function prepareStopsForSave({ featuredCruiseId, confirmCreateNew = true } = {}) {
    captureFromDom();
    await ensurePortsLoaded({ force: true });
    const validation = I().validateStops(stops);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors, stops, createdPorts: [] };
    }

    const createdPorts = [];
    const nextStops = [];

    for (const stop of stops) {
      const working = { ...stop };
      if (I().isAtSeaStopType(working.stop_type)) {
        working.port_id = null;
        working.port = null;
        working.entered_port_text = "";
        working.entered_country_text = "";
        nextStops.push(working);
        continue;
      }

      if (!I().isGeographicStopType(working.stop_type) && working.stop_type !== "scenic_cruising") {
        nextStops.push(working);
        continue;
      }

      if (working.port_id && working.port) {
        nextStops.push(working);
        continue;
      }

      const entered = String(working.entered_port_text || "").trim();
      if (!entered) {
        nextStops.push(working);
        continue;
      }

      // Scenic cruising may stay unlinked; never invent a provisional geo port for it.
      if (working.stop_type === "scenic_cruising") {
        const scenicMatch = I().classifyPortMatches(
          entered,
          working.entered_country_text,
          portsCache
        );
        if (scenicMatch.status === "strong" && scenicMatch.primary) {
          working.port_id = scenicMatch.primary.id;
          working.port = scenicMatch.primary;
        }
        nextStops.push(working);
        continue;
      }

      if (working.matchDecision === "create_new") {
        const payload = I().provisionalPortPayload({
          enteredPortText: entered,
          enteredCountryText: working.entered_country_text,
          featuredCruiseId
        });
        // Avoid duplicate create when match_key already exists.
        const existing = portsCache.find((p) => p.match_key && p.match_key === payload.match_key);
        if (existing) {
          working.port_id = existing.id;
          working.port = existing;
          working.matchDecision = "use_existing";
          nextStops.push(working);
          continue;
        }
        const sb = client();
        const { data, error } = await sb.from("ports").insert(payload).select("*").single();
        if (error) {
          if (/duplicate|unique/i.test(error.message)) {
            await ensurePortsLoaded({ force: true });
            const again = portsCache.find((p) => p.match_key === payload.match_key);
            if (again) {
              working.port_id = again.id;
              working.port = again;
              nextStops.push(working);
              continue;
            }
          }
          return {
            ok: false,
            errors: [`Could not create port “${entered}”: ${error.message}`],
            stops,
            createdPorts
          };
        }
        portsCache.push(data);
        createdPorts.push(data);
        working.port_id = data.id;
        working.port = data;
        nextStops.push(working);
        continue;
      }

      const classified = I().classifyPortMatches(
        entered,
        working.entered_country_text,
        portsCache
      );

      if (classified.status === "strong" && classified.primary) {
        working.port_id = classified.primary.id;
        working.port = classified.primary;
        working.matchDecision = "use_existing";
        nextStops.push(working);
        continue;
      }

      if (classified.status === "likely") {
        matchPrompt = {
          localId: working.localId,
          entered,
          country: working.entered_country_text,
          candidates: classified.matches.map((m) => m.port),
          status: "likely"
        };
        return {
          ok: false,
          errors: [
            `Confirm port match for “${entered}”. Use the existing Ports record or create a new provisional port.`
          ],
          stops,
          createdPorts,
          needsMatchDecision: true
        };
      }

      if (classified.status === "ambiguous") {
        matchPrompt = {
          localId: working.localId,
          entered,
          country: working.entered_country_text,
          candidates: classified.matches.map((m) => m.port),
          status: "ambiguous"
        };
        return {
          ok: false,
          errors: [`Multiple Ports records could match “${entered}”. Choose one before saving.`],
          stops,
          createdPorts,
          needsMatchDecision: true
        };
      }

      // No match → create provisional when confirmed by save attempt.
      if (confirmCreateNew) {
        const payload = I().provisionalPortPayload({
          enteredPortText: entered,
          enteredCountryText: working.entered_country_text,
          featuredCruiseId
        });
        const existing = portsCache.find((p) => p.match_key && p.match_key === payload.match_key);
        if (existing) {
          working.port_id = existing.id;
          working.port = existing;
          nextStops.push(working);
          continue;
        }
        const sb = client();
        const { data, error } = await sb.from("ports").insert(payload).select("*").single();
        if (error) {
          if (/duplicate|unique/i.test(error.message)) {
            await ensurePortsLoaded({ force: true });
            const again = portsCache.find((p) => p.match_key === payload.match_key);
            if (again) {
              working.port_id = again.id;
              working.port = again;
              nextStops.push(working);
              continue;
            }
          }
          return {
            ok: false,
            errors: [`Could not create port “${entered}”: ${error.message}`],
            stops,
            createdPorts
          };
        }
        portsCache.push(data);
        createdPorts.push(data);
        working.port_id = data.id;
        working.port = data;
        nextStops.push(working);
        continue;
      }

      nextStops.push(working);
    }

    stops = I().normalizeStopOrder(nextStops);
    matchPrompt = null;
    return { ok: true, errors: [], stops, createdPorts };
  }

  async function persistStops(featuredCruiseId) {
    const sb = client();
    if (!sb) throw new Error("Database client is not available.");
    const rows = I().stopsToDbRows(stops, featuredCruiseId);
    const { error: delError } = await sb
      .from("featured_cruise_itinerary_stops")
      .delete()
      .eq("featured_cruise_id", featuredCruiseId);
    if (delError) throw new Error(`Cruise saved, but itinerary could not be updated: ${delError.message}`);
    if (rows.length) {
      const { error: insError } = await sb.from("featured_cruise_itinerary_stops").insert(rows);
      if (insError) throw new Error(`Cruise saved, but itinerary could not be saved: ${insError.message}`);
    }
    structuredLoaded = true;
    needsStructuring = false;
  }

  function computeMapFields(draft) {
    const nextSignature = I().buildRouteSignature(stops);
    const hasMap = I().hasRouteMapAsset(draft);
    const previousSignature = routeMapSignature || draft.route_map_itinerary_signature || "";
    const previousStatus = routeMapStatus || draft.route_map_status || "missing";
    const nextStatus = I().nextRouteMapStatus({
      previousStatus,
      previousSignature,
      nextSignature,
      hasMap
    });
    routeMapSignature = nextSignature;
    routeMapStatus = nextStatus;
    return {
      route_map_itinerary_signature: nextSignature,
      route_map_status: nextStatus,
      itinerary_summary: I().buildPortsJoinedFromStops(stops) || legacySummary || null
    };
  }

  function markManualMap() {
    if (I().hasRouteMapAsset({ route_map_media_id: true })) {
      /* noop */
    }
    routeMapStatus = "manual";
  }

  function applyManualMapSelection() {
    routeMapStatus = "manual";
  }

  function clearMapSelectionStatus() {
    routeMapStatus = "missing";
  }

  function renderMatchPrompt() {
    if (!matchPrompt) return "";
    const labels = matchPrompt.candidates
      .map(
        (port) =>
          `<li>
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.resolveAmbiguous('${esc(port.id)}')">
              ${esc(I().formatAutocompleteLabel(port))}
            </button>
          </li>`
      )
      .join("");
    if (matchPrompt.status === "likely" && matchPrompt.candidates[0]) {
      const likely = I().formatAutocompleteLabel(matchPrompt.candidates[0]);
      return `
        <div class="fc-itin-match-prompt" role="dialog" aria-label="Confirm port match">
          <p><strong>You entered:</strong> ${esc(matchPrompt.entered)}${matchPrompt.country ? `, ${esc(matchPrompt.country)}` : ""}</p>
          <p><strong>Likely existing port:</strong> ${esc(likely)}</p>
          <div class="admin-actions-row">
            <button type="button" class="admin-button black small" onclick="FeaturedItineraryEditor.resolveMatchUseExisting()">Use Existing Port</button>
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.resolveMatchCreateNew()">Create New Port</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="fc-itin-match-prompt" role="dialog" aria-label="Choose port match">
        <p><strong>Ambiguous match for:</strong> ${esc(matchPrompt.entered)}</p>
        <p class="admin-muted">Choose the correct Ports record. Do not invent a new one unless none of these are correct.</p>
        <ul class="fc-itin-match-list">${labels}
          <li><button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.resolveMatchCreateNew()">Create New Port</button></li>
        </ul>
      </div>
    `;
  }

  function renderAutocomplete(stop) {
    if (!autocomplete.open || autocomplete.localId !== stop.localId) return "";
    const results = I().searchPorts(autocomplete.query, portsCache, { limit: 8 });
    if (!results.length) {
      return `<div class="fc-itin-ac" role="listbox"><div class="fc-itin-ac-empty">No existing port — a provisional record can be created on save</div></div>`;
    }
    return `
      <div class="fc-itin-ac" role="listbox">
        ${results
          .map(
            (port) => `
          <button type="button" class="fc-itin-ac-item" role="option" onclick="FeaturedItineraryEditor.selectPort('${esc(stop.localId)}','${esc(port.id)}')">
            ${esc(I().formatAutocompleteLabel(port))}
            <span class="fc-itin-ac-meta">${esc(port.status || "")}</span>
          </button>`
          )
          .join("")}
      </div>
    `;
  }

  function renderRow(stop, index) {
    const localId = esc(stop.localId);
    const atSea = I().isAtSeaStopType(stop.stop_type);
    const geographic = I().isGeographicStopType(stop.stop_type);
    const flags = I().rowStatusFlags(stop);
    const open = isStopOpen(stop);
    const typeLabel =
      I().STOP_TYPES.find((t) => t.value === stop.stop_type)?.label || stop.stop_type || "Stop";
    const portLabel = atSea
      ? "At sea"
      : stop.port?.display_name ||
        stop.port?.canonical_name ||
        stop.entered_port_text ||
        "Port not set";
    const typeOptions = I()
      .STOP_TYPES.map(
        (t) =>
          `<option value="${esc(t.value)}" ${stop.stop_type === t.value ? "selected" : ""}>${esc(t.label)}</option>`
      )
      .join("");
    return `
      <div
        class="fc-itin-row ${open ? "is-open" : "is-collapsed"} ${draggedLocalId === stop.localId ? "is-dragging" : ""}"
        data-local-id="${localId}"
        draggable="true"
        ondragstart="FeaturedItineraryEditor.onDragStart(event, '${localId}')"
        ondragend="FeaturedItineraryEditor.onDragEnd(event)"
      >
        <div class="fc-itin-row-summary">
          <button type="button" class="fc-itin-handle" aria-label="Drag to reorder" title="Drag to reorder" onmousedown="FeaturedItineraryEditor.onDragHandleDown()">☰</button>
          <button
            type="button"
            class="fc-itin-row-toggle"
            aria-expanded="${open ? "true" : "false"}"
            onclick="FeaturedItineraryEditor.toggleStop('${localId}')"
          >
            <span class="fc-itin-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>
            <span class="fc-itin-summary-day">Stop ${esc(String(stop.display_order || index + 1))}</span>
            <span class="fc-itin-summary-type">${esc(typeLabel)}</span>
            <span class="fc-itin-summary-port">${esc(portLabel)}</span>
            ${
              flags.length
                ? `<span class="fc-itin-summary-flags">${flags
                    .slice(0, 2)
                    .map((f) => `<span class="fc-itin-flag">${esc(f)}</span>`)
                    .join("")}</span>`
                : ""
            }
          </button>
        </div>
        <div class="fc-itin-row-details" ${open ? "" : "hidden"}>
          <div class="fc-itin-fields">
            <label class="fc-itin-day">
              <span>Day</span>
              <input data-fc-itin="day_number" type="number" min="1" step="1" value="${esc(stop.day_number ?? "")}" placeholder="—" aria-label="Optional sailing day" title="Optional cruise day number (not port order)">
            </label>
            <label class="fc-itin-type">
              <span>Type</span>
              <select data-fc-itin="stop_type" aria-label="Stop type" onchange="FeaturedItineraryEditor.onStopTypeChange('${localId}', this.value)">
                ${typeOptions}
              </select>
            </label>
            <div class="fc-itin-port-wrap ${atSea ? "is-disabled" : ""}">
              <label>
                <span>Port</span>
                <input
                  data-fc-itin="port"
                  type="text"
                  value="${esc(atSea ? "" : stop.entered_port_text || "")}"
                  placeholder="${atSea ? "—" : "Start typing a port…"}"
                  ${atSea ? "disabled" : ""}
                  autocomplete="off"
                  aria-label="Port"
                  oninput="FeaturedItineraryEditor.onPortInput('${localId}', this.value)"
                >
              </label>
              ${geographic && !atSea ? renderAutocomplete(stop) : ""}
            </div>
            <label class="fc-itin-country">
              <span>Country</span>
              <input data-fc-itin="country" type="text" value="${esc(atSea ? "" : stop.entered_country_text || "")}" ${atSea ? "disabled" : ""} aria-label="Country" placeholder="${atSea ? "—" : "Country"}">
            </label>
            <label class="fc-itin-time">
              <span>Arr</span>
              <input data-fc-itin="arrival" type="text" value="${esc(stop.arrival_time || "")}" placeholder="—" aria-label="Arrival time">
            </label>
            <label class="fc-itin-time">
              <span>Dep</span>
              <input data-fc-itin="departure" type="text" value="${esc(stop.departure_time || "")}" placeholder="—" aria-label="Departure time">
            </label>
            <label class="fc-itin-overnight" title="Overnight">
              <span>ON</span>
              <input data-fc-itin="overnight" type="checkbox" ${stop.is_overnight ? "checked" : ""} ${atSea ? "disabled" : ""}>
            </label>
          </div>
          <div class="fc-itin-flags" title="${esc(flags.join(", "))}">
            ${flags.map((f) => `<span class="fc-itin-flag">${esc(f)}</span>`).join("")}
          </div>
          <div class="fc-itin-row-actions">
            ${
              stop.port_id
                ? `<button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.clearPortMatch('${localId}')">Clear match</button>`
                : ""
            }
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.duplicateStop('${localId}')">Duplicate</button>
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.removeStop('${localId}')">Remove</button>
          </div>
          <label class="fc-itin-notes">
            <span>Notes</span>
            <input data-fc-itin="notes" type="text" value="${esc(stop.notes || "")}" placeholder="Optional notes">
          </label>
          <input data-fc-itin="stop_date" type="hidden" value="${esc(stop.stop_date || "")}">
        </div>
      </div>
    `;
  }

  function renderStatusSummary() {
    const summary = I().summarizePortStatus(stops);
    return `
      <div class="fc-itin-status-summary">
        <h5>Itinerary Port Status</h5>
        <ul>
          <li><strong>${summary.verified}</strong> verified</li>
          <li><strong>${summary.provisional}</strong> provisional</li>
          <li><strong>${summary.needsReview}</strong> needs review</li>
          <li><strong>${summary.unresolved}</strong> unresolved</li>
          <li><strong>${summary.missingCoordinates}</strong> missing coordinates</li>
        </ul>
        ${
          summary.readyForAutoMap
            ? `<p class="admin-success">Port calls are resolved for future automatic route-map generation.</p>`
            : `<p class="admin-muted">Route-map generation will require resolved port calls and coordinates (Sprint 13E).</p>`
        }
      </div>
    `;
  }

  function renderSection() {
    const helper = I();
    if (!helper) {
      return `<section class="featured-form-section"><h4>Itinerary</h4><p class="admin-error">Itinerary module failed to load.</p></section>`;
    }
    const stopCount = stops.length;
    return `
      <section class="featured-form-section fc-itin-section ${sectionOpen ? "is-open" : "is-collapsed"}">
        <button type="button" class="fc-itin-section-toggle" aria-expanded="${sectionOpen ? "true" : "false"}" onclick="FeaturedItineraryEditor.toggleSection()">
          <span class="fc-itin-chevron" aria-hidden="true">${sectionOpen ? "▾" : "▸"}</span>
          <span class="fc-itin-section-title">Itinerary</span>
          <span class="fc-itin-section-meta">${stopCount} stop${stopCount === 1 ? "" : "s"}</span>
        </button>
        <div class="fc-itin-section-body" ${sectionOpen ? "" : "hidden"}>
          <p class="admin-muted">Paste a full port list below, or edit stops one by one. List order is port sequence (Stop 1, 2, 3…) — not sailing days. Optional Day is only if you know the real cruise day. Ports link to the Ports database and coordinates are looked up for route maps.</p>
          <div class="fc-itin-port-list-paste">
            <label for="fcPortListPaste"><strong>Paste port list</strong></label>
            <textarea
              id="fcPortListPaste"
              rows="3"
              ${portListBusy ? "disabled" : ""}
              placeholder="Barcelona, Spain | Palma de Mallorca, Spain | Alicante, Spain | Cartagena, Spain | Malaga, Spain | Seville, Spain | Portimao, Portugal | Lisbon, Portugal"
            >${esc(portListPaste)}</textarea>
            <p class="admin-helper">Separate ports with <code>|</code>. Prefer <code>City, Country</code> so new Ports rows get the right country and coordinates.</p>
            <div class="admin-actions-row">
              <button type="button" class="admin-button black small" onclick="FeaturedItineraryEditor.applyPortListPaste()" ${portListBusy ? "disabled" : ""}>${
                portListBusy ? "Applying…" : "Apply port list"
              }</button>
            </div>
            ${
              portListMessage
                ? `<div class="admin-message ${
                    portListMessageTone === "error"
                      ? "admin-error"
                      : portListMessageTone === "success"
                        ? "admin-success"
                        : portListMessageTone === "running"
                          ? "admin-running"
                          : ""
                  }">${esc(portListMessage)}</div>`
                : ""
            }
          </div>
          ${
            needsStructuring
              ? `<div class="fc-itin-needs-structuring">
                  <strong>Needs structuring</strong>
                  <p>Legacy pipe-separated itinerary was imported into editable rows. Review matches, then save to store structured stops. Original summary is preserved until you save.</p>
                  <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.importLegacyNow()">Re-import from legacy summary</button>
                </div>`
              : ""
          }
          ${
            legacySummary && !structuredLoaded
              ? `<p class="admin-small">Legacy summary on file: ${esc(legacySummary)}</p>`
              : ""
          }
          ${renderMatchPrompt()}
          <div
            id="fcItineraryList"
            class="fc-itin-list"
            ondragover="FeaturedItineraryEditor.allowDrop(event)"
            ondrop="FeaturedItineraryEditor.onDrop(event)"
          >
            ${stops.map((stop, index) => renderRow(stop, index)).join("")}
          </div>
          <div class="admin-actions-row" style="margin-top:10px">
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.addStop()">+ Add Stop</button>
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.expandAllStops()">Expand all</button>
            <button type="button" class="admin-button secondary small" onclick="FeaturedItineraryEditor.collapseAllStops()">Collapse all</button>
          </div>
          ${renderStatusSummary()}
        </div>
      </section>
    `;
  }

  function renderRouteMapReadiness(draft) {
    const readiness = I().summarizeRouteMapReadiness(stops, {
      ...draft,
      route_map_status: routeMapStatus || draft?.route_map_status
    });
    const warn =
      readiness.routeMapStatus === "needs_regeneration"
        ? `<p class="fc-itin-map-stale">This route map may no longer match the itinerary. It has been kept, but is marked <strong>Needs regeneration</strong>.</p>`
        : "";
    const readyNote = readiness.readyForAutoMap
      ? `<p class="admin-muted">Ready for <strong>Generate Route Map</strong>. Manual Media Library maps remain optional.</p>`
      : `<p class="admin-muted">Resolve all port calls (with coordinates) to enable <strong>Generate Route Map</strong>.</p>`;
    return `
      <div class="fc-itin-map-readiness">
        <ul>
          <li><strong>${readiness.totalStops}</strong> itinerary stops</li>
          <li><strong>${readiness.mapped}</strong> mapped ports</li>
          <li><strong>${readiness.provisional}</strong> provisional port${readiness.provisional === 1 ? "" : "s"}</li>
          <li><strong>${readiness.missingCoordinates}</strong> port${readiness.missingCoordinates === 1 ? "" : "s"} missing coordinates</li>
          <li>Map status: <strong>${esc(readiness.statusLabel)}</strong></li>
        </ul>
        ${warn}
        ${readyNote}
      </div>
    `;
  }

  function expandAllStops() {
    captureFromDom();
    openStopIds = new Set(stops.map((s) => s.localId));
    rerender();
  }

  function collapseAllStops() {
    captureFromDom();
    openStopIds = new Set();
    rerender();
  }

  const api = {
    reset,
    initNewCruise,
    loadForCruise,
    ensurePortsLoaded,
    getStops,
    setStops,
    captureFromDom,
    syncSummaryIntoDraft,
    addStop,
    removeStop,
    duplicateStop,
    clearPortMatch,
    onPortInput,
    selectPort,
    onStopTypeChange,
    onDragHandleDown,
    onDragStart,
    onDragEnd,
    allowDrop,
    onDrop,
    importLegacyNow,
    applyPortListPaste,
    resolveMatchUseExisting,
    resolveMatchCreateNew,
    resolveAmbiguous,
    dismissMatchPrompt,
    prepareStopsForSave,
    persistStops,
    computeMapFields,
    applyManualMapSelection,
    clearMapSelectionStatus,
    markManualMap,
    toggleSection,
    toggleStop,
    expandAllStops,
    collapseAllStops,
    renderSection,
    renderRouteMapReadiness,
    getRouteMapStatus: () => routeMapStatus,
    setRouteMapStatus: (v) => {
      routeMapStatus = v || "missing";
    },
    getRouteMapSignature: () => routeMapSignature,
    setRouteMapSignature: (v) => {
      routeMapSignature = v || "";
    },
    getLegacySummary: () => legacySummary
  };

  global.FeaturedItineraryEditor = api;
})(typeof window !== "undefined" ? window : globalThis);
