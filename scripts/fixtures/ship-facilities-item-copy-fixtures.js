/**
 * Celebrity Edge item-level facilities copy fixtures (development / screenshots only).
 */
module.exports = {
  cruiseLine: { id: "line-celeb", name: "Celebrity Cruises" },
  ships: [
    {
      id: "edge",
      name: "Celebrity Edge",
      cruise_line_id: "line-celeb",
      ship_class: "Edge class",
      active: true,
      facilities: {
        restaurants: 8,
        exclusive_areas: [
          {
            name: "The Retreat",
            description: "Ship-within-a-ship for suite guests with Luminae and private sundeck."
          },
          {
            name: "Blu",
            description: "Exclusive restaurant for AquaClass guests."
          }
        ],
        specialty_features: ["Magic Carpet", "Eden", "Rooftop Garden", "Grand Plaza"]
      }
    },
    {
      id: "apex",
      name: "Celebrity Apex",
      cruise_line_id: "line-celeb",
      ship_class: "Edge class",
      active: true,
      facilities: {
        exclusive_areas: [
          {
            name: "The Retreat",
            description: "Different Retreat copy on Apex."
          },
          {
            name: "Blu",
            description: "Exclusive restaurant for AquaClass guests."
          }
        ],
        specialty_features: ["Eden", "Grand Plaza", "Solarium"]
      }
    },
    {
      id: "ascent",
      name: "Celebrity Ascent",
      cruise_line_id: "line-celeb",
      ship_class: "Edge class",
      active: true,
      facilities: {
        exclusive_areas: [{ name: "The Retreat", description: "Suite enclave." }],
        specialty_features: ["Magic Carpet"]
      }
    },
    {
      id: "beyond",
      name: "Celebrity Beyond",
      cruise_line_id: "line-celeb",
      ship_class: "Edge class",
      active: true,
      facilities: {
        exclusive_areas: [],
        specialty_features: ["Eden"]
      }
    },
    {
      id: "xcel",
      name: "Celebrity Xcel",
      cruise_line_id: "line-celeb",
      ship_class: "Edge class",
      active: true,
      facilities: {
        exclusive_areas: [
          "The Retreat, legacy sundeck copy for suite guests."
        ],
        specialty_features: ["Magic Carpet", "Eden", "Rooftop Garden", "Grand Plaza"]
      }
    },
    {
      id: "millennium",
      name: "Celebrity Millennium",
      cruise_line_id: "line-celeb",
      ship_class: "Millennium class",
      active: true,
      facilities: {
        exclusive_areas: [{ name: "The Retreat", description: "Millennium Retreat." }],
        specialty_features: ["Solarium", "Tuscan Grille"]
      }
    },
    {
      id: "summit",
      name: "Celebrity Summit",
      cruise_line_id: "line-celeb",
      ship_class: "Millennium class",
      active: true,
      facilities: {
        exclusive_areas: [{ name: "Blu", description: "Summit Blu variant." }],
        specialty_features: ["Eden"]
      }
    },
    {
      id: "equinox",
      name: "Celebrity Equinox",
      cruise_line_id: "line-celeb",
      ship_class: "Solstice class",
      active: true,
      facilities: {
        exclusive_areas: [{ name: "Suite Class", description: "Legacy unrelated area." }],
        specialty_features: ["Pool", "Spa"]
      }
    }
  ]
};
