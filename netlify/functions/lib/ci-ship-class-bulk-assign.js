const CiShipClassBulk = require("../../../js/ci-ship-class-bulk.js");

function buildAssignPayload(body) {
  return {
    cruiseLineId: body.cruise_line_id,
    shipIds: body.ship_ids,
    shipClass: body.ship_class,
    ships: null,
    replacementConfirmed: Boolean(body.replacement_confirmed)
  };
}

function buildClearPayload(body) {
  return {
    cruiseLineId: body.cruise_line_id,
    shipIds: body.ship_ids,
    ships: null
  };
}

module.exports = {
  CiShipClassBulk,
  buildAssignPayload,
  buildClearPayload
};
