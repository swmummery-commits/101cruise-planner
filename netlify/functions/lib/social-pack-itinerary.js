/**
 * Itinerary / port list helpers for Social Pack Slide 2.
 */

function parseItinerarySummary(summary) {
  return String(summary || "")
    .split("|")
    .map((part) =>
      String(part)
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .replace(/,\s*[A-Z][a-zA-Z\s]*$/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function portsFromStops(stops) {
  const ordered = [...(stops || [])].sort((a, b) => {
    const ao = Number(a.stop_order ?? a.day_number ?? 0);
    const bo = Number(b.stop_order ?? b.day_number ?? 0);
    return ao - bo;
  });
  return ordered
    .map((s) => String(s.port_label || s.name || s.port_name || "").trim())
    .filter(Boolean);
}

/**
 * Prefer structured stops; else itinerary_summary.
 * Keep departure, major intermediates, arrival. Cap for legibility.
 */
function buildPortList({ stops, itinerarySummary, departurePort, arrivalPort, maxPorts = 8 }) {
  let ports = portsFromStops(stops);
  if (!ports.length) ports = parseItinerarySummary(itinerarySummary);

  const dep = String(departurePort || "").trim();
  const arr = String(arrivalPort || "").trim();
  if (dep && (!ports.length || ports[0].toLowerCase() !== dep.toLowerCase())) {
    ports = [dep, ...ports];
  }
  if (arr && (!ports.length || ports[ports.length - 1].toLowerCase() !== arr.toLowerCase())) {
    ports = [...ports, arr];
  }

  // Deduplicate consecutive duplicates only
  const deduped = [];
  for (const p of ports) {
    if (!deduped.length || deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()) {
      deduped.push(p);
    }
  }

  if (deduped.length <= maxPorts) {
    return { ports: deduped, truncated: false, omitted: 0 };
  }

  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  const middleBudget = Math.max(1, maxPorts - 2);
  const middle = deduped.slice(1, -1);
  const step = Math.max(1, Math.ceil(middle.length / middleBudget));
  const picked = [];
  for (let i = 0; i < middle.length && picked.length < middleBudget; i += step) {
    picked.push(middle[i]);
  }
  const portsOut = [first, ...picked, last];
  const omitted = Math.max(0, deduped.length - portsOut.length);
  return { ports: portsOut, truncated: omitted > 0, omitted };
}

function buildInclusions(cruise, { max = 4 } = {}) {
  const labels = [];
  const map = [
    ["wifi", "Wi-Fi"],
    ["gratuities", "Gratuities"],
    ["alcohol_package", "Alcohol Package"],
    ["all_tours", "All Tours"],
    ["all_dining", "All Dining"],
    ["laundry", "Laundry"]
  ];
  for (const [key, label] of map) {
    if (cruise?.[key]) labels.push(label);
  }
  const obc = Number(cruise?.onboard_credit);
  if (Number.isFinite(obc) && obc > 0) {
    labels.push(`On Board Credit $${Math.round(obc)}`);
  }
  return labels.slice(0, max);
}

module.exports = {
  parseItinerarySummary,
  portsFromStops,
  buildPortList,
  buildInclusions
};
