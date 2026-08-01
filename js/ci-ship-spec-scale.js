/**
 * Cruise Intelligence — My Ship specifications and scale row builders.
 * Shared by My Ship renderer, Admin previews, and offline tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipSpecScale = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const SPACE_RATIO_BANDS = [
    { max: 30, label: "Compact and lively" },
    { max: 41, label: "Standard spaciousness" },
    { max: 51, label: "Comfortably spacious" },
    { max: 75, label: "Very spacious" },
    { max: Infinity, label: "Exceptionally spacious" }
  ];

  function parsePositiveNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(String(value).replace(/,/g, "").trim());
    if (!Number.isFinite(number) || number <= 0) return null;
    return number;
  }

  function parsePositiveInteger(value) {
    const number = parsePositiveNumber(value);
    if (number == null || !Number.isInteger(number)) return null;
    return number;
  }

  function formatIntegerEnAu(value) {
    return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(value));
  }

  function formatOneDecimal(value) {
    return new Intl.NumberFormat("en-AU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    }).format(value);
  }

  function formatCruisingSpeedKnots(value) {
    const number = parsePositiveNumber(value);
    if (number == null) return null;
    const rounded = Math.round(number);
    if (rounded <= 0) return null;
    const unit = rounded === 1 ? "knot" : "knots";
    return `${formatIntegerEnAu(rounded)} ${unit}`;
  }

  function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function computeSpaceRatioPopoverPosition({
    triggerRect,
    anchorRect,
    columnRect,
    avoidRects = [],
    popoverWidth,
    popoverHeight,
    viewportWidth,
    viewportHeight,
    margin = 12,
    gap = 8
  }) {
    const anchor = anchorRect || triggerRect;
    const column = columnRect || anchor;

    let placement = "below";
    let top = anchor.bottom + gap;
    if (top + popoverHeight > viewportHeight - margin) {
      placement = "above";
      top = anchor.top - popoverHeight - gap;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - popoverHeight - margin));

    let left = column.right - popoverWidth;
    left = Math.max(margin, Math.min(left, viewportWidth - margin - popoverWidth));

    const popoverBox = () => ({
      top,
      left,
      right: left + popoverWidth,
      bottom: top + popoverHeight
    });

    for (const avoid of avoidRects) {
      if (!avoid) continue;
      if (!rectsIntersect(popoverBox(), avoid)) continue;
      const shiftedLeft = avoid.left - gap - popoverWidth;
      if (shiftedLeft >= margin) {
        left = shiftedLeft;
        continue;
      }
      left = Math.max(margin, Math.min(left, column.left));
    }

    left = Math.max(margin, Math.min(left, viewportWidth - margin - popoverWidth));

    return { top, left, placement };
  }

  const MOBILE_SPACE_RATIO_MAX_WIDTH = 760;

  function readLengthMetres(ship) {
    if (!ship || typeof ship !== "object") return null;
    return parsePositiveNumber(ship.length_meters ?? ship.length_metres);
  }

  function buildGuestToCrewRatio(passengerCapacity, crewCount) {
    const passengers = parsePositiveInteger(passengerCapacity);
    const crew = parsePositiveInteger(crewCount);
    if (passengers == null || crew == null) return null;
    return `${formatOneDecimal(passengers / crew)} : 1`;
  }

  function classifySpaceRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    if (ratio < 30) return "Compact and lively";
    if (ratio < 41) return "Standard spaciousness";
    if (ratio < 51) return "Comfortably spacious";
    if (ratio <= 75) return "Very spacious";
    return "Exceptionally spacious";
  }

  function buildSpaceRatio(grossTonnage, passengerCapacity) {
    const tonnage = parsePositiveNumber(grossTonnage);
    const passengers = parsePositiveInteger(passengerCapacity);
    if (tonnage == null || passengers == null) return null;
    const rawRatio = tonnage / passengers;
    if (!Number.isFinite(rawRatio) || rawRatio <= 0) return null;
    return {
      rawRatio,
      value: `${formatOneDecimal(rawRatio)} GT per guest`,
      interpretation: classifySpaceRatio(rawRatio)
    };
  }

  function buildShipSpecificationRows(ship) {
    const rows = [];
    const decks = parsePositiveInteger(ship?.deck_count);
    const passengers = parsePositiveInteger(ship?.passenger_capacity);
    const crew = parsePositiveInteger(ship?.crew_count);
    const guestToCrew = buildGuestToCrewRatio(passengers, crew);

    if (decks != null) rows.push({ label: "Total decks", value: formatIntegerEnAu(decks), kind: "plain" });
    if (passengers != null) rows.push({ label: "Passengers", value: formatIntegerEnAu(passengers), kind: "plain" });
    if (crew != null) rows.push({ label: "Crew", value: formatIntegerEnAu(crew), kind: "plain" });
    if (guestToCrew) rows.push({ label: "Guest-to-crew ratio", value: guestToCrew, kind: "plain" });
    return rows;
  }

  function buildShipScaleRows(ship) {
    const rows = [];
    const tonnage = parsePositiveNumber(ship?.gross_tonnage);
    const lengthMetres = readLengthMetres(ship);
    const beamMetres = parsePositiveNumber(ship?.beam_metres);
    const cruisingSpeed = parsePositiveNumber(ship?.cruising_speed_knots);
    const spaceRatio = buildSpaceRatio(ship?.gross_tonnage, ship?.passenger_capacity);

    if (tonnage != null) rows.push({ label: "Gross tonnage", value: `${formatIntegerEnAu(tonnage)} GT`, kind: "plain" });
    if (lengthMetres != null) rows.push({ label: "Length", value: `${formatIntegerEnAu(lengthMetres)} metres`, kind: "plain" });
    if (beamMetres != null) rows.push({ label: "Width (beam)", value: `${formatIntegerEnAu(beamMetres)} metres`, kind: "plain" });
    if (cruisingSpeed != null) {
      const speedLabel = formatCruisingSpeedKnots(cruisingSpeed);
      if (speedLabel) rows.push({ label: "Cruising speed", value: speedLabel, kind: "plain" });
    }
    if (spaceRatio) {
      rows.push({
        label: "Space ratio",
        value: spaceRatio.value,
        interpretation: spaceRatio.interpretation,
        kind: "space_ratio"
      });
    }
    return rows;
  }

  return {
    SPACE_RATIO_BANDS,
    parsePositiveNumber,
    parsePositiveInteger,
    formatIntegerEnAu,
    formatOneDecimal,
    formatCruisingSpeedKnots,
    computeSpaceRatioPopoverPosition,
    rectsIntersect,
    MOBILE_SPACE_RATIO_MAX_WIDTH,
    readLengthMetres,
    buildGuestToCrewRatio,
    classifySpaceRatio,
    buildSpaceRatio,
    buildShipSpecificationRows,
    buildShipScaleRows
  };
});
