/**
 * Cruise Finder — approved cruise lines (central list).
 * Only these names may appear on recommendation cards.
 * 101cruise does not sell P&O Cruises Australia.
 */
(function (root) {
  "use strict";

  const APPROVED_CRUISE_LINES = [
    "Holland America",
    "Princess",
    "Celebrity",
    "Royal Caribbean",
    "MSC",
    "Norwegian",
    "Explora",
    "Viking",
    "Hurtigruten",
    "Silversea",
    "Seabourn",
    "Ponant",
    "Carnival"
  ];

  const approvedSet = Object.create(null);
  APPROVED_CRUISE_LINES.forEach((name) => {
    approvedSet[name.toLowerCase()] = name;
  });

  function filterApprovedCruiseLines(names) {
    if (!Array.isArray(names)) return [];
    const out = [];
    const seen = Object.create(null);
    names.forEach((raw) => {
      const key = String(raw || "")
        .trim()
        .toLowerCase();
      if (!key || seen[key]) return;
      const canonical = approvedSet[key];
      if (!canonical) return;
      seen[key] = true;
      out.push(canonical);
    });
    return out;
  }

  root.CruiseFinderApprovedCruiseLines = APPROVED_CRUISE_LINES;
  root.CruiseFinderFilterCruiseLines = filterApprovedCruiseLines;
})(typeof window !== "undefined" ? window : globalThis);
