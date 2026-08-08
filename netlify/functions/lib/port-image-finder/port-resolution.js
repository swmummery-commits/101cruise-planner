/**
 * Strict canonical port resolution for batch / bulk port image operations.
 * Never apply imagery to a loosely matched port record.
 */

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function portHaystack(port) {
  return [port?.canonical_name, port?.display_name, port?.city, port?.country, port?.region, ...(port?.aliases || [])]
    .filter(Boolean)
    .join(" ");
}

function portNames(port) {
  return [port?.canonical_name, port?.display_name, port?.city, ...(Array.isArray(port?.aliases) ? port.aliases : [])]
    .filter(Boolean)
    .map(normalizeKey);
}

function matchesLoose(port, spec) {
  const hay = portHaystack(port);
  if (spec.exclude && spec.exclude.test(hay)) return false;
  if (spec.region && !spec.region.test(String(port.region || ""))) return false;
  if (spec.country && !spec.country.test(hay)) return false;
  return portNames(port).some((name) => spec.match.test(name));
}

function validatePortIdentity(port, spec) {
  if (!port?.id) return { ok: false, reason: "missing_port_id" };

  const canonical = normalizeKey(port.canonical_name);
  const hay = portHaystack(port);

  if (spec.requireCanonical && !spec.requireCanonical.test(String(port.canonical_name || ""))) {
    return { ok: false, reason: "canonical_name_mismatch", canonical: port.canonical_name };
  }
  if (spec.forbiddenCanonical && spec.forbiddenCanonical.test(String(port.canonical_name || ""))) {
    return { ok: false, reason: "forbidden_canonical", canonical: port.canonical_name };
  }
  if (spec.requireCanonicalKey && canonical !== spec.requireCanonicalKey) {
    return { ok: false, reason: "canonical_key_mismatch", canonical: port.canonical_name };
  }
  if (spec.requireAnyName) {
    const names = portNames(port);
    if (!names.some((name) => spec.requireAnyName.test(name))) {
      return { ok: false, reason: "required_name_missing", canonical: port.canonical_name };
    }
  }
  if (spec.country && !spec.country.test(hay)) {
    return { ok: false, reason: "country_mismatch", country: port.country };
  }
  if (spec.region && !spec.region.test(String(port.region || ""))) {
    return { ok: false, reason: "region_mismatch", region: port.region };
  }
  if (spec.forbiddenHaystack && spec.forbiddenHaystack.test(hay)) {
    return { ok: false, reason: "forbidden_haystack", canonical: port.canonical_name };
  }
  return { ok: true };
}

/**
 * Resolve exactly one canonical port for a batch specification.
 * @returns {{ ok: true, port: object } | { ok: false, code: 'PORT_RESOLUTION_FAILED', reason: string, candidates?: object[] }}
 */
function resolveCanonicalPort(allPorts, spec) {
  const loose = (allPorts || []).filter((port) => matchesLoose(port, spec));
  const validated = loose
    .map((port) => ({ port, validation: validatePortIdentity(port, spec) }))
    .filter((row) => row.validation.ok);

  if (validated.length === 0) {
    if (loose.length > 0) {
      return {
        ok: false,
        code: "PORT_RESOLUTION_FAILED",
        reason: "identity_validation_failed",
        candidates: loose.map((p) => ({ id: p.id, canonical_name: p.canonical_name, country: p.country }))
      };
    }
    return { ok: false, code: "PORT_RESOLUTION_FAILED", reason: "not_found" };
  }

  if (validated.length > 1) {
    return {
      ok: false,
      code: "PORT_RESOLUTION_FAILED",
      reason: "ambiguous",
      candidates: validated.map((row) => ({
        id: row.port.id,
        canonical_name: row.port.canonical_name,
        country: row.port.country
      }))
    };
  }

  return { ok: true, port: validated[0].port };
}

function assertCanonicalApplyTarget(spec, port) {
  const validation = validatePortIdentity(port, spec);
  if (!validation.ok) {
    const err = new Error(
      `PORT_RESOLUTION_FAILED: ${spec.label || "requested port"} cannot be applied to ${port?.canonical_name || "unknown"} (${validation.reason})`
    );
    err.code = "PORT_RESOLUTION_FAILED";
    err.calm = true;
    throw err;
  }
  if (spec.expectedPortId && port.id !== spec.expectedPortId) {
    const err = new Error(`PORT_RESOLUTION_FAILED: resolved port ID mismatch for ${spec.label || "requested port"}`);
    err.code = "PORT_RESOLUTION_FAILED";
    err.calm = true;
    throw err;
  }
  return port;
}

module.exports = {
  normalizeKey,
  portHaystack,
  portNames,
  matchesLoose,
  validatePortIdentity,
  resolveCanonicalPort,
  assertCanonicalApplyTarget
};
