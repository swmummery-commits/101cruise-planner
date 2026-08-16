/**
 * Silversea Expedition Phase E2c — controlled destination taxonomy remediation.
 * Code-only Silversea source label → existing operational destination slug mappings.
 * No Supabase destination writes; no new canonical destinations in E2c.
 */

const MAX_E2C_DESTINATION_MAPPINGS = 3;

/** Normalised Silversea region label → existing operational destination slug. */
const E2C_SILVERSEA_DESTINATION_SLUGS = Object.freeze({
  "arctic & greenland": "northern-europe"
});

/** Human-readable manifest for apply/rollback reporting. */
const E2C_DESTINATION_MAPPING_MANIFEST = Object.freeze([
  {
    source_label: "ARCTIC & GREENLAND",
    source_label_normalised: "arctic & greenland",
    canonical_slug: "northern-europe",
    canonical_name: "Northern Europe",
    mapping_scope: "silversea_source_specific",
    global_alias: false,
    new_canonical: false,
    fuzzy_matching: false,
    evidence:
      "Silversea expedition marketing region spanning Iceland, Greenland, Svalbard and Norwegian Arctic. " +
      "Existing Northern Europe slug is broader than the source label (not narrower). Azamara ARCTIC maps to the same slug.",
    confidence: "high",
    supabase_action: "none"
  }
]);

function assertE2cManifestWithinLimit() {
  const count = Object.keys(E2C_SILVERSEA_DESTINATION_SLUGS).length;
  if (count > MAX_E2C_DESTINATION_MAPPINGS) {
    throw new Error(`E2c destination mapping count ${count} exceeds limit ${MAX_E2C_DESTINATION_MAPPINGS}`);
  }
  for (const row of E2C_DESTINATION_MAPPING_MANIFEST) {
    const slug = E2C_SILVERSEA_DESTINATION_SLUGS[row.source_label_normalised];
    if (slug !== row.canonical_slug) {
      throw new Error(`E2c manifest slug mismatch for ${row.source_label}`);
    }
  }
}

function buildE2cRollbackManifest() {
  return {
    phase: "expedition_e2c_destination_rollback",
    action: "remove_code_mappings",
    files: ["netlify/functions/lib/silversea-expedition-e2c-destination-batch.js"],
    adapter_revert: "remove E2C_SILVERSEA_DESTINATION_SLUGS spread from SILVERSEA_DESTINATION_SLUG",
    mappings_to_remove: E2C_DESTINATION_MAPPING_MANIFEST.map((row) => ({
      source_label: row.source_label,
      canonical_slug: row.canonical_slug
    })),
    supabase_rollback: "none"
  };
}

module.exports = {
  MAX_E2C_DESTINATION_MAPPINGS,
  E2C_SILVERSEA_DESTINATION_SLUGS,
  E2C_DESTINATION_MAPPING_MANIFEST,
  assertE2cManifestWithinLimit,
  buildE2cRollbackManifest
};
