/**
 * Guard against duplicate canonical port records sharing identity keys.
 *
 * Physical port vs customer-facing destination:
 * - canonical_name / city / coordinates / match_key identify the physical berth
 * - display_name and qualified aliases carry marketed destination labels
 *   (e.g. Laem Chabang display "Laem Chabang (Bangkok)", Phu My display
 *   "Phu My (Ho Chi Minh City)") without merging distinct physical ports
 */

function normalizeIdentity(name, country, matchKey) {
  if (matchKey && String(matchKey).trim()) {
    return String(matchKey).trim().toLowerCase();
  }
  const n = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const c = String(country || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return c ? `${n}|${c}` : `${n}|`;
}

function findDuplicateCanonicalPorts(ports) {
  const byKey = new Map();
  const duplicates = [];
  for (const port of ports || []) {
    const key = normalizeIdentity(port.canonical_name, port.country, port.match_key);
    if (!key || key === "|") continue;
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(port);
  }
  for (const [key, group] of byKey.entries()) {
    if (group.length > 1) {
      duplicates.push({ key, ports: group });
    }
  }
  const byName = new Map();
  for (const port of ports || []) {
    const name = String(port.canonical_name || "").trim().toLowerCase();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(port);
  }
  for (const [name, group] of byName.entries()) {
    if (group.length <= 1) continue;
    if (duplicates.some((d) => d.key === name && d.byName)) continue;
    duplicates.push({ key: name, ports: group, byName: true });
  }
  return duplicates;
}

function assertNoDuplicateCanonicalPorts(ports) {
  const duplicates = findDuplicateCanonicalPorts(ports);
  if (!duplicates.length) return duplicates;
  const summary = duplicates
    .map((d) => `${d.key}: ${d.ports.map((p) => p.id || p.canonical_name).join(", ")}`)
    .join("; ");
  throw new Error(`Duplicate canonical port records: ${summary}`);
}

function isSuspiciousCanonicalPortName(name) {
  const n = String(name || "").trim();
  if (!n) return { suspicious: true, reason: "blank" };
  if (/^\d+$/.test(n)) return { suspicious: true, reason: "numeric" };
  if (/\b(20\d{2}|19\d{2})\b/.test(n) && n.length < 24) return { suspicious: true, reason: "year_or_date" };
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(n)) return { suspicious: true, reason: "month" };
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(n)) {
    return { suspicious: true, reason: "month" };
  }
  if (/\b\d+\s*(nights?|days?)\b/i.test(n)) return { suspicious: true, reason: "duration" };
  if (/\b(embark|disembark|at sea|sea day)\b/i.test(n)) return { suspicious: true, reason: "itinerary_label" };
  return { suspicious: false, reason: null };
}

function assertCanonicalPortNameAllowed(name) {
  const check = isSuspiciousCanonicalPortName(name);
  if (check.suspicious) {
    throw new Error(`Invalid canonical port name (${check.reason}): ${name}`);
  }
}

module.exports = {
  normalizeIdentity,
  findDuplicateCanonicalPorts,
  assertNoDuplicateCanonicalPorts,
  isSuspiciousCanonicalPortName,
  assertCanonicalPortNameAllowed
};
