/**
 * Reconciled Celebrity fleet for class-template count invariants (fixtures / visual review).
 *
 * Active fleet: 14 = Edge(5) + Solstice(5) + Millennium(2) + unassigned(2)
 * Total ships: 15 (includes 1 inactive)
 */
const edgeTemplate = {
  exclusive_areas: [
    { name: "The Retreat", description: "Ship-within-a-ship for suite guests with Luminae and private sundeck." },
    { name: "Blu", description: "Exclusive restaurant for AquaClass guests." }
  ],
  specialty_features: ["Magic Carpet", "Eden", "Rooftop Garden", "Grand Plaza"]
};

const solsticeTemplate = {
  exclusive_areas: [{ name: "Suite Class", description: "Suite enclave." }],
  specialty_features: ["Pool", "Spa", "Solarium"]
};

module.exports = {
  cruiseLine: { id: "line-celeb-vr", name: "Celebrity Cruises" },
  templates: [
    {
      id: "tpl-edge-vr",
      cruise_line_id: "line-celeb-vr",
      class_name: "Edge class",
      class_key: "edge class",
      exclusive_areas: edgeTemplate.exclusive_areas,
      specialty_features: edgeTemplate.specialty_features
    },
    {
      id: "tpl-solstice-vr",
      cruise_line_id: "line-celeb-vr",
      class_name: "Solstice class",
      class_key: "solstice class",
      exclusive_areas: solsticeTemplate.exclusive_areas,
      specialty_features: solsticeTemplate.specialty_features
    }
  ],
  ships: [
    { id: "edge", name: "Celebrity Edge", cruise_line_id: "line-celeb-vr", ship_class: "Edge class", active: true, facilities: { exclusive_areas: edgeTemplate.exclusive_areas, specialty_features: edgeTemplate.specialty_features } },
    { id: "apex", name: "Celebrity Apex", cruise_line_id: "line-celeb-vr", ship_class: "Edge class", active: true, facilities: { exclusive_areas: [{ name: "The Retreat", description: "Different copy." }, { name: "Blu", description: "Exclusive restaurant for AquaClass guests." }], specialty_features: ["Eden", "Grand Plaza", "Solarium"] } },
    { id: "ascent", name: "Celebrity Ascent", cruise_line_id: "line-celeb-vr", ship_class: "Edge class", active: true, facilities: { exclusive_areas: [{ name: "The Retreat", description: "Suite enclave." }], specialty_features: ["Magic Carpet"] } },
    { id: "beyond", name: "Celebrity Beyond", cruise_line_id: "line-celeb-vr", ship_class: "Edge class", active: true, facilities: { exclusive_areas: [], specialty_features: ["Eden"] } },
    { id: "xcel", name: "Celebrity Xcel", cruise_line_id: "line-celeb-vr", ship_class: "Edge class", active: true, facilities: { exclusive_areas: [{ name: "The Retreat", description: "Legacy copy." }], specialty_features: ["Magic Carpet", "Eden", "Rooftop Garden", "Grand Plaza"] } },
    { id: "solstice", name: "Celebrity Solstice", cruise_line_id: "line-celeb-vr", ship_class: "Solstice class", active: true, facilities: { exclusive_areas: solsticeTemplate.exclusive_areas, specialty_features: solsticeTemplate.specialty_features } },
    { id: "equinox", name: "Celebrity Equinox", cruise_line_id: "line-celeb-vr", ship_class: "Solstice class", active: true, facilities: { exclusive_areas: solsticeTemplate.exclusive_areas, specialty_features: solsticeTemplate.specialty_features } },
    { id: "eclipse", name: "Celebrity Eclipse", cruise_line_id: "line-celeb-vr", ship_class: "Solstice class", active: true, facilities: { exclusive_areas: solsticeTemplate.exclusive_areas, specialty_features: solsticeTemplate.specialty_features } },
    { id: "silhouette", name: "Celebrity Silhouette", cruise_line_id: "line-celeb-vr", ship_class: "Solstice class", active: true, facilities: { exclusive_areas: solsticeTemplate.exclusive_areas, specialty_features: solsticeTemplate.specialty_features } },
    { id: "reflection", name: "Celebrity Reflection", cruise_line_id: "line-celeb-vr", ship_class: "Solstice class", active: true, facilities: { exclusive_areas: solsticeTemplate.exclusive_areas, specialty_features: solsticeTemplate.specialty_features } },
    { id: "millennium", name: "Celebrity Millennium", cruise_line_id: "line-celeb-vr", ship_class: "Millennium class", active: true, facilities: { exclusive_areas: [{ name: "The Retreat" }], specialty_features: ["Solarium"] } },
    { id: "summit", name: "Celebrity Summit", cruise_line_id: "line-celeb-vr", ship_class: "Millennium class", active: true, facilities: { exclusive_areas: [{ name: "Blu" }], specialty_features: ["Eden"] } },
    { id: "unassigned-a", name: "Celebrity Constellation", cruise_line_id: "line-celeb-vr", ship_class: "", active: true, facilities: { pools: 2 } },
    { id: "unassigned-b", name: "Celebrity Infinity", cruise_line_id: "line-celeb-vr", ship_class: "", active: true, facilities: { pools: 2 } },
    { id: "inactive-a", name: "Celebrity Journey (inactive)", cruise_line_id: "line-celeb-vr", ship_class: "Millennium class", active: false, facilities: {} }
  ],
  expected: {
    totalShipCount: 15,
    activeShipCount: 14,
    inactiveShipCount: 1,
    unassignedActiveCount: 2,
    classifiedActiveCount: 12
  }
};
