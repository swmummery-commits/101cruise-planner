/**
 * Itinerary auto-approval validation engine (exception-only workflow).
 * Pure functions — no network, no writes.
 */

"use strict";

const {
  resolveCruiseShip,
  resolveCruiseLineAlias,
  canonicalCruiseLineDisplayName,
  normaliseText
} = require("./resolve-cruise-ship");
const { diagnosePortMatch, buildPortIndex } = require("./customer-port-match");

const VALIDATION_VERSION = "1.0.0";

const THRESHOLDS = Object.freeze({
  overallConfidence: 0.9,
  embarkDisembarkConfidence: 0.9,
  ordinaryPortConfidence: 0.8
});

function isSeaDay(stop) {
  const type = String(stop?.entry_type || stop?.type || "").toLowerCase();
  const name = String(stop?.name || "").toLowerCase();
  return type === "sea_day" || name === "at sea" || name.includes("at sea");
}

function isPortLike(stop) {
  if (isSeaDay(stop)) return false;
  const type = String(stop?.entry_type || stop?.type || "").toLowerCase();
  return ["embarkation", "disembarkation", "port", "scenic_cruising", ""].includes(type) || !type;
}

function parseIsoDate(value) {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : text;
}

function datesEqual(a, b) {
  const left = parseIsoDate(a);
  const right = parseIsoDate(b);
  return Boolean(left && right && left === right);
}

function reason(code, message, details = null) {
  return { code, message, details };
}

function conciseSummary(failures) {
  if (!failures.length) return null;
  const codes = failures.map((f) => f.code);
  const unresolved = failures.filter((f) => f.code === "unresolved_port");
  if (unresolved.length) {
    return `${unresolved.length} unresolved port${unresolved.length === 1 ? "" : "s"}`;
  }
  if (codes.includes("ambiguous_ship") || codes.includes("ship_not_found")) {
    return "ship match ambiguous";
  }
  if (codes.includes("ambiguous_cruise_line")) return "cruise line match ambiguous";
  if (
    codes.includes("embarkation_date_mismatch") ||
    codes.includes("disembarkation_date_mismatch") ||
    codes.includes("stop_outside_cruise_dates") ||
    codes.includes("stops_not_chronological")
  ) {
    return "dates conflict with booking";
  }
  if (
    codes.includes("overall_confidence_low") ||
    codes.includes("embarkation_confidence_low") ||
    codes.includes("disembarkation_confidence_low") ||
    codes.includes("port_confidence_low")
  ) {
    return "extraction confidence below threshold";
  }
  if (codes.includes("confirmation_changed_after_approval")) {
    return "confirmation changed after approval";
  }
  if (codes.includes("conflicting_approved_itinerary")) {
    return "conflicting approved itinerary";
  }
  return failures[0].message || "review required";
}

/**
 * Validate extracted itinerary_data for automatic approval.
 */
function validateItineraryForAutoApproval(options = {}) {
  const itinerary = options.itinerary || {};
  const booking = options.booking || {};
  const ships = Array.isArray(options.ships) ? options.ships : [];
  const existing = options.existingItinerary || null;
  const sourceDocumentHash = options.sourceDocumentHash || null;
  const failures = [];
  const diagnostics = {
    validation_version: VALIDATION_VERSION,
    thresholds: THRESHOLDS,
    port_matches: [],
    ship_resolution: null,
    cruise_line_resolution: null,
    unique_plotted_ports: 0
  };

  const stops = Array.isArray(itinerary.stops) ? itinerary.stops : [];
  if (!stops.length) {
    failures.push(reason("missing_stops", "No itinerary stops were extracted"));
  }

  const bookingRef = String(booking.booking_reference || "").trim().toUpperCase();
  const itineraryRef = String(options.bookingReference || itinerary.booking_reference || "")
    .trim()
    .toUpperCase();
  if (bookingRef && itineraryRef && bookingRef !== itineraryRef) {
    failures.push(
      reason("booking_reference_mismatch", "Extracted booking reference does not match the booking", {
        booking: bookingRef,
        itinerary: itineraryRef
      })
    );
  }

  const extractedLine = canonicalCruiseLineDisplayName(itinerary.cruise_line || "");
  const bookingLine = canonicalCruiseLineDisplayName(booking.cruise_line || "");
  const extractedLineKey = resolveCruiseLineAlias(extractedLine);
  const bookingLineKey = resolveCruiseLineAlias(bookingLine);
  diagnostics.cruise_line_resolution = {
    extracted: extractedLine || null,
    booking: bookingLine || null,
    extracted_key: extractedLineKey || null,
    booking_key: bookingLineKey || null
  };
  if (!extractedLineKey) {
    failures.push(reason("cruise_line_missing", "Cruise line could not be resolved from the extraction"));
  } else if (bookingLineKey && extractedLineKey !== bookingLineKey) {
    failures.push(
      reason("ambiguous_cruise_line", "Cruise line does not match the booking unambiguously", {
        extracted: extractedLine,
        booking: bookingLine
      })
    );
  }

  const shipName = String(itinerary.ship || "").trim();
  const lineForShip = extractedLine || bookingLine;
  if (!shipName) {
    failures.push(reason("ship_missing", "Ship could not be resolved from the extraction"));
    diagnostics.ship_resolution = { status: "missing" };
  } else if (ships.length) {
    const shipResult = resolveCruiseShip(ships, shipName, lineForShip);
    diagnostics.ship_resolution = {
      status: shipResult.status,
      ship_id: shipResult.ship?.id || null,
      ship_name: shipResult.ship?.name || null
    };
    if (shipResult.status === "ambiguous") {
      failures.push(reason("ambiguous_ship", "Ship match ambiguous"));
    } else if (shipResult.status === "not_found") {
      const bookingShip = String(booking.cruise_ship || "").trim();
      const bookingShipResult = bookingShip
        ? resolveCruiseShip(ships, bookingShip, lineForShip)
        : { status: "not_found" };
      if (bookingShipResult.status === "matched" && normaliseText(shipName) === normaliseText(bookingShip)) {
        diagnostics.ship_resolution = {
          status: "matched",
          ship_id: bookingShipResult.ship?.id || null,
          ship_name: bookingShipResult.ship?.name || null,
          via: "booking_ship_name"
        };
      } else {
        failures.push(
          reason("ship_not_found", "Ship could not be resolved unambiguously in the catalogue", {
            extracted: shipName,
            booking: bookingShip || null
          })
        );
      }
    }
  } else {
    const bookingShip = String(booking.cruise_ship || "").trim();
    if (bookingShip) {
      const viaBooking = resolveCruiseShip(
        [{ id: "booking", name: bookingShip, cruise_line_name: lineForShip }],
        shipName,
        lineForShip
      );
      diagnostics.ship_resolution = { status: viaBooking.status, via: "booking_only_catalogue" };
      if (viaBooking.status !== "matched") {
        failures.push(reason("ambiguous_ship", "Ship match ambiguous"));
      }
    } else {
      diagnostics.ship_resolution = { status: "matched", via: "no_catalogue_no_booking_ship" };
    }
  }

  const embark = parseIsoDate(itinerary.embarkation_date);
  const disembark = parseIsoDate(itinerary.disembarkation_date);
  const bookingEmbark = parseIsoDate(booking.departing_date);
  const bookingDisembark = parseIsoDate(booking.arriving_date);

  if (!embark || !disembark) {
    failures.push(reason("missing_cruise_dates", "Embarkation or disembarkation date missing from extraction"));
  }
  if (embark && bookingEmbark && !datesEqual(embark, bookingEmbark)) {
    failures.push(
      reason("embarkation_date_mismatch", "Embarkation date does not match the booking", {
        extracted: embark,
        booking: bookingEmbark
      })
    );
  }
  if (disembark && bookingDisembark && !datesEqual(disembark, bookingDisembark)) {
    failures.push(
      reason("disembarkation_date_mismatch", "Disembarkation date does not match the booking", {
        extracted: disembark,
        booking: bookingDisembark
      })
    );
  }

  let prevDate = null;
  let hasEmbarkStop = false;
  let hasDisembarkStop = false;
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i] || {};
    const type = String(stop.entry_type || stop.type || "").toLowerCase();
    if (type === "embarkation") hasEmbarkStop = true;
    if (type === "disembarkation") hasDisembarkStop = true;
    const stopDate = parseIsoDate(stop.date);
    if (!stopDate) {
      failures.push(reason("invalid_stop_date", `Stop ${i + 1} has an invalid date`, { index: i, name: stop.name }));
      continue;
    }
    if (prevDate && stopDate < prevDate) {
      failures.push(
        reason("stops_not_chronological", "Stop dates are not chronological", {
          index: i,
          date: stopDate,
          previous: prevDate
        })
      );
    }
    prevDate = stopDate;
    const rangeStart = bookingEmbark || embark;
    const rangeEnd = bookingDisembark || disembark;
    if (rangeStart && rangeEnd && (stopDate < rangeStart || stopDate > rangeEnd)) {
      failures.push(
        reason("stop_outside_cruise_dates", "Stop falls outside the cruise date range", {
          index: i,
          name: stop.name,
          date: stopDate
        })
      );
    }
  }
  if (stops.length && !hasEmbarkStop) {
    failures.push(reason("missing_embarkation_stop", "Embarkation stop is missing"));
  }
  if (stops.length && !hasDisembarkStop) {
    failures.push(reason("missing_disembarkation_stop", "Disembarkation stop is missing"));
  }

  const overall = Number(itinerary.confidence);
  if (!Number.isFinite(overall) || overall < THRESHOLDS.overallConfidence) {
    failures.push(
      reason("overall_confidence_low", "Overall extraction confidence is below threshold", {
        confidence: Number.isFinite(overall) ? overall : null,
        required: THRESHOLDS.overallConfidence
      })
    );
  }

  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i] || {};
    if (isSeaDay(stop)) continue;
    const conf = Number(stop.confidence);
    const type = String(stop.entry_type || stop.type || "").toLowerCase();
    if (type === "embarkation" || type === "disembarkation") {
      if (!Number.isFinite(conf) || conf < THRESHOLDS.embarkDisembarkConfidence) {
        failures.push(
          reason(
            type === "embarkation" ? "embarkation_confidence_low" : "disembarkation_confidence_low",
            `${type} confidence is below threshold`,
            { index: i, name: stop.name, confidence: conf }
          )
        );
      }
    } else if (isPortLike(stop)) {
      if (!Number.isFinite(conf) || conf < THRESHOLDS.ordinaryPortConfidence) {
        failures.push(
          reason("port_confidence_low", "Port confidence is below threshold", {
            index: i,
            name: stop.name,
            confidence: conf
          })
        );
      }
    }
  }

  const index =
    options.portsIndex || buildPortIndex(Array.isArray(options.portRows) ? options.portRows : []);
  const plottedKeys = [];
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i] || {};
    if (isSeaDay(stop)) {
      diagnostics.port_matches.push({
        index: i,
        name: stop.name,
        status: "sea_day",
        requires_coordinates: false
      });
      continue;
    }
    if (!isPortLike(stop)) continue;
    const diagnosis = diagnosePortMatch(stop.name, index.portsByKey, index.metaByKey);
    diagnostics.port_matches.push({
      index: i,
      name: stop.name,
      status: diagnosis.status,
      canonical_name: diagnosis.meta?.canonical_name || null,
      method: diagnosis.method || null
    });
    if (diagnosis.status === "ambiguous") {
      failures.push(
        reason("ambiguous_port", "Port match is ambiguous", {
          index: i,
          name: stop.name,
          candidates: diagnosis.candidates || []
        })
      );
      continue;
    }
    if (diagnosis.status !== "matched" || !diagnosis.hit) {
      failures.push(
        reason("unresolved_port", "Port could not be resolved to a canonical port", {
          index: i,
          name: stop.name
        })
      );
      continue;
    }
    const lat = Number(diagnosis.hit.lat);
    const lng = Number(diagnosis.hit.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      failures.push(
        reason("missing_coordinates", "Resolved port is missing coordinates", {
          index: i,
          name: stop.name
        })
      );
      continue;
    }
    const key = `${lat},${lng}`;
    if (!plottedKeys.length || plottedKeys[plottedKeys.length - 1] !== key) {
      plottedKeys.push(key);
    }
  }
  diagnostics.unique_plotted_ports = plottedKeys.length;
  if (plottedKeys.length < 2) {
    failures.push(
      reason("insufficient_unique_ports", "At least two unique ports with coordinates are required", {
        unique_plotted_ports: plottedKeys.length
      })
    );
  }

  if (
    existing &&
    String(existing.status) === "approved" &&
    sourceDocumentHash &&
    existing.source_document_hash &&
    existing.source_document_hash !== sourceDocumentHash
  ) {
    diagnostics.replacement_of_approved = true;
    diagnostics.prior_source_document_hash = existing.source_document_hash;
  }

  if (
    existing &&
    String(existing.status) === "approved" &&
    options.treatReplacementAsConflict &&
    sourceDocumentHash &&
    existing.source_document_hash &&
    existing.source_document_hash !== sourceDocumentHash
  ) {
    failures.push(
      reason("conflicting_approved_itinerary", "An approved itinerary already exists for a different confirmation", {
        existing_hash: existing.source_document_hash,
        new_hash: sourceDocumentHash
      })
    );
  }

  return {
    ok: failures.length === 0,
    validation_version: VALIDATION_VERSION,
    failures,
    summary: conciseSummary(failures),
    diagnostics,
    thresholds: THRESHOLDS
  };
}

module.exports = {
  VALIDATION_VERSION,
  THRESHOLDS,
  validateItineraryForAutoApproval,
  conciseSummary,
  isSeaDay,
  parseIsoDate
};
