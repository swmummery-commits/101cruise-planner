/**
 * Silversea Expedition Phase E2a — bounded deterministic semantic rule manifest.
 * Code-only; no port/destination/reference writes.
 */

const MAX_E2A_SEMANTIC_RULES = 30;

/** @typedef {{ rule_id: string; kind: 'exact'|'family'|'region_scoped'; scope: string; semantic: string; evidence: string; confidence: string }} E2aRuleSpec */

/** @type {E2aRuleSpec[]} */
const E2A_IMPLEMENTED_RULES = Object.freeze([
  {
    rule_id: "aqc41_elephant_island",
    kind: "exact",
    scope: "AQC41 + Elephant Island name guard",
    semantic: "landing_site",
    evidence: "AQC41 is Silversea Antarctica Elephant Island landing site; 17-voyage single-identity cluster.",
    confidence: "high"
  },
  {
    rule_id: "aqc_aqi_antarctica_family_routing",
    kind: "family",
    scope: "AQC*, AQI* → classifyAntarcticaFamily (fail-closed on code/name conflict)",
    semantic: "landing_site|scenic_region|transit",
    evidence: "AQC/AQI are Silversea Antarctica site codes; only AQC41 currently in catalogue.",
    confidence: "high"
  },
  {
    rule_id: "greenland_gl_country_family",
    kind: "family",
    scope: "GL* excluding conventional GLJHS/GLJAV catalogue ports",
    semantic: "landing_site|scenic_region",
    evidence: "GL prefix is Greenland country code on Silversea expedition stops; names include fjords/glaciers/settlements.",
    confidence: "high"
  },
  {
    rule_id: "kimberley_auj_auw_aus_region",
    kind: "region_scoped",
    scope: "AUJ*, AUW*, AUS* when destination=KIMBERLEY only",
    semantic: "landing_site|scenic_region|anchorage",
    evidence: "Kimberley expedition zodiac/landing sites; not applied globally to AU* conventional ports.",
    confidence: "medium-high"
  },
  {
    rule_id: "greenland_scenic_sund_pattern",
    kind: "family",
    scope: "Greenland name pattern \\bsund\\b → scenic_region",
    semantic: "scenic_region",
    evidence: "Scoresby Sund and similar Greenland sound systems are scenic expedition regions.",
    confidence: "high"
  }
]);

function assertE2aManifestWithinLimit() {
  if (E2A_IMPLEMENTED_RULES.length > MAX_E2A_SEMANTIC_RULES) {
    throw new Error(`E2a rule count ${E2A_IMPLEMENTED_RULES.length} exceeds limit ${MAX_E2A_SEMANTIC_RULES}`);
  }
}

function buildE2aRollbackManifest() {
  return {
    phase: "expedition_e2a_semantic_rollback",
    action: "revert_semantic_rules",
    files: [
      "netlify/functions/lib/silversea-expedition-semantics.js",
      "netlify/functions/lib/silversea-expedition-e2a-rules-batch.js"
    ],
    rules_to_remove: E2A_IMPLEMENTED_RULES.map((r) => r.rule_id),
    supabase_rollback: "none"
  };
}

module.exports = {
  MAX_E2A_SEMANTIC_RULES,
  E2A_IMPLEMENTED_RULES,
  assertE2aManifestWithinLimit,
  buildE2aRollbackManifest
};
