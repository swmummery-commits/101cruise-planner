/**
 * Cruise Discovery Engine API (Sprint 11D).
 *
 * POST /.netlify/functions/cruise-discovery
 * Actions:
 *   dashboard | list_lines | list_destinations | list_runs | get_run |
 *   list_review | list_review_groups | list_cruises | start_discovery | expire_sailed |
 *   resolve_review | ignore_review | resolve_review_group | ignore_review_group |
 *   collapse_duplicate_review
 *
 * Discovery never invents cruises/prices/itineraries. Unknown matches → review queue.
 * Sprint 11D.1: extract → normalise → match → validate; entity-level review groups.
 */

const { requireAdmin } = require("./admin-auth");
const {
  supabase,
  expireSailedCruises,
  discoverOneLine
} = require("./lib/cruise-discovery-runner");
const {
  groupReviewItems,
  entityGroupKeyFromItem,
  suggestShipMatch,
  normaliseShipName,
  validateCruise,
  rawShipNameFromReviewItem,
  parseFlexibleDate
} = require("./lib/cruise-discovery");
const {
  saveShipAlias,
  reprocessByExternalKeys,
  reprocessCandidateIds,
  collapseDuplicateReviewQueue,
  writeResolutionAudit,
  humanReviewLabel,
  loadShipAliases,
  upsertCandidateRecord
} = require("./lib/cruise-discovery-ops");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

async function dashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const [active, lines, runs, review, candidates7d, validated7d] = await Promise.all([
    supabase(
      `discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})&select=id&limit=1000`
    ).catch(() => []),
    supabase("ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id").catch(() => []),
    supabase(
      "cruise_discovery_runs?select=id,scope,status,stats,started_at,finished_at,created_at,cruise_line_id,destination_id,error_message&order=created_at.desc&limit=25"
    ).catch(() => []),
    supabase(
      "cruise_discovery_review_items?status=eq.pending&select=id,item_type&limit=2000"
    ).catch(() => []),
    supabase(
      `discovered_cruises?discovered_at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id,status&limit=2000`
    ).catch(() => []),
    supabase(
      `discovered_cruises?status=eq.active&discovered_at=gte.${new Date(
        Date.now() - 7 * 864e5
      ).toISOString()}&select=id&limit=1000`
    ).catch(() => [])
  ]);

  const last = runs?.[0];
  const s = last?.stats || {};
  const reviewRows = review || [];
  const breakdown = {
    unknown_ship: 0,
    missing_departure_date: 0,
    unknown_destination: 0,
    missing_url: 0,
    ambiguous_match: 0,
    missing_ship_url: 0,
    validation_failure: 0,
    other: 0
  };
  for (const row of reviewRows) {
    const t = row.item_type || "other";
    if (breakdown[t] != null) breakdown[t] += 1;
    else breakdown.other += 1;
  }

  const recentRuns = runs || [];
  const scannedOk = recentRuns.filter((r) => r.status === "completed").length;
  const scannedFail = recentRuns.filter((r) => r.status === "failed").length;

  return {
    success: true,
    cards: {
      active_cruises: (active || []).length,
      discovered_candidates_last_run: s.candidates ?? 0,
      validated_new_cruises_last_run: s.cruises_inserted ?? s.upserted_active ?? 0,
      candidates_promoted_last_run: s.cruises_promoted ?? 0,
      review_required: reviewRows.length,
      duplicate_candidates_suppressed: s.duplicate_candidates_suppressed ?? s.unchanged ?? 0,
      low_signal_sources_ignored: s.skipped_non_cruise ?? 0,
      cruise_lines_scanned_ok: s.cruise_lines_scanned ?? scannedOk,
      cruise_lines_unable_to_scan: s.cruise_lines_failed ?? scannedFail,
      // legacy keys kept for compatibility
      active_cruise_lines: (lines || []).length,
      last_discovery_run: last?.finished_at || last?.started_at || last?.created_at || null,
      new_cruises: (validated7d || []).length,
      changed_cruises: s.changed ?? 0,
      candidates_last_7_days: (candidates7d || []).length
    },
    review_breakdown: breakdown,
    last_run_stats: s
  };
}

async function listLines() {
  const rows = await supabase(
    "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id,name,slug,website_url,cruise_search_url,fleet_page_url&order=name.asc"
  );
  return { success: true, cruise_lines: rows || [] };
}

async function listDestinations() {
  const rows = await supabase(
    "destinations?status=eq.published&select=id,name,slug,primary_region&order=display_order.asc,name.asc"
  );
  return { success: true, destinations: rows || [] };
}

async function listRuns(body) {
  const limit = Math.min(Number(body.limit) || 20, 50);
  const rows = await supabase(
    `cruise_discovery_runs?select=id,scope,status,stats,error_message,started_at,finished_at,created_at,cruise_line_id,destination_id&order=created_at.desc&limit=${limit}`
  );
  return { success: true, runs: rows || [] };
}

async function getRun(body) {
  const id = String(body.run_id || "").trim();
  if (!id) throw Object.assign(new Error("run_id is required"), { statusCode: 400 });
  const rows = await supabase(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const run = rows?.[0];
  if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
  return { success: true, run };
}

async function listReview(body) {
  const limit = Math.min(Number(body.limit) || 50, 100);
  const status = String(body.status || "pending").trim();
  const rows = await supabase(
    `cruise_discovery_review_items?status=eq.${encodeURIComponent(status)}&select=*&order=created_at.desc&limit=${limit}`
  );
  return { success: true, items: rows || [] };
}

/**
 * Entity-level review groups — one row per cruise-line + raw ship + finding type (+ suggestion).
 */
async function enrichReviewSuggestions(rows) {
  const list = rows || [];
  const lineIds = [...new Set(list.map((r) => r.cruise_line_id).filter(Boolean))];
  const lineNameById = {};
  if (lineIds.length) {
    const lines = await supabase(
      `ci_cruise_lines?id=in.(${lineIds.join(",")})&select=id,name`
    ).catch(() => []);
    for (const line of lines || []) lineNameById[line.id] = line.name;
  }

  const shipsByLine = new Map();
  async function shipsForLine(lineId) {
    if (!lineId) return [];
    if (shipsByLine.has(lineId)) return shipsByLine.get(lineId);
    const ships = await supabase(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(lineId)}&active=eq.true&select=id,name`
    ).catch(() => []);
    shipsByLine.set(lineId, ships || []);
    return ships || [];
  }

  for (const item of list) {
    if (item.item_type !== "unknown_ship") continue;
    const raw = rawShipNameFromReviewItem(item);
    if (!raw || !item.cruise_line_id) continue;
    if (!item.payload?.suggested_ship_id) {
      const ships = await shipsForLine(item.cruise_line_id);
      const suggestion = suggestShipMatch(raw, ships, lineNameById[item.cruise_line_id] || "");
      if (suggestion) {
        item.payload = {
          ...(item.payload || {}),
          raw_ship_name: item.payload?.raw_ship_name || raw,
          normalised_raw_ship_name:
            item.payload?.normalised_raw_ship_name || normaliseShipName(raw),
          suggested_ship_id: suggestion.ship_id,
          suggested_ship_name: suggestion.ship_name,
          suggested_confidence: suggestion.confidence
        };
      }
    } else if (!item.payload?.raw_ship_name && raw) {
      item.payload = {
        ...item.payload,
        raw_ship_name: raw,
        normalised_raw_ship_name:
          item.payload.normalised_raw_ship_name || normaliseShipName(raw)
      };
    }
    item.payload = {
      ...(item.payload || {}),
      entity_group_key: entityGroupKeyFromItem(item)
    };
  }

  return { rows: list, lineNameById };
}

async function listReviewGroups(body) {
  const limit = Math.min(Number(body.limit) || 500, 2000);
  const status = String(body.status || "pending").trim();
  const rows = await supabase(
    `cruise_discovery_review_items?status=eq.${encodeURIComponent(status)}&select=*&order=created_at.asc&limit=${limit}`
  );

  const { rows: enriched, lineNameById } = await enrichReviewSuggestions(rows || []);
  let groups = groupReviewItems(enriched, { lineNameById });
  const filterType = String(body.item_type || body.filter_type || "").trim();
  if (filterType) groups = groups.filter((g) => g.item_type === filterType);

  groups = groups.map((g) => ({
    ...g,
    item_type_label: humanReviewLabel(g.item_type),
    first_seen_at: g.created_at,
    last_seen_at: g.last_seen_at || g.created_at,
    departure_date_raw: g.departure_date_raw || null,
    parsed_departure_date: g.parsed_departure_date || null
  }));

  return {
    success: true,
    groups,
    item_count: enriched.length,
    group_count: groups.length,
    labels: {
      unknown_ship: "Unknown ship",
      missing_departure_date: "Missing departure date",
      unknown_destination: "Unknown destination",
      missing_url: "Invalid sailing URL",
      ambiguous_match: "Ambiguous match",
      missing_ship_url: "Official ship URL missing",
      validation_failure: "Validation failure",
      other: "Other validation failure"
    }
  };
}

async function loadPendingByGroupId(groupId) {
  const rows = await supabase(
    "cruise_discovery_review_items?status=eq.pending&select=*&order=created_at.asc&limit=2000"
  );
  const { rows: enriched } = await enrichReviewSuggestions(rows || []);
  return enriched.filter((item) => entityGroupKeyFromItem(item) === groupId);
}

async function resolveReviewGroup(body, actor) {
  const groupId = String(body.group_id || "").trim();
  if (!groupId) throw Object.assign(new Error("group_id is required"), { statusCode: 400 });

  const action = String(body.resolution_action || "").trim() || "resolve";
  // resolution_action: match_ship | match_and_save_alias | apply_ship_url | resolve | ignore
  const shipId = String(body.ship_id || body.suggested_ship_id || "").trim();
  const saveAlias = action === "match_and_save_alias" || body.save_alias === true;
  const applyShipUrl = action === "apply_ship_url" || body.apply_official_ship_url === true;
  const applySuggestedShip =
    action === "match_ship" ||
    action === "match_and_save_alias" ||
    body.apply_suggested_ship === true;
  const applySuggestedDestination = body.apply_suggested_destination === true;

  const items = await loadPendingByGroupId(groupId);
  if (!items.length) {
    throw Object.assign(new Error("No pending review items found for this group"), {
      statusCode: 404
    });
  }

  const sample = items[0];
  const targetShipId = shipId || sample.payload?.suggested_ship_id || null;
  const rawAlias =
    String(body.raw_alias || sample.payload?.raw_ship_name || rawShipNameFromReviewItem(sample) || "").trim();
  let aliasCreatedId = null;
  let officialUrlApplied = null;

  if (saveAlias && targetShipId && sample.cruise_line_id && rawAlias) {
    const saved = await saveShipAlias({
      shipId: targetShipId,
      cruiseLineId: sample.cruise_line_id,
      rawAlias,
      source: "admin_resolution",
      actorId: actor?.id || null
    });
    aliasCreatedId = saved.alias?.id || null;
  }

  if (applySuggestedShip && targetShipId) {
    const keys = [...new Set(items.map((i) => i.payload?.external_key).filter(Boolean))];
    for (const externalKey of keys) {
      const cruises = await supabase(
        `discovered_cruises?external_key=eq.${encodeURIComponent(externalKey)}&select=*&limit=1`
      );
      const cruise = cruises?.[0];
      if (!cruise) continue;
      await supabase(`discovered_cruises?id=eq.${encodeURIComponent(cruise.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          ship_id: targetShipId,
          last_changed_at: new Date().toISOString()
        })
      });
    }
  }

  if (applySuggestedDestination && sample.payload?.suggested_destination_id) {
    const destinationId = sample.payload.suggested_destination_id;
    const keys = [...new Set(items.map((i) => i.payload?.external_key).filter(Boolean))];
    for (const externalKey of keys) {
      const cruises = await supabase(
        `discovered_cruises?external_key=eq.${encodeURIComponent(externalKey)}&select=*&limit=1`
      );
      const cruise = cruises?.[0];
      if (!cruise) continue;
      await supabase(`discovered_cruises?id=eq.${encodeURIComponent(cruise.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          destination_id: destinationId,
          last_changed_at: new Date().toISOString()
        })
      });
    }
  }

  if (applyShipUrl && (sample.item_type === "missing_ship_url" || sample.payload?.ship_id)) {
    const sid = sample.payload?.ship_id || targetShipId;
    const url = sample.payload?.suggested_official_ship_url || sample.source_url;
    if (sid && url) {
      await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(sid)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          official_ship_url: url,
          last_verified_at: new Date().toISOString()
        })
      });
      officialUrlApplied = url;
    }
  }

  const keys = [
    ...new Set([
      ...items.map((i) => i.payload?.external_key).filter(Boolean),
      ...(sample.affected_external_keys || [])
    ])
  ];

  const manualDeparture = String(body.manual_departure_date || "").trim();
  const manualReturn = String(body.manual_return_date || "").trim() || null;
  if (manualDeparture) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manualDeparture)) {
      throw Object.assign(new Error("manual_departure_date must be ISO YYYY-MM-DD"), {
        statusCode: 400
      });
    }
    for (const externalKey of keys) {
      const cruises = await supabase(
        `discovered_cruises?external_key=eq.${encodeURIComponent(externalKey)}&select=id,ship_id,raw_extract,departure_date_raw&limit=1`
      );
      const cruise = cruises?.[0];
      if (!cruise) continue;
      if (!cruise.ship_id && Number(cruise.raw_extract?.signal_score || 0) < 2) continue;
      await supabase(`discovered_cruises?id=eq.${encodeURIComponent(cruise.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          departure_date: manualDeparture,
          return_date: manualReturn,
          departure_date_manual: true,
          departure_date_resolved_by: actor?.id || null,
          departure_date_resolved_at: new Date().toISOString(),
          last_changed_at: new Date().toISOString()
        })
      });
    }
  }

  const reprocess = await reprocessByExternalKeys(keys, {
    actor,
    context: {
      action: action || "resolve_review_group",
      group_id: groupId,
      selected_match: {
        ship_id: targetShipId,
        ship_name: sample.payload?.suggested_ship_name || null
      },
      confidence: sample.payload?.suggested_confidence ?? null,
      alias_created_id: aliasCreatedId,
      official_url_applied: officialUrlApplied,
      original_extract: sample.payload?.extract || {},
      normalised_data: {
        raw_ship_name: rawAlias,
        normalised_raw_ship_name: normaliseShipName(rawAlias)
      }
    }
  });

  const now = new Date().toISOString();
  for (let i = 0; i < items.length; i += 40) {
    const chunk = items.slice(i, i + 40);
    await Promise.all(
      chunk.map((item) =>
        supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "resolved",
            resolved_at: now,
            resolved_by: actor?.id || null,
            entity_group_key: groupId,
            last_seen_at: now
          })
        })
      )
    );
  }

  return {
    success: true,
    group_id: groupId,
    resolved_items: items.length,
    alias_created_id: aliasCreatedId,
    candidates_reprocessed: reprocess.reprocessed,
    cruises_promoted: reprocess.promoted,
    candidates_unresolved: reprocess.unresolved,
    message: `Resolved ${items.length} finding(s). Reprocessed ${reprocess.reprocessed}; promoted ${reprocess.promoted}; still unresolved ${reprocess.unresolved}.`
  };
}

async function ignoreReviewGroup(body, actor) {
  const groupId = String(body.group_id || "").trim();
  if (!groupId) throw Object.assign(new Error("group_id is required"), { statusCode: 400 });
  const items = await loadPendingByGroupId(groupId);
  if (!items.length) {
    throw Object.assign(new Error("No pending review items found for this group"), {
      statusCode: 404
    });
  }
  const now = new Date().toISOString();
  for (let i = 0; i < items.length; i += 40) {
    const chunk = items.slice(i, i + 40);
    await Promise.all(
      chunk.map((item) =>
        supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "ignored",
            resolved_at: now,
            resolved_by: actor?.id || null
          })
        })
      )
    );
  }
  return {
    success: true,
    group_id: groupId,
    ignored_items: items.length,
    message: `Ignored ${items.length} finding${items.length === 1 ? "" : "s"} in this group.`
  };
}

async function listCruises(body) {
  const limit = Math.min(Number(body.limit) || 100, 300);
  const status = String(body.status || "active").trim();
  const destinationId = String(body.destination_id || "").trim();
  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const parts = [
    "select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,brochure_fare_display,currency,official_url,status,match_confidence,review_reason,discovered_at,last_seen_at,last_changed_at,ci_cruise_lines(name),ci_cruise_ships(name),destinations(name,slug)&order=departure_date.asc.nullslast&limit=" +
      limit
  ];
  if (status && status !== "all") {
    parts.unshift(`status=eq.${encodeURIComponent(status)}`);
  }
  if (destinationId) parts.unshift(`destination_id=eq.${encodeURIComponent(destinationId)}`);
  if (cruiseLineId) parts.unshift(`cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}`);
  const rows = await supabase(`discovered_cruises?${parts.join("&")}`);
  const cruises = (rows || []).map((row) => ({
    ...row,
    cruise_line_name: row.ci_cruise_lines?.name || null,
    ship_name: row.ci_cruise_ships?.name || null,
    destination_name: row.destinations?.name || null,
    destination_slug: row.destinations?.slug || null,
    ci_cruise_lines: undefined,
    ci_cruise_ships: undefined,
    destinations: undefined
  }));
  return { success: true, cruises, count: cruises.length };
}

async function startDiscovery(body, actor) {
  const scope = String(body.scope || "cruise_line").trim();
  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const destinationId = String(body.destination_id || "").trim();

  if (scope === "cruise_line" && !cruiseLineId) {
    throw Object.assign(new Error("cruise_line_id is required for cruise_line scope"), {
      statusCode: 400
    });
  }
  if (scope === "destination" && !destinationId) {
    throw Object.assign(new Error("destination_id is required for destination scope"), {
      statusCode: 400
    });
  }
  if (scope === "full") {
    throw Object.assign(
      new Error(
        "Run Full Discovery from the Admin UI (it loops cruise lines), or rely on the weekly scheduled job."
      ),
      { statusCode: 400 }
    );
  }

  let lineIds = [];
  if (scope === "cruise_line") lineIds = [cruiseLineId];
  if (scope === "destination") {
    const lines = await supabase(
      "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id&order=name.asc"
    );
    lineIds = (lines || []).map((l) => l.id);
    if (cruiseLineId) lineIds = [cruiseLineId];
  }

  const lineId = lineIds[0];
  if (!lineId) throw Object.assign(new Error("No cruise lines to scan"), { statusCode: 400 });

  const result = await discoverOneLine({
    cruiseLineId: lineId,
    destinationId: destinationId || null,
    scope,
    actor,
    triggeredBy: "admin"
  });

  return {
    ...result,
    remaining_line_ids: lineIds.slice(1)
  };
}

async function resolveReview(body, actor) {
  const id = String(body.review_id || "").trim();
  if (!id) throw Object.assign(new Error("review_id is required"), { statusCode: 400 });
  const applyShipUrl = body.apply_official_ship_url === true;

  const items = await supabase(
    `cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const item = items?.[0];
  if (!item) throw Object.assign(new Error("Review item not found"), { statusCode: 404 });

  if (applyShipUrl && item.item_type === "missing_ship_url") {
    const shipId = item.payload?.ship_id;
    const url = item.payload?.suggested_official_ship_url || item.source_url;
    if (shipId && url) {
      await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          official_ship_url: url,
          last_verified_at: new Date().toISOString()
        })
      });
    }
  }

  await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: actor?.id || null
    })
  });
  return { success: true, message: "Review item resolved." };
}

async function ignoreReview(body, actor) {
  const id = String(body.review_id || "").trim();
  if (!id) throw Object.assign(new Error("review_id is required"), { statusCode: 400 });
  await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "ignored",
      resolved_at: new Date().toISOString(),
      resolved_by: actor?.id || null
    })
  });
  return { success: true, message: "Review item ignored." };
}

/**
 * Collapse duplicate pending review findings — keep the oldest per fingerprint.
 */
async function collapseDuplicateReview(actor) {
  return collapseDuplicateReviewQueue(actor);
}

async function manualResolveDate(body, actor) {
  const cruiseId = String(body.cruise_id || "").trim();
  if (!cruiseId) throw Object.assign(new Error("cruise_id is required"), { statusCode: 400 });
  const departure = String(body.departure_date || "").trim();
  const returnDate = String(body.return_date || "").trim() || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departure)) {
    throw Object.assign(new Error("departure_date must be ISO YYYY-MM-DD"), { statusCode: 400 });
  }

  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(cruiseId)}&select=*&limit=1`
  );
  const cruise = rows?.[0];
  if (!cruise) throw Object.assign(new Error("Candidate not found"), { statusCode: 404 });

  // Do not promote hub pages — require ship + destination + URL still
  const signal = cruise.raw_extract?.signal_score;
  if (signal != null && Number(signal) < 2 && !cruise.ship_id) {
    throw Object.assign(
      new Error("Cannot assign a sailing date to a low-signal hub/destination page"),
      { statusCode: 400 }
    );
  }

  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(cruiseId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      departure_date: departure,
      return_date: returnDate,
      departure_date_manual: true,
      departure_date_resolved_by: actor?.id || null,
      departure_date_resolved_at: new Date().toISOString(),
      departure_date_raw: cruise.departure_date_raw || cruise.raw_extract?.title || null,
      last_changed_at: new Date().toISOString()
    })
  });

  const result = await reprocessCandidateIds([cruiseId], {
    actor,
    context: {
      action: "manual_date_resolution",
      manual_date: { departure_date: departure, return_date: returnDate },
      original_extract: cruise.raw_extract || {}
    }
  });

  return {
    success: true,
    ...result,
    message: `Date saved. Reprocessed ${result.reprocessed}; promoted ${result.promoted}.`
  };
}

async function listShipAliases(body) {
  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const shipId = String(body.ship_id || "").trim();
  const parts = ["select=*&order=created_at.desc&limit=100", "active=eq.true"];
  if (cruiseLineId) parts.unshift(`cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}`);
  if (shipId) parts.unshift(`ship_id=eq.${encodeURIComponent(shipId)}`);
  const rows = await supabase(`cruise_ship_aliases?${parts.join("&")}`).catch(() => []);
  return { success: true, aliases: rows || [] };
}

async function listResolutionAudit(body) {
  const limit = Math.min(Number(body.limit) || 30, 100);
  const rows = await supabase(
    `cruise_discovery_resolution_audit?select=*&order=created_at.desc&limit=${limit}`
  ).catch(() => []);
  return { success: true, entries: rows || [] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const actor = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "dashboard") return jsonResponse(200, await dashboard());
    if (action === "list_lines") return jsonResponse(200, await listLines());
    if (action === "list_destinations") return jsonResponse(200, await listDestinations());
    if (action === "list_runs") return jsonResponse(200, await listRuns(body));
    if (action === "get_run") return jsonResponse(200, await getRun(body));
    if (action === "list_review") return jsonResponse(200, await listReview(body));
    if (action === "list_review_groups") return jsonResponse(200, await listReviewGroups(body));
    if (action === "list_cruises") return jsonResponse(200, await listCruises(body));
    if (action === "start_discovery") return jsonResponse(200, await startDiscovery(body, actor));
    if (action === "expire_sailed") {
      const result = await expireSailedCruises();
      return jsonResponse(200, { success: true, ...result });
    }
    if (action === "resolve_review") return jsonResponse(200, await resolveReview(body, actor));
    if (action === "ignore_review") return jsonResponse(200, await ignoreReview(body, actor));
    if (action === "resolve_review_group") {
      return jsonResponse(200, await resolveReviewGroup(body, actor));
    }
    if (action === "ignore_review_group") {
      return jsonResponse(200, await ignoreReviewGroup(body, actor));
    }
    if (action === "collapse_duplicate_review") {
      return jsonResponse(200, await collapseDuplicateReview(actor));
    }
    if (action === "manual_resolve_date") {
      return jsonResponse(200, await manualResolveDate(body, actor));
    }
    if (action === "reprocess_candidates") {
      const ids = Array.isArray(body.cruise_ids) ? body.cruise_ids : [];
      const result = await reprocessCandidateIds(ids, {
        actor,
        context: { action: "reprocess_candidates" }
      });
      return jsonResponse(200, { success: true, ...result });
    }
    if (action === "reprocess_group") {
      const groupId = String(body.group_id || "").trim();
      const items = await loadPendingByGroupId(groupId);
      const keys = items.map((i) => i.payload?.external_key).filter(Boolean);
      const result = await reprocessByExternalKeys(keys, {
        actor,
        context: { action: "reprocess_group", group_id: groupId }
      });
      return jsonResponse(200, { success: true, ...result });
    }
    if (action === "list_ship_aliases") return jsonResponse(200, await listShipAliases(body));
    if (action === "list_resolution_audit") {
      return jsonResponse(200, await listResolutionAudit(body));
    }
    if (action === "verify_selected_line") {
      // Selected-line verification — does not run full discovery.
      const lineId = String(body.cruise_line_id || "").trim();
      if (!lineId) {
        return jsonResponse(400, { success: false, error: "cruise_line_id is required" });
      }
      const result = await discoverOneLine({
        cruiseLineId: lineId,
        scope: "cruise_line",
        actor,
        triggeredBy: "selected_line_verification"
      });
      return jsonResponse(200, {
        success: true,
        verification: true,
        full_discovery_safe: false,
        note: "Selected-line verification only (11D.2 sailing URL prioritisation). Do not run Full Discovery until Virgin Voyages, Windstar, Celebrity, and Princess pass.",
        ...result
      });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("cruise-discovery", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Cruise discovery request failed"
    });
  }
};
