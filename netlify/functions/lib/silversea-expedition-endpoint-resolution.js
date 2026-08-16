/**
 * Silversea Expedition endpoint resolution (Phase E2b).
 *
 * Expedition-scoped logistics gateway mappings satisfy endpoint eligibility without
 * treating fly-cruise gateways as conventional catalogue ports.
 * Classic must never call these helpers.
 */

const { resolveRawPortText } = require("./discovery-departure-port");

const EXPEDITION_LOGISTICS_GATEWAYS = Object.freeze({
  AQKGG: {
    gateway_name: "King George Island",
    country: "Antarctica",
    country_code: "AQ",
    evidence:
      "AQKGG is Silversea Antarctica fly-cruise logistics gateway (Teniente Marsh/Frei area), not a conventional harbour catalogue port.",
    rule_id: "aqkgg_king_george_logistics"
  },
  AQKGI: {
    gateway_name: "King George Island",
    country: "Antarctica",
    country_code: "AQ",
    evidence: "Legacy/alternate Silversea code for King George Island logistics gateway.",
    rule_id: "aqkgi_king_george_logistics"
  }
});

const GATEWAY_NAME_PATTERNS = Object.freeze([
  {
    pattern: /^king george island\b/i,
    code: "AQKGG",
    rule_id: "king_george_name_gateway"
  }
]);

function normalisePortCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function resolveExpeditionLogisticsGateway({ sourceName, portCode } = {}) {
  const code = normalisePortCode(portCode);
  const name = String(sourceName || "").trim();

  if (code && EXPEDITION_LOGISTICS_GATEWAYS[code]) {
    const gateway = EXPEDITION_LOGISTICS_GATEWAYS[code];
    return {
      status: "resolved",
      canonicalPortName: gateway.gateway_name,
      method: "expedition_logistics_gateway",
      expedition_logistics_gateway: true,
      logistics_gateway_code: code,
      logistics_gateway_rule_id: gateway.rule_id,
      country: gateway.country,
      confidence: "high",
      evidence: gateway.evidence
    };
  }

  for (const row of GATEWAY_NAME_PATTERNS) {
    if (name && row.pattern.test(name)) {
      const gateway = EXPEDITION_LOGISTICS_GATEWAYS[row.code];
      if (!gateway) continue;
      if (code && code !== row.code && EXPEDITION_LOGISTICS_GATEWAYS[code]) {
        return { status: "ambiguous", reason: "conflicting_gateway_code_name", rawValue: name, portCode: code };
      }
      return {
        status: "resolved",
        canonicalPortName: gateway.gateway_name,
        method: "expedition_logistics_gateway",
        expedition_logistics_gateway: true,
        logistics_gateway_code: row.code,
        logistics_gateway_rule_id: row.rule_id,
        country: gateway.country,
        confidence: "high",
        evidence: gateway.evidence
      };
    }
  }

  return null;
}

function isExpeditionCruiseType(cruiseType) {
  return String(cruiseType || "")
    .trim()
    .toLowerCase() === "expedition";
}

/**
 * Expedition-only port resolution: catalogue first, then logistics gateway mapping.
 */
function resolveExpeditionEndpointPort(value, sourceField, context = {}) {
  if (!isExpeditionCruiseType(context.cruiseType)) {
    return resolveRawPortText(value, { sourceField });
  }

  const direct = resolveRawPortText(value, { sourceField });
  if (direct.status === "resolved") return direct;

  const gateway = resolveExpeditionLogisticsGateway({
    sourceName: value,
    portCode: context.portCode
  });
  if (gateway) return { ...gateway, sourceField };

  return direct;
}

function isExpeditionEndpointResolved(portMeta) {
  if (!portMeta || portMeta.status !== "resolved") return false;
  if (portMeta.expedition_logistics_gateway) return true;
  return Boolean(portMeta.canonicalPortName);
}

module.exports = {
  EXPEDITION_LOGISTICS_GATEWAYS,
  resolveExpeditionLogisticsGateway,
  resolveExpeditionEndpointPort,
  isExpeditionEndpointResolved,
  isExpeditionCruiseType
};
