/**
 * Sprint 11D.1 — Discovery ops: identity upsert, aliases, reprocess, audit, collapse.
 */

const crypto = require("crypto");
const {
  normaliseShipName,
  normaliseName,
  canonicalUrl,
  validateCruise,
  entityGroupKeyFromItem,
  groupReviewItems,
  suggestShipMatch,
  rawShipNameFromReviewItem,
  parseFlexibleDate,
  reviewFingerprint
} = require("./cruise-discovery");

// addDaysIso may not be exported — compute locally if needed
function addDays(isoDate, days) {
  if (!isoDate || !days) return null;
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

const REVIEW_LABELS = {
  unknown_ship: "Unknown ship",
  unknown_destination: "Unknown destination",
  missing_url: "Invalid sailing URL",
  missing_ship_url: "Official ship URL missing",
  validation_failure: "Validation failure",
  ambiguous_match: "Ambiguous match",
  missing_departure_date: "Missing departure date",
  other: "Other validation failure"
};

function humanReviewLabel(itemType) {
  return REVIEW_LABELS[itemType] || String(itemType || "Other").replace(/_/g, " ");
}

function primaryReviewCategory(reasons, candidate) {
  if (!candidate?.ship_id) return "unknown_ship";
  if (!candidate?.destination_id) return "unknown_destination";
  if (!candidate?.departure_date) return "missing_departure_date";
  if (!candidate?.official_url) return "missing_url";
  try {
    // eslint-disable-next-line no-new
    new URL(candidate.official_url);
  } catch {
    return "missing_url";
  }
  if (Array.isArray(reasons) && reasons.some((r) => /ambiguous/i.test(r))) return "ambiguous_match";
  return "validation_failure";
}

/**
 * Deterministic sailing identity — stable across destination search paths.
 */
function cruiseIdentityKey({
  cruiseLineId,
  shipId,
  departureDate,
  officialUrl,
  nights,
  returnDate,
  officialSailingId
}) {
  const basis = [
    cruiseLineId || "",
    shipId || "",
    departureDate || "",
    officialSailingId || canonicalUrl(officialUrl),
    nights || returnDate || ""
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function lifecycleFromValidation(reasons, { lowSignal = false } = {}) {
  if (lowSignal) return "ignored_low_signal";
  if (!reasons?.length) return "active"; // validated → promoted
  if (reasons.some((r) => /Ship not matched/i.test(r))) return "match_required";
  if (reasons.some((r) => /Destination not matched/i.test(r))) return "match_required";
  if (reasons.some((r) => /Departure date/i.test(r))) return "validation_failed";
  if (reasons.some((r) => /Official URL/i.test(r))) return "validation_failed";
  return "validation_failed";
}

function appendChangeLog(prevLog, entry) {
  const log = Array.isArray(prevLog) ? prevLog.slice(-40) : [];
  log.push({ ...entry, at: new Date().toISOString() });
  return log;
}

async function loadShipAliases(cruiseLineId) {
  if (!cruiseLineId) return [];
  const rows = await supabase(
    `cruise_ship_aliases?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&active=eq.true&select=id,ship_id,raw_alias,normalised_alias,source,created_at`
  ).catch(() => []);
  return rows || [];
}

async function loadDestinationAliases() {
  const rows = await supabase(
    "cruise_destination_aliases?active=eq.true&select=id,destination_id,raw_alias,normalised_alias"
  ).catch(() => []);
  return rows || [];
}

function matchShipWithAliases(text, ships, aliases, cruiseLineName) {
  const hay = ` ${normaliseShipName(text)} `;
  if (!hay.trim()) return null;

  // Exact alias hit (line-scoped aliases already filtered by caller)
  for (const alias of aliases || []) {
    const needle = normaliseShipName(alias.normalised_alias || alias.raw_alias);
    if (needle && hay.includes(` ${needle} `)) {
      const ship = (ships || []).find((s) => s.id === alias.ship_id);
      if (ship) return { ship, via: "alias", alias };
    }
  }

  // Fall back to name matching
  const { matchShip } = require("./cruise-discovery");
  const ship = matchShip(text, ships, cruiseLineName);
  return ship ? { ship, via: "name", alias: null } : null;
}

async function saveShipAlias({
  shipId,
  cruiseLineId,
  rawAlias,
  source,
  actorId
}) {
  const raw = String(rawAlias || "").trim();
  const normalised = normaliseShipName(raw);
  if (!shipId || !cruiseLineId || !raw || !normalised) {
    throw Object.assign(new Error("ship_id, cruise_line_id and raw_alias are required"), {
      statusCode: 400
    });
  }

  const existing = await supabase(
    `cruise_ship_aliases?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&normalised_alias=eq.${encodeURIComponent(
      normalised
    )}&active=eq.true&select=id,ship_id&limit=1`
  );
  if (existing?.[0]) {
    if (existing[0].ship_id === shipId) return { alias: existing[0], created: false };
    throw Object.assign(
      new Error("An active alias with this normalised name already exists for another ship on this line"),
      { statusCode: 409 }
    );
  }

  const created = await supabase("cruise_ship_aliases", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      ship_id: shipId,
      cruise_line_id: cruiseLineId,
      raw_alias: raw,
      normalised_alias: normalised,
      source: source || "admin_resolution",
      active: true,
      created_by: actorId || null
    })
  });
  return { alias: created?.[0] || null, created: true };
}

async function syncCruiseDestinations(cruiseId, destinationIds, evidenceById = {}) {
  if (!cruiseId) return;
  const ids = [...new Set((destinationIds || []).filter(Boolean))];
  // Replace associations for this cruise
  await supabase(`discovered_cruise_destinations?cruise_id=eq.${encodeURIComponent(cruiseId)}`, {
    method: "DELETE"
  }).catch(() => null);
  if (!ids.length) return;
  await supabase("discovered_cruise_destinations", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(
      ids.map((destination_id) => ({
        cruise_id: cruiseId,
        destination_id,
        evidence: evidenceById[destination_id] || null
      }))
    )
  });
}

async function writeResolutionAudit(entry) {
  await supabase("cruise_discovery_resolution_audit", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      finding_id: entry.finding_id || null,
      group_id: entry.group_id || null,
      action: entry.action,
      original_extract: entry.original_extract || {},
      normalised_data: entry.normalised_data || {},
      selected_match: entry.selected_match || {},
      confidence: entry.confidence ?? null,
      alias_created_id: entry.alias_created_id || null,
      manual_date: entry.manual_date || null,
      official_url_applied: entry.official_url_applied || null,
      candidates_reprocessed: entry.candidates_reprocessed || 0,
      cruises_promoted: entry.cruises_promoted || 0,
      candidates_unresolved: entry.candidates_unresolved || 0,
      actor_id: entry.actor_id || null
    })
  }).catch((err) => console.error("resolution audit write failed", err));
}

/**
 * Upsert a candidate by identity_key (preferred) then external_key.
 * Never duplicates an active sailing during reprocessing.
 */
async function upsertCandidateRecord(candidate, stats) {
  const identity_key =
    candidate.identity_key ||
    cruiseIdentityKey({
      cruiseLineId: candidate.cruise_line_id,
      shipId: candidate.ship_id,
      departureDate: candidate.departure_date,
      officialUrl: candidate.official_url,
      nights: candidate.nights,
      returnDate: candidate.return_date,
      officialSailingId: candidate.official_sailing_id
    });

  const reasons = validateCruise(candidate);
  const status =
    candidate.status === "ignored" || candidate.status === "ignored_low_signal"
      ? candidate.status
      : lifecycleFromValidation(reasons);
  const now = new Date().toISOString();

  const payload = {
    cruise_line_id: candidate.cruise_line_id,
    ship_id: candidate.ship_id,
    destination_id: candidate.destination_id || null,
    departure_date: candidate.departure_date,
    return_date: candidate.return_date,
    nights: candidate.nights,
    departure_port: candidate.departure_port,
    itinerary: candidate.itinerary,
    brochure_fare: candidate.brochure_fare,
    currency: candidate.currency,
    brochure_fare_display: candidate.brochure_fare_display,
    official_url: candidate.official_url,
    source_url: candidate.source_url || candidate.official_url,
    external_key: candidate.external_key,
    identity_key,
    status,
    match_confidence: candidate.match_confidence || (status === "active" ? "high" : "low"),
    review_reason: reasons.length ? reasons.join("; ") : null,
    raw_extract: candidate.raw_extract || {},
    departure_date_raw: candidate.departure_date_raw || null,
    return_date_raw: candidate.return_date_raw || null,
    departure_date_manual: Boolean(candidate.departure_date_manual),
    official_sailing_id: candidate.official_sailing_id || null,
    last_seen_at: now,
    last_verified_at: status === "active" ? now : null,
    last_changed_at: now
  };

  let prev = null;
  if (identity_key) {
    const byIdentity = await supabase(
      `discovered_cruises?identity_key=eq.${encodeURIComponent(identity_key)}&select=*&limit=1`
    );
    prev = byIdentity?.[0] || null;
  }
  if (!prev && candidate.external_key) {
    const byExternal = await supabase(
      `discovered_cruises?external_key=eq.${encodeURIComponent(candidate.external_key)}&select=*&limit=1`
    );
    prev = byExternal?.[0] || null;
  }
  // Same URL + line without ship/date yet → suppress duplicates
  if (!prev && candidate.official_url && candidate.cruise_line_id) {
    const byUrl = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        candidate.cruise_line_id
      )}&official_url=eq.${encodeURIComponent(candidate.official_url)}&select=*&limit=5`
    );
    if (byUrl?.length === 1) prev = byUrl[0];
    else if (byUrl?.length > 1 && candidate.departure_date) {
      prev =
        byUrl.find((r) => r.departure_date === candidate.departure_date) ||
        byUrl.find((r) => !r.departure_date) ||
        null;
    }
  }

  const destIds = [
    ...new Set(
      [candidate.destination_id, ...(candidate.destination_ids || [])].filter(Boolean)
    )
  ];

  if (!prev) {
    payload.discovered_at = now;
    payload.first_seen_at = now;
    payload.change_log = [{ field: "created", status, at: now }];
    const created = await supabase("discovered_cruises", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });
    const row = created?.[0];
    if (row?.id) await syncCruiseDestinations(row.id, destIds, candidate.destination_evidence || {});
    stats.new += 1;
    if (status === "active") stats.upserted_active += 1;
    else if (status !== "ignored_low_signal" && status !== "ignored") stats.upserted_review += 1;
    if (status === "active") stats.cruises_inserted = (stats.cruises_inserted || 0) + 1;
    return { row, created: true, promoted: status === "active", status, reasons };
  }

  const changedFields = [];
  const track = ["ship_id", "destination_id", "departure_date", "nights", "brochure_fare_display", "itinerary", "status"];
  for (const field of track) {
    if (String(prev[field] ?? "") !== String(payload[field] ?? "")) changedFields.push(field);
  }

  if (!changedFields.length) {
    await supabase(`discovered_cruises?id=eq.${encodeURIComponent(prev.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        last_seen_at: now,
        last_verified_at: status === "active" ? now : prev.last_verified_at,
        identity_key: prev.identity_key || identity_key
      })
    });
    if (destIds.length) await syncCruiseDestinations(prev.id, destIds, candidate.destination_evidence || {});
    stats.unchanged += 1;
    stats.duplicate_candidates_suppressed = (stats.duplicate_candidates_suppressed || 0) + 1;
    return { row: prev, created: false, promoted: false, status: prev.status, reasons, duplicate: true };
  }

  // Never demote active → non-active on thin reprocess unless expired
  let nextStatus = status;
  if (prev.status === "active" && status !== "active" && status !== "expired") {
    nextStatus = "active";
    payload.review_reason = null;
  }
  payload.status = nextStatus;
  payload.change_log = appendChangeLog(prev.change_log, {
    fields: changedFields,
    from: prev.status,
    to: nextStatus
  });
  payload.first_seen_at = prev.first_seen_at || prev.discovered_at || now;

  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(prev.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(payload)
  });
  if (destIds.length) await syncCruiseDestinations(prev.id, destIds, candidate.destination_evidence || {});

  stats.changed += 1;
  if (nextStatus === "active" && prev.status !== "active") {
    stats.cruises_promoted = (stats.cruises_promoted || 0) + 1;
    stats.upserted_active += 1;
  } else if (nextStatus === "active") {
    stats.cruises_updated = (stats.cruises_updated || 0) + 1;
  } else {
    stats.upserted_review += 1;
  }

  return {
    row: { ...prev, ...payload, id: prev.id },
    created: false,
    promoted: nextStatus === "active" && prev.status !== "active",
    status: nextStatus,
    reasons,
    changedFields
  };
}

async function reprocessCandidateIds(ids, { actor = null, context = {} } = {}) {
  const results = { reprocessed: 0, promoted: 0, unresolved: 0, errors: [] };
  for (const id of ids || []) {
    try {
      const rows = await supabase(
        `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
      );
      const cruise = rows?.[0];
      if (!cruise) continue;

      const aliases = await loadShipAliases(cruise.cruise_line_id);
      const ships = await supabase(
        `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(
          cruise.cruise_line_id
        )}&active=eq.true&select=id,name,official_ship_url`
      );
      const destinations = await supabase(
        "destinations?status=eq.published&select=id,name,slug,primary_region"
      );
      const destAliases = await loadDestinationAliases();

      let shipId = cruise.ship_id;
      if (!shipId) {
        const blob = [
          cruise.raw_extract?.title,
          cruise.raw_extract?.description,
          cruise.raw_extract?.ship_name_guesses?.join(" "),
          cruise.itinerary
        ]
          .filter(Boolean)
          .join("\n");
        const hit = matchShipWithAliases(blob, ships || [], aliases, "");
        if (hit?.ship) shipId = hit.ship.id;
      }

      let destinationId = cruise.destination_id;
      let destinationIds = destinationId ? [destinationId] : [];
      if (!destinationId) {
        const blob = normaliseName(
          [cruise.raw_extract?.title, cruise.raw_extract?.description, cruise.itinerary]
            .filter(Boolean)
            .join(" ")
        );
        for (const d of destinations || []) {
          const name = normaliseName(d.name);
          const slug = normaliseName(d.slug).replace(/-/g, " ");
          if ((name && blob.includes(name)) || (slug && blob.includes(slug))) {
            destinationIds.push(d.id);
          }
        }
        for (const a of destAliases || []) {
          const n = normaliseName(a.normalised_alias);
          if (n && blob.includes(n)) destinationIds.push(a.destination_id);
        }
        destinationIds = [...new Set(destinationIds)];
        destinationId = destinationIds[0] || null;
      }

      let departureDate = cruise.departure_date;
      if (!departureDate && cruise.departure_date_raw) {
        departureDate = parseFlexibleDate(cruise.departure_date_raw);
      }

      const candidate = {
        ...cruise,
        ship_id: shipId,
        destination_id: destinationId,
        destination_ids: destinationIds,
        departure_date: departureDate,
        return_date:
          cruise.return_date ||
          (departureDate && cruise.nights ? addDays(departureDate, cruise.nights) : null),
        status: undefined
      };

      const stats = {
        new: 0,
        changed: 0,
        unchanged: 0,
        upserted_active: 0,
        upserted_review: 0,
        cruises_promoted: 0,
        cruises_updated: 0,
        duplicate_candidates_suppressed: 0
      };
      const result = await upsertCandidateRecord(candidate, stats);
      results.reprocessed += 1;
      if (result.promoted) results.promoted += 1;
      if (result.status !== "active") results.unresolved += 1;
    } catch (error) {
      results.errors.push({ id, error: error.message });
    }
  }

  if (actor || context.action) {
    await writeResolutionAudit({
      action: context.action || "reprocess_candidates",
      group_id: context.group_id || null,
      actor_id: actor?.id || null,
      candidates_reprocessed: results.reprocessed,
      cruises_promoted: results.promoted,
      candidates_unresolved: results.unresolved,
      selected_match: context.selected_match || {},
      original_extract: context.original_extract || {},
      normalised_data: context.normalised_data || {},
      alias_created_id: context.alias_created_id || null,
      manual_date: context.manual_date || null,
      official_url_applied: context.official_url_applied || null,
      confidence: context.confidence ?? null
    });
  }

  return results;
}

async function reprocessByExternalKeys(keys, opts) {
  const ids = [];
  for (const key of [...new Set((keys || []).filter(Boolean))]) {
    const rows = await supabase(
      `discovered_cruises?external_key=eq.${encodeURIComponent(key)}&select=id&limit=1`
    );
    if (rows?.[0]?.id) ids.push(rows[0].id);
  }
  return reprocessCandidateIds(ids, opts);
}

async function collapseDuplicateReviewQueue(actor) {
  const rows = await supabase(
    "cruise_discovery_review_items?status=eq.pending&select=*&order=created_at.asc&limit=2000"
  );
  const groups = new Map();
  for (const row of rows || []) {
    const key =
      row.entity_group_key ||
      row.payload?.entity_group_key ||
      entityGroupKeyFromItem(row) ||
      reviewFingerprint(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let collapsed = 0;
  let kept = 0;
  const now = new Date().toISOString();

  for (const [, items] of groups) {
    if (items.length === 1) {
      kept += 1;
      continue;
    }
    const primary = items[0];
    const rest = items.slice(1);
    const keys = new Set([
      ...(Array.isArray(primary.affected_external_keys) ? primary.affected_external_keys : []),
      ...(primary.payload?.external_key ? [primary.payload.external_key] : [])
    ]);
    const reasons = new Set(
      [primary.detail, ...(primary.payload?.reasons || [])].filter(Boolean).map(String)
    );
    let lastSeen = primary.last_seen_at || primary.created_at;
    for (const item of rest) {
      if (item.payload?.external_key) keys.add(item.payload.external_key);
      for (const k of item.affected_external_keys || []) keys.add(k);
      for (const r of item.payload?.reasons || []) reasons.add(String(r));
      if (item.detail) reasons.add(item.detail);
      if (item.last_seen_at && item.last_seen_at > lastSeen) lastSeen = item.last_seen_at;
      if (item.created_at && item.created_at > lastSeen) lastSeen = item.created_at;
    }

    await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(primary.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        entity_group_key: entityGroupKeyFromItem(primary),
        affected_external_keys: [...keys],
        last_seen_at: lastSeen || now,
        first_seen_at: primary.first_seen_at || primary.created_at,
        detail: [...reasons].join("; ").slice(0, 2000),
        payload: {
          ...(primary.payload || {}),
          entity_group_key: entityGroupKeyFromItem(primary),
          collapsed_from: rest.length,
          reasons: [...reasons]
        }
      })
    });

    for (const item of rest) {
      await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "ignored",
          resolved_at: now,
          resolved_by: actor?.id || null,
          detail: "Collapsed into canonical review finding (11D.1)",
          last_seen_at: now
        })
      });
      collapsed += 1;
    }
    kept += 1;
  }

  return {
    success: true,
    processed: (rows || []).length,
    collapsed,
    remaining: kept,
    message: `${(rows || []).length} review rows processed\n${collapsed} duplicates collapsed\n${kept} actionable findings remain`
  };
}

module.exports = {
  supabase,
  REVIEW_LABELS,
  humanReviewLabel,
  primaryReviewCategory,
  cruiseIdentityKey,
  lifecycleFromValidation,
  loadShipAliases,
  loadDestinationAliases,
  matchShipWithAliases,
  saveShipAlias,
  syncCruiseDestinations,
  writeResolutionAudit,
  upsertCandidateRecord,
  reprocessCandidateIds,
  reprocessByExternalKeys,
  collapseDuplicateReviewQueue,
  groupReviewItems,
  entityGroupKeyFromItem,
  suggestShipMatch,
  rawShipNameFromReviewItem
};
