/**
 * Guard against duplicate canonical port records sharing identity keys.
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
  const byNameCountry = new Map();
  for (const port of ports || []) {
    const name = String(port.canonical_name || "").trim().toLowerCase();
    if (!name) continue;
    const country = String(port.country || "").trim().toLowerCase() || "(null)";
    const composite = `${name}|${country}`;
    if (!byNameCountry.has(composite)) byNameCountry.set(composite, []);
    byNameCountry.get(composite).push(port);
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

module.exports = {
  normalizeIdentity,
  findDuplicateCanonicalPorts,
  assertNoDuplicateCanonicalPorts
};
