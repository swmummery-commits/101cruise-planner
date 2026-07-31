/**
 * Same-class ship facilities copy — pure helpers for tests and Netlify handler.
 */
const {
  mergeFacilitiesCopy,
  validateSameClassCopyRequest,
  serializeExclusiveAreasFromAdmin,
  serializeSpecialtyFeaturesFromAdmin
} = require("../../../js/ci-ship-facilities.js");

function buildFacilitiesPatch(body) {
  const copyExclusive = Boolean(body.copy_exclusive_areas);
  const copySpecialty = Boolean(body.copy_specialty_features);
  if (!copyExclusive && !copySpecialty) {
    return { ok: false, error: "NO_SECTIONS_SELECTED" };
  }
  return {
    ok: true,
    patch: {
      copy_exclusive_areas: copyExclusive,
      copy_specialty_features: copySpecialty,
      exclusive_areas: copyExclusive ? body.exclusive_areas || [] : undefined,
      specialty_features: copySpecialty ? body.specialty_features || [] : undefined
    }
  };
}

module.exports = {
  mergeFacilitiesCopy,
  validateSameClassCopyRequest,
  serializeExclusiveAreasFromAdmin,
  serializeSpecialtyFeaturesFromAdmin,
  buildFacilitiesPatch
};
