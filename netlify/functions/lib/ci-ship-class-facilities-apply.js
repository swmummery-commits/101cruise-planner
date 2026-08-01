/**
 * Apply class facilities templates to ships in a class (replace EA + SF).
 */
const {
  Replace,
  ClassTpl,
  assertFacilitiesOnlyPatch
} = require("./ci-ship-class-facilities-shared");

function validateApplyRequest({ cruiseLineId, className, storedTemplate }) {
  if (!cruiseLineId) return { ok: false, error: "MISSING_CRUISE_LINE" };
  if (!className) return { ok: false, error: "MISSING_CLASS_NAME" };
  if (!storedTemplate) return { ok: false, error: "MISSING_TEMPLATE" };
  const validation = ClassTpl.validateTemplatePayload({
    exclusive_areas: storedTemplate.exclusive_areas,
    specialty_features: storedTemplate.specialty_features
  });
  if (!validation.ok) return validation;
  return { ok: true, template: validation.payload, className: className };
}

function executeApplyToShip(ship, template) {
  const applied = Replace.applyClassTemplateToFacilities(ship.facilities, template);
  return {
    ok: true,
    id: ship.id,
    name: ship.name,
    facilities: applied.facilities,
    changed: applied.changed,
    comparison: applied.comparison
  };
}

module.exports = {
  assertFacilitiesOnlyPatch,
  validateApplyRequest,
  executeApplyToShip,
  Replace,
  ClassTpl
};
