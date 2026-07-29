/**
 * Deterministic social headline + date helpers (no LLM).
 */

const HANGING = new Set([
  "and",
  "to",
  "on",
  "with",
  "of",
  "the",
  "a",
  "an",
  "for",
  "in",
  "at",
  "from"
]);

function normaliseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenHeadline(raw, { maxWords = 10, maxLines = 2 } = {}) {
  const text = normaliseWhitespace(raw).replace(/[.!?]+$/g, "");
  if (!text) return "";
  const words = text.split(" ");
  let selected = words.slice(0, maxWords);
  while (selected.length && HANGING.has(selected[selected.length - 1].toLowerCase())) {
    selected.pop();
  }
  if (!selected.length) selected = words.slice(0, Math.min(3, words.length));
  let line = selected.join(" ");
  // Soft two-line split near midpoint for longer phrases
  if (selected.length > 5 && maxLines >= 2) {
    const mid = Math.ceil(selected.length / 2);
    const first = selected.slice(0, mid).join(" ");
    const second = selected.slice(mid).join(" ");
    return `${first}\n${second}`;
  }
  return line;
}

function formatAuDateRange(departure, returnDate) {
  const parse = (iso) => {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const start = parse(departure);
  const end = parse(returnDate);
  if (!start) return "";
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const d1 = start.getDate();
  const m1 = months[start.getMonth()];
  const y1 = start.getFullYear();
  if (!end) return `${d1} ${m1} ${y1}`;
  const d2 = end.getDate();
  const m2 = months[end.getMonth()];
  const y2 = end.getFullYear();
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${m1} ${y1}`;
  if (y1 === y2) return `${d1} ${m1} – ${d2} ${m2} ${y1}`;
  return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
}

const FULL_MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER"
];

function parseIsoDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** DEPARTING 17 AUGUST 2026 */
function formatAuDepartingFull(departure) {
  const d = parseIsoDate(departure);
  if (!d) return "";
  return `DEPARTING ${d.getDate()} ${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 17–27 AUGUST 2026 or 17 AUGUST – 2 SEPTEMBER 2026 */
function formatAuRangeFull(departure, returnDate) {
  const start = parseIsoDate(departure);
  const end = parseIsoDate(returnDate);
  if (!start) return "";
  const d1 = start.getDate();
  const m1 = FULL_MONTHS[start.getMonth()];
  const y1 = start.getFullYear();
  if (!end) return `${d1} ${m1} ${y1}`;
  const d2 = end.getDate();
  const m2 = FULL_MONTHS[end.getMonth()];
  const y2 = end.getFullYear();
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${m1} ${y1}`;
  if (y1 === y2) return `${d1} ${m1} – ${d2} ${m2} ${y1}`;
  return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
}

function formatDuration(nights) {
  const n = Number(nights);
  if (!Number.isFinite(n) || n < 1) return "";
  return `${Math.trunc(n)}-NIGHT`;
}

/** 10 NIGHTS */
function formatNightsLabel(nights) {
  const n = Number(nights);
  if (!Number.isFinite(n) || n < 1) return "";
  const v = Math.trunc(n);
  return `${v} NIGHT${v === 1 ? "" : "S"}`;
}

/**
 * Deterministic route headline from departure + arrival ports.
 * BARCELONA TO ISTANBUL
 */
function buildRouteHeadline(departurePort, arrivalPort) {
  const dep = normaliseWhitespace(departurePort)
    .replace(/,.*$/, "")
    .trim()
    .toUpperCase();
  const arr = normaliseWhitespace(arrivalPort)
    .replace(/,.*$/, "")
    .trim()
    .toUpperCase();
  if (dep && arr) return `${dep} TO ${arr}`;
  return dep || arr || "";
}

function buildAboardLine(lineName, shipName) {
  const line = normaliseWhitespace(lineName).toUpperCase();
  const ship = normaliseWhitespace(shipName).toUpperCase();
  if (line && ship) {
    // Avoid "OCEANIA CRUISES OCEANIA SIRENA" duplication when ship already branded
    if (ship.includes(line.replace(/\s+CRUISES?$/i, "").trim()) || ship.startsWith("OCEANIA ")) {
      return `ABOARD ${ship}`;
    }
    return `ABOARD ${line.replace(/\s+CRUISES?$/i, "").trim()} ${ship}`.replace(/\s+/g, " ");
  }
  if (ship) return `ABOARD ${ship}`;
  return "";
}

function slugifyPart(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "cruise";
}

function cruiseFolderSlug({ index, lineName, shipName, destinationStrip }) {
  const n = String(Number(index) || 1).padStart(2, "0");
  const dest = slugifyPart(destinationStrip);
  const line = slugifyPart(lineName);
  const ship = slugifyPart(shipName);
  return `${n}-${line}-${ship}-${dest}`.replace(/-+/g, "-").slice(0, 80);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = {
  shortenHeadline,
  formatAuDateRange,
  formatAuDepartingFull,
  formatAuRangeFull,
  formatDuration,
  formatNightsLabel,
  buildRouteHeadline,
  buildAboardLine,
  slugifyPart,
  cruiseFolderSlug,
  escapeXml,
  normaliseWhitespace
};
