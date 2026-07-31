/**
 * Ship facilities copy — category-level (legacy) and item-level merge helpers.
 */
const CiFac = require("../../../js/ci-ship-facilities.js");
const ItemCopy = require("../../../js/ci-ship-facilities-item-copy.js");

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

function executeItemLevelCopy({ sourceFacilities, target, resolvedItems, conflictResolutions }) {
  const plans = ItemCopy.buildCopyPlans({
    sourceFacilities,
    targets: [{ id: target.id, name: target.name, facilities: target.facilities }],
    selectedItems: resolvedItems,
    conflictResolutions
  });
  const plan = plans[0];
  if (!plan || plan.summary.noChanges) {
    return { ok: false, error: "NO_CHANGES", plan };
  }
  const applied = ItemCopy.applyItemLevelCopyToFacilities(target.facilities, plan.items);
  const sourceItemsByKey = ItemCopy.buildSourceItemsByKey(sourceFacilities);
  const resultPayload = {
    id: target.id,
    name: target.name,
    ok: true,
    outcomes: applied.outcomes
  };
  ItemCopy.assertResultOutcomesReconcile({
    plans: [plan],
    results: [resultPayload],
    sourceFacilities: sourceFacilities
  });
  const resultRow = ItemCopy.buildResultRow(target.name, applied.outcomes, sourceItemsByKey);
  return {
    ok: true,
    facilities: applied.facilities,
    outcomes: applied.outcomes,
    summary: plan.summary,
    resultRow
  };
}

module.exports = {
  mergeFacilitiesCopy: CiFac.mergeFacilitiesCopy,
  validateSameClassCopyRequest: CiFac.validateSameClassCopyRequest,
  serializeExclusiveAreasFromAdmin: CiFac.serializeExclusiveAreasFromAdmin,
  serializeSpecialtyFeaturesFromAdmin: CiFac.serializeSpecialtyFeaturesFromAdmin,
  buildFacilitiesPatch,
  ItemCopy,
  executeItemLevelCopy
};
