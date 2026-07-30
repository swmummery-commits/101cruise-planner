/**
 * Destination Experience — normalize catalogue data into a reusable page model.
 * Accepts Cruise Finder seed modules and optional Living Destination API DTO.
 * No destination-specific layout logic. No invented facts.
 *
 * Browser global: DestinationExperienceData
 */
(function (root) {
  "use strict";

  var MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var MONTH_LONG = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];

  var STYLE_LABELS = {
    beaches: "Beaches",
    relaxation: "Relaxation",
    adventure: "Adventure",
    wildlife: "Wildlife",
    culture: "Culture",
    luxury: "Luxury",
    expedition: "Expedition",
    food_wine: "Food & culture",
    scenic_cruising: "Scenic cruising",
    river_cruising: "River cruising",
    warm_weather: "Warm weather",
    cold_weather: "Cold weather",
    bucket_list: "Bucket list",
    family: "Families"
  };

  var STYLE_SUPPORT = {
    beaches: "Beach days and turquoise water sit at the heart of this destination.",
    warm_weather: "Warm-weather travellers will feel at home year-round.",
    relaxation: "The holiday rhythm asks very little of you — ease is the point.",
    family: "A strong fit for families looking for warm-weather island days.",
    adventure: "Island-hopping itineraries keep each day fresh without hard logistics.",
    luxury: "A wide choice of ship styles includes more polished and luxury-leaning options.",
    scenic_cruising: "Scenic passages and coastal views shape many itineraries.",
    wildlife: "Wildlife encounters feature where the destination supports them.",
    culture: "Shore days can lean into local food, towns and cultural stops.",
    food_wine: "Food and culture experiences appear where the destination supports them.",
    expedition: "Expedition-style sailings suit travellers seeking remoteness.",
    cold_weather: "Cooler climates and layered packing define the experience.",
    bucket_list: "A destination many travellers keep on a once-in-a-lifetime list.",
    river_cruising: "River itineraries favour towns, scenery and unhurried days."
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function asArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function monthState(month, bestMonths, shoulderMonths) {
    var m = Number(month);
    if (bestMonths.indexOf(m) !== -1) return "best";
    if (shoulderMonths.indexOf(m) !== -1) return "shoulder";
    return "neutral";
  }

  function formatMonthRange(months) {
    var list = asArray(months)
      .map(Number)
      .filter(function (n) {
        return n >= 1 && n <= 12;
      });
    if (!list.length) return "";
    return list
      .map(function (n) {
        return MONTH_LONG[n - 1];
      })
      .join(" · ");
  }

  function pickHero(dest, imagesApi, pickFn) {
    var slug = dest && dest.id;
    var entry = null;
    if (typeof pickFn === "function") {
      entry = pickFn(slug);
    } else if (imagesApi && imagesApi[slug] && imagesApi[slug].default) {
      entry = imagesApi[slug].default;
    }
    if (entry && entry.url) {
      return {
        url: entry.url,
        alt: (dest && dest.name ? dest.name + " destination" : "Destination") + " photography",
        objectPosition: entry.objectPosition || "center center",
        credit: entry.credit || "",
        source: "cruise_finder_destination_images",
        mediaId: null,
        title: slug ? slug + "-hero" : "destination-hero"
      };
    }
    return null;
  }

  /**
   * Build a destination-agnostic experience model from Cruise Finder seeds.
   */
  function fromCruiseFinder(slug, options) {
    options = options || {};
    var catalogue = options.catalogue || root.CruiseFinderDestinations || [];
    var contentMap = options.content || root.CruiseFinderDestinationContent || {};
    var imagesApi = options.images || root.CruiseFinderDestinationImages || null;
    var pickFn = options.pickImage || root.CruiseFinderPickDestinationImage || null;
    var filterLines =
      options.filterLines ||
      root.CruiseFinderFilterCruiseLines ||
      function (names) {
        return asArray(names);
      };

    var dest = catalogue.find(function (row) {
      return row && String(row.id) === String(slug);
    });
    if (!dest) return null;

    var content = contentMap[dest.id] || {};
    var bestMonths = asArray(dest.best_months).map(Number);
    var shoulderMonths = asArray(dest.acceptable_months).map(Number);
    var styles = asArray(dest.suitable_styles);
    var heroStyleOrder = ["beaches", "relaxation", "family", "warm_weather", "adventure", "luxury"];
    var orderedStyles = heroStyleOrder
      .filter(function (id) {
        return styles.indexOf(id) !== -1;
      })
      .concat(
        styles.filter(function (id) {
          return heroStyleOrder.indexOf(id) === -1;
        })
      );
    var reasons = asArray(content.key_reasons).slice(0, 3);
    var ports = asArray(content.popular_ports).map(function (name) {
      return {
        name: name,
        country: "",
        description: "",
        knownFor: "",
        image: null
      };
    });
    var lines = filterLines(asArray(dest.typical_cruise_lines)).map(function (name) {
      return { name: name, logo: null, note: "" };
    });
    var hero = pickHero(dest, imagesApi, pickFn);
    var seasonal = content.seasonal_advice || {};

    var snapshot = [];
    if (bestMonths.length) {
      snapshot.push({
        id: "best_months",
        label: "Best months",
        value: formatMonthRange(bestMonths).replace(/ · /g, "–") || formatMonthRange(bestMonths)
      });
    }
    if (dest.typical_nights_min != null && dest.typical_nights_max != null) {
      snapshot.push({
        id: "typical_length",
        label: "Typical length",
        value: dest.typical_nights_min + "–" + dest.typical_nights_max + " nights"
      });
    }
    if (dest.typical_weather) {
      snapshot.push({ id: "weather", label: "Weather", value: dest.typical_weather });
    }
    if (content.suited_to) {
      snapshot.push({ id: "best_for", label: "Best for", value: content.suited_to });
    }
    if (content.proximity) {
      snapshot.push({ id: "from_au", label: "From Australia", value: content.proximity });
    }
    if (asArray(content.departure_ports).length) {
      snapshot.push({
        id: "departures",
        label: "Common departures",
        value: asArray(content.departure_ports).join(" · ")
      });
    }

    // Prefer a readable best-months display: "December–April" when contiguous wrap.
    if (bestMonths.length >= 2) {
      var sorted = bestMonths.slice().sort(function (a, b) {
        return a - b;
      });
      // Caribbean-style wrap: Dec–Apr → keep first/last labels from stored order
      var first = bestMonths[0];
      var last = bestMonths[bestMonths.length - 1];
      snapshot = snapshot.map(function (item) {
        if (item.id !== "best_months") return item;
        return {
          id: item.id,
          label: item.label,
          value: MONTH_LONG[first - 1] + "–" + MONTH_LONG[last - 1]
        };
      });
    }

    var months = [];
    for (var i = 1; i <= 12; i += 1) {
      var state = monthState(i, bestMonths, shoulderMonths);
      var panel = {
        month: i,
        short: MONTH_SHORT[i - 1],
        long: MONTH_LONG[i - 1],
        state: state,
        conditions: dest.typical_weather || "",
        demand: "",
        advantage: "",
        consideration: "",
        recommendation: ""
      };
      if (state === "best" && seasonal.best) {
        panel.advantage = seasonal.best;
        panel.recommendation = seasonal.best;
      } else if (state === "shoulder" && seasonal.shoulder) {
        panel.advantage = seasonal.shoulder;
        panel.recommendation = seasonal.shoulder;
      } else {
        if (seasonal.weather) panel.conditions = seasonal.weather;
        if (seasonal.quieter) panel.consideration = seasonal.quieter;
        panel.recommendation = seasonal.weather || dest.typical_weather || "";
      }
      if (seasonal.weather && state !== "neutral") panel.conditions = seasonal.weather;
      months.push(panel);
    }

    var defaultMonth = bestMonths[0] || 1;

    return {
      slug: dest.id,
      name: dest.name,
      eyebrow: "My top recommendation",
      tagline: dest.hero_tagline || "",
      summary: dest.inspirational_description || "",
      accent: dest.accent || "#1a7a6d",
      hero: hero,
      heroStyles: orderedStyles
        .map(function (id) {
          return { id: id, label: STYLE_LABELS[id] || id };
        })
        .filter(function (row) {
          return row.label;
        }),
      snapshot: snapshot,
      reasons: reasons.map(function (text, index) {
        return {
          id: "reason-" + (index + 1),
          category: index === 0 ? "Water" : index === 1 ? "Itinerary" : "Pace",
          headline: text,
          body: dest.inspirational_description || content.suited_to || "",
          image: hero
            ? {
                url: hero.url,
                alt: hero.alt,
                objectPosition:
                  index === 0 ? "center 30%" : index === 1 ? "70% 55%" : "25% 70%"
              }
            : null
        };
      }),
      styles: styles.map(function (id) {
        return {
          id: id,
          label: STYLE_LABELS[id] || id,
          support: STYLE_SUPPORT[id] || content.suited_to || dest.inspirational_description || ""
        };
      }),
      months: months,
      defaultMonth: defaultMonth,
      ports: ports,
      cruiseLines: lines,
      seasonSummary: {
        bestWindow: seasonal.best || "",
        shoulder: seasonal.shoulder || "",
        weatherCharacter: seasonal.weather || dest.typical_weather || "",
        planningNote: seasonal.quieter || ""
      },
      cta: {
        headline: "Ready to find your " + dest.name + " cruise?",
        body: "Tell us when you want to travel and what kind of holiday you have in mind.",
        primaryLabel: "Find current cruises",
        primaryHref: buildFindCruisesHref(dest.id),
        secondaryLabel: "Back to Cruise Finder",
        secondaryHref: buildFinderHref()
      },
      gaps: buildGaps(dest, content, hero, ports, lines),
      source: "cruise_finder_seed",
      mediaUsed: hero
        ? [
            {
              component: "hero/reasons/season/cta",
              mediaId: null,
              title: hero.title,
              url: hero.url,
              association: dest.name + " destination hero (Cruise Finder asset)",
              note: "Living Destination Media Library record for this slug is not published in-repo."
            }
          ]
        : []
    };
  }

  function buildGaps(dest, content, hero, ports, lines) {
    var gaps = [];
    if (!hero) {
      gaps.push({
        component: "DestinationExperienceHero",
        field: "hero",
        issue: "No destination image available for this slug."
      });
    }
    gaps.push({
      component: "DestinationExperienceHero",
      field: "media_library",
      issue:
        "No published Living Destination / Media Library destination row for this slug in migrations; prototype uses Cruise Finder hero asset."
    });
    asArray(ports).forEach(function (port) {
      if (!port.image) {
        gaps.push({
          component: "DestinationPortCarousel",
          field: "port.image",
          issue: "No port-specific image for “" + port.name + "”; text-led card used."
        });
      }
      if (!port.description) {
        gaps.push({
          component: "DestinationPortCarousel",
          field: "port.description",
          issue: "No approved port description for “" + port.name + "”."
        });
      }
      if (!port.knownFor) {
        gaps.push({
          component: "DestinationPortCarousel",
          field: "port.knownFor",
          issue: "No structured “known for” phrase for “" + port.name + "”."
        });
      }
      if (!port.country) {
        gaps.push({
          component: "DestinationPortCarousel",
          field: "port.country",
          issue: "Country/region not present on Cruise Finder port name list."
        });
      }
    });
    asArray(lines).forEach(function (line) {
      if (!line.note) {
        gaps.push({
          component: "DestinationCruiseLines",
          field: "suitability_phrase",
          issue: "No per-line suitability phrase in seed data for “" + line.name + "”."
        });
      }
    });
    gaps.push({
      component: "DestinationSeasonTimeline",
      field: "month_metrics",
      issue: "No temperature, rainfall or hurricane statistics in structured data — not shown."
    });
    if (!content.seasonal_advice || !content.seasonal_advice.quieter) {
      /* quiet */
    } else {
      gaps.push({
        component: "DestinationSeasonTimeline",
        field: "caution_months",
        issue:
          "Quieter/caution copy exists as prose but does not name specific months; those months stay neutral."
      });
    }
    return gaps;
  }

  function buildFinderHref() {
    if (typeof location !== "undefined" && /101cruise\.com\.au$/i.test(location.hostname || "")) {
      return "https://www.101cruise.com.au/cruise-finder";
    }
    return "/cruise-finder";
  }

  function buildFindCruisesHref(slug) {
    return "/cruise-destination?destination=" + encodeURIComponent(slug || "");
  }

  /**
   * Attach logos from public CI lines response without inventing notes.
   */
  function applyCruiseLineLogos(model, publicLines) {
    if (!model || !Array.isArray(model.cruiseLines) || !Array.isArray(publicLines)) return model;
    var byName = Object.create(null);
    publicLines.forEach(function (line) {
      if (!line || !line.name) return;
      byName[String(line.name).toLowerCase()] = line;
    });
    model.cruiseLines = model.cruiseLines.map(function (row) {
      var match = byName[String(row.name || "").toLowerCase()];
      return {
        name: row.name,
        logo: match && match.logo_url ? match.logo_url : row.logo || null,
        note: row.note || ""
      };
    });
    return model;
  }

  root.DestinationExperienceData = {
    STYLE_LABELS: STYLE_LABELS,
    MONTH_SHORT: MONTH_SHORT,
    MONTH_LONG: MONTH_LONG,
    fromCruiseFinder: fromCruiseFinder,
    applyCruiseLineLogos: applyCruiseLineLogos,
    monthState: monthState,
    esc: esc
  };
})(typeof window !== "undefined" ? window : globalThis);
