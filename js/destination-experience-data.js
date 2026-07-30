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
      bestMonths: bestMonths,
      shoulderMonths: shoulderMonths,
      eyebrow: options.eyebrow || (options.prefs && options.prefs.matchLabel) || "My top recommendation",
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

  function parseYmd(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    var parts = String(value).split("-").map(Number);
    var dt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (dt.getFullYear() !== parts[0] || dt.getMonth() !== parts[1] - 1 || dt.getDate() !== parts[2]) return null;
    return dt;
  }

  function clampMonth(value) {
    var m = Number(value);
    return m >= 1 && m <= 12 ? m : null;
  }

  function monthsInRange(startMonth, endMonth) {
    var start = clampMonth(startMonth);
    var end = clampMonth(endMonth);
    if (!start || !end) return [];
    var months = [];
    var cursor = start;
    for (var guard = 0; guard < 12; guard += 1) {
      months.push(cursor);
      if (cursor === end) break;
      cursor += 1;
      if (cursor > 12) cursor = 1;
    }
    return months;
  }

  function monthsCrossedByDates(startDate, endDate) {
    var start = parseYmd(startDate);
    var end = parseYmd(endDate) || start;
    if (!start || !end) return [];
    if (end < start) {
      var swap = start;
      start = end;
      end = swap;
    }
    var months = [];
    var cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    var last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      months.push(cursor.getMonth() + 1);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  }

  function seasonMonthsFromNow(referenceDate) {
    var now = referenceDate || new Date();
    var currentMonth = now.getMonth() + 1;
    var months = [];
    for (var i = 0; i < 4; i += 1) {
      var m = currentMonth + i;
      if (m > 12) m -= 12;
      months.push(m);
    }
    return months;
  }

  function formatMonthDay(date) {
    return date.getDate() + " " + MONTH_LONG[date.getMonth()];
  }

  function formatCruiseDateRange(startDate, endDate) {
    var start = parseYmd(startDate);
    var end = parseYmd(endDate) || start;
    if (!start) return "";
    if (!end || end.getTime() === start.getTime()) {
      return formatMonthDay(start) + " " + start.getFullYear();
    }
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
      return start.getDate() + "–" + end.getDate() + " " + MONTH_LONG[start.getMonth()] + " " + start.getFullYear();
    }
    if (start.getFullYear() === end.getFullYear()) {
      return formatMonthDay(start) + " – " + formatMonthDay(end) + " " + start.getFullYear();
    }
    return formatMonthDay(start) + " " + start.getFullYear() + " – " + formatMonthDay(end) + " " + end.getFullYear();
  }

  function monthStatesFor(months, bestMonths, shoulderMonths) {
    return asArray(months).map(function (month) {
      return monthState(month, bestMonths, shoulderMonths);
    });
  }

  function buildTimingVerdict(highlightedMonths, bestMonths, shoulderMonths, mode) {
    if (mode === "flexible") {
      return {
        status: "flexible",
        label: "FLEXIBLE TIMING",
        tone: "best",
        headline: "Flexible dates open several strong windows",
        detail:
          "With flexible timing you can lean into the destination’s preferred months rather than working around a fixed departure."
      };
    }

    var months = asArray(highlightedMonths)
      .map(Number)
      .filter(function (m) {
        return m >= 1 && m <= 12;
      });
    if (!months.length) return null;

    var states = monthStatesFor(months, bestMonths, shoulderMonths);
    var hasBest = states.indexOf("best") !== -1;
    var hasShoulder = states.indexOf("shoulder") !== -1;
    var hasNeutral = states.indexOf("neutral") !== -1;
    var allBest = states.every(function (state) {
      return state === "best";
    });
    var allShoulder = states.every(function (state) {
      return state === "shoulder";
    });
    var allNeutral = states.every(function (state) {
      return state === "neutral";
    });

    var label = "WELL SUITED";
    var tone = "best";
    if (allBest) {
      label = "EXCELLENT TIMING";
      tone = "best";
    } else if (allShoulder) {
      label = "SHOULDER-SEASON OPTION";
      tone = "shoulder";
    } else if (allNeutral) {
      label = "MORE VARIABLE CONDITIONS";
      tone = "neutral";
    } else if (hasNeutral) {
      label = "MORE VARIABLE CONDITIONS";
      tone = "neutral";
    } else if (hasShoulder && hasBest) {
      label = "WELL SUITED";
      tone = "shoulder";
    } else if (hasShoulder) {
      label = "SHOULDER-SEASON OPTION";
      tone = "shoulder";
    }

    var headline = "";
    if (months.length === 1) {
      headline =
        MONTH_LONG[months[0] - 1] +
        " is a " +
        (states[0] === "best" ? "preferred" : states[0] === "shoulder" ? "shoulder" : "more variable") +
        " month for this destination";
    } else if (allBest) {
      headline = "Your timing sits entirely within the preferred season";
    } else if (hasBest && (hasShoulder || hasNeutral)) {
      headline = "Your timing partly overlaps the preferred season";
    } else if (hasShoulder && !hasNeutral) {
      headline = "Your timing sits in shoulder-season months";
    } else {
      headline = "Your timing sits outside the preferred season";
    }

    return {
      status: label.toLowerCase().replace(/\s+/g, "_"),
      label: label,
      tone: tone,
      headline: headline,
      detail: buildVerdictDetail(months, states, bestMonths, shoulderMonths)
    };
  }

  function buildVerdictDetail(months, states, bestMonths, shoulderMonths) {
    var hasBest = states.indexOf("best") !== -1;
    var hasShoulder = states.indexOf("shoulder") !== -1;
    var hasNeutral = states.indexOf("neutral") !== -1;
    if (months.length === 1) {
      var month = months[0];
      var state = states[0];
      if (state === "best") {
        return (
          MONTH_LONG[month - 1] +
          " sits within the preferred window of " +
          formatPreferredWindow(bestMonths) +
          "."
        );
      }
      if (state === "shoulder") {
        return (
          MONTH_LONG[month - 1] +
          " is a shoulder month for this destination — still workable, with more humidity and shower risk than the preferred " +
          formatPreferredWindow(bestMonths) +
          " period."
        );
      }
      return (
        MONTH_LONG[month - 1] +
        " sits outside the preferred " +
        formatPreferredWindow(bestMonths) +
        " window, so conditions can feel more variable."
      );
    }
    if (hasBest && !hasShoulder && !hasNeutral) {
      return "Every month in your window aligns with the preferred season.";
    }
    if (hasBest && (hasShoulder || hasNeutral)) {
      return "Part of your window matches the preferred season, while other months sit in shoulder or more variable periods.";
    }
    if (hasShoulder && !hasNeutral) {
      return "Your window sits in shoulder-season months — workable, but with more humidity and shower risk than the preferred period.";
    }
    return "Your window sits outside the preferred season, so timing deserves closer planning attention.";
  }

  function formatPreferredWindow(bestMonths) {
    if (!bestMonths.length) return "peak";
    if (bestMonths.length >= 2) {
      return MONTH_LONG[bestMonths[0] - 1] + "–" + MONTH_LONG[bestMonths[bestMonths.length - 1] - 1];
    }
    return MONTH_LONG[bestMonths[0] - 1];
  }

  function buildSeasonPanelCopy(model, timing, monthNum) {
    var month = (model.months || []).find(function (row) {
      return row.month === Number(monthNum);
    });
    var seasonal = model.seasonSummary || {};
    var state = month ? month.state : monthState(monthNum, model.bestMonths || [], model.shoulderMonths || []);

    if (timing.mode === "cruise") {
      var sailingMonth = timing.departureMonth || monthNum;
      var monthName = MONTH_LONG[sailingMonth - 1];
      var preferred = seasonal.best || ("the preferred " + formatPreferredWindow(model.bestMonths || []) + " window");
      var body = "";
      if (state === "shoulder") {
        body =
          monthName +
          " is a shoulder month for the " +
          model.name +
          ". " +
          (seasonal.shoulder || month.recommendation || month.advantage || "");
        if (seasonal.best) body += " Preferred window: " + seasonal.best;
      } else if (state === "best") {
        body = seasonal.best || month.recommendation || month.advantage || "";
      } else {
        body =
          monthName +
          " sits outside the preferred season. " +
          (month.recommendation || seasonal.weatherCharacter || month.conditions || "");
      }
      return {
        kicker: "Your cruise timing",
        title: "You're sailing in " + monthName,
        datesLine: timing.dateLabel || "",
        body: body
      };
    }

    if (timing.mode === "flexible") {
      return {
        kicker: "Flexible timing",
        title: "Several strong months are open to you",
        datesLine: "",
        body:
          (seasonal.best ? "Preferred window: " + seasonal.best + " " : "") +
          "Flexibility lets you choose sailings within the destination’s strongest seasonal fit."
      };
    }

    if (timing.mode === "month" || timing.mode === "range" || timing.mode === "season") {
      return {
        kicker: "Your travel window",
        title:
          timing.mode === "month"
            ? "You're looking at " + MONTH_LONG[monthNum - 1]
            : timing.mode === "season"
              ? "You're planning within the next few months"
              : "You're looking across " + formatMonthRange(timing.highlightedMonths).replace(/ · /g, "–"),
        datesLine: "",
        body: month ? month.recommendation || month.advantage || month.conditions || "" : ""
      };
    }

    return {
      kicker: month ? month.long + " · " + (state === "best" ? "Best period" : state === "shoulder" ? "Shoulder season" : "Open period") : "",
      title: "",
      datesLine: "",
      body: month ? month.recommendation || month.advantage || month.conditions || "" : ""
    };
  }

  function parseTimingFromCruiseFinder(prefs, options) {
    options = options || {};
    prefs = prefs || {};
    var mode = String(prefs.timingMode || "").trim();

    if (!mode) {
      var general = parseTimingFromSearch("", options);
      general.source = "cruise_finder";
      return general;
    }

    if (mode === "exact" && prefs.startDate) {
      var startDate = String(prefs.startDate);
      var endDate = String(prefs.endDate || prefs.startDate);
      var crossed = monthsCrossedByDates(startDate, endDate);
      return {
        mode: "cruise",
        startDate: startDate,
        endDate: endDate,
        departureMonth: crossed[0] || null,
        highlightedMonths: crossed,
        activeMonth: crossed[0] || null,
        dateLabel: formatCruiseDateRange(startDate, endDate),
        allowManualSelection: false,
        source: "cruise_finder"
      };
    }

    if (mode === "month" && prefs.month) {
      var monthNum = clampMonth(prefs.month);
      return {
        mode: "month",
        month: monthNum,
        highlightedMonths: monthNum ? [monthNum] : [],
        activeMonth: monthNum,
        allowManualSelection: false,
        source: "cruise_finder"
      };
    }

    if (mode === "this_season") {
      var seasonMonths = seasonMonthsFromNow(options.referenceDate);
      return {
        mode: "season",
        highlightedMonths: seasonMonths,
        activeMonth: seasonMonths[0] || null,
        allowManualSelection: false,
        source: "cruise_finder"
      };
    }

    if (mode === "school_holidays") {
      var schoolMonths = [1, 4, 7, 9, 10, 12];
      return {
        mode: "range",
        startMonth: 1,
        endMonth: 12,
        highlightedMonths: schoolMonths,
        activeMonth: schoolMonths[0] || null,
        allowManualSelection: false,
        source: "cruise_finder"
      };
    }

    if (mode === "flexible") {
      return {
        mode: "flexible",
        highlightedMonths: [],
        activeMonth: null,
        allowManualSelection: false,
        source: "cruise_finder"
      };
    }

    var fallback = parseTimingFromSearch("", options);
    fallback.source = "cruise_finder";
    return fallback;
  }

  function parseTimingFromSearch(searchParams, options) {
    options = options || {};
    var params =
      searchParams && typeof searchParams.get === "function"
        ? searchParams
        : new URLSearchParams(searchParams || "");
    var mode = String(params.get("timing") || "").trim().toLowerCase();
    var start = String(params.get("start") || params.get("startDate") || "").trim();
    var end = String(params.get("end") || params.get("endDate") || "").trim();

    if (!mode && (start || end)) mode = "cruise";
    if (!mode) mode = "general";

    if (mode === "cruise") {
      var startDate = start;
      var endDate = end || startDate;
      var crossed = monthsCrossedByDates(startDate, endDate);
      return {
        mode: "cruise",
        startDate: startDate,
        endDate: endDate,
        departureMonth: crossed[0] || null,
        highlightedMonths: crossed,
        activeMonth: crossed[0] || null,
        dateLabel: formatCruiseDateRange(startDate, endDate),
        allowManualSelection: false
      };
    }

    if (mode === "month") {
      var month = clampMonth(params.get("month"));
      return {
        mode: "month",
        month: month,
        highlightedMonths: month ? [month] : [],
        activeMonth: month,
        allowManualSelection: false
      };
    }

    if (mode === "range") {
      var rangeMonths = monthsInRange(params.get("startMonth"), params.get("endMonth"));
      return {
        mode: "range",
        startMonth: clampMonth(params.get("startMonth")),
        endMonth: clampMonth(params.get("endMonth")),
        highlightedMonths: rangeMonths,
        activeMonth: rangeMonths[0] || null,
        allowManualSelection: false
      };
    }

    if (mode === "season") {
      var seasonMonths = seasonMonthsFromNow(options.referenceDate);
      return {
        mode: "season",
        highlightedMonths: seasonMonths,
        activeMonth: seasonMonths[0] || null,
        allowManualSelection: false
      };
    }

    if (mode === "flexible") {
      return {
        mode: "flexible",
        highlightedMonths: [],
        activeMonth: null,
        allowManualSelection: false
      };
    }

    return {
      mode: "general",
      highlightedMonths: [],
      activeMonth: null,
      allowManualSelection: true
    };
  }

  function buildSeasonTimeline(model, timingInput) {
    var timing = timingInput || { mode: "general", allowManualSelection: true };
    var bestMonths = asArray(model.bestMonths).map(Number);
    var shoulderMonths = asArray(model.shoulderMonths).map(Number);
    var highlightedMonths = asArray(timing.highlightedMonths).map(Number);
    var activeMonth =
      Number(timing.activeMonth) ||
      (timing.mode === "general" ? Number(model.defaultMonth) || bestMonths[0] || 1 : highlightedMonths[0]) ||
      bestMonths[0] ||
      1;

    if (timing.mode === "general") {
      highlightedMonths = bestMonths.slice();
    } else if (timing.mode === "flexible") {
      highlightedMonths = bestMonths.slice();
      activeMonth = bestMonths[0] || 1;
    }

    var verdict = buildTimingVerdict(highlightedMonths, bestMonths, shoulderMonths, timing.mode);
    var panel = buildSeasonPanelCopy(model, timing, activeMonth);
    var heading = "When should you cruise the " + (model.name || "destination") + "?";
    var kicker = "Season guide";

    if (timing.mode === "cruise") {
      kicker = "Season guide";
      heading = "How your timing fits the season";
    } else if (timing.mode === "month" || timing.mode === "range" || timing.mode === "season") {
      kicker = "Your travel timing";
      heading =
        timing.source === "cruise_finder" && timing.mode === "month"
          ? "How your timing fits the season"
          : panel.title || heading;
    } else if (timing.mode === "flexible") {
      kicker = "Flexible timing";
      heading =
        timing.source === "cruise_finder"
          ? "Your flexibility gives us several strong options"
          : "Preferred months for " + (model.name || "this destination");
    }

    return {
      mode: timing.mode,
      kicker: kicker,
      heading: heading,
      allowManualSelection: !!timing.allowManualSelection,
      highlightedMonths: highlightedMonths,
      activeMonth: activeMonth,
      verdict: verdict,
      panel: panel,
      dateLabel: timing.dateLabel || "",
      showLegend: true,
      showMonthTrack: true
    };
  }

  function applyTimingContext(model, timingInput) {
    if (!model) return model;
    var timing = timingInput || parseTimingFromSearch("");
    model.seasonTimeline = buildSeasonTimeline(model, timing);
    model.defaultMonth = model.seasonTimeline.activeMonth;
    return model;
  }

  function normaliseLineName(name) {
    return String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(cruises?|line|international|group|ltd|limited)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchPublicCruiseLine(seedName, publicLines) {
    var target = normaliseLineName(seedName);
    if (!target) return null;
    var exact = publicLines.find(function (row) {
      return normaliseLineName(row.name) === target;
    });
    if (exact) return exact;
    var contains = publicLines.filter(function (row) {
      var candidate = normaliseLineName(row.name);
      return candidate && (candidate.includes(target) || target.includes(candidate));
    });
    return contains.length === 1 ? contains[0] : null;
  }

  /**
   * Attach logos from public CI lines response without inventing notes.
   */
  function applyCruiseLineLogos(model, publicLines) {
    if (!model || !Array.isArray(model.cruiseLines) || !Array.isArray(publicLines)) return model;
    model.cruiseLines = model.cruiseLines.map(function (row) {
      var match = matchPublicCruiseLine(row.name, publicLines);
      return {
        name: row.name,
        logo: match && match.logo_url ? match.logo_url : row.logo || null,
        note: row.note || ""
      };
    });
    return model;
  }

  var MEDIA_ASSIGNMENT_ORDER = ["hero", "reason-1", "reason-2", "reason-3", "advice", "cta"];

  function applyMediaAssignments(model, assignmentResult) {
    if (!model || !assignmentResult || !assignmentResult.assignments) return model;
    var assignments = assignmentResult.assignments;
    var fallbackHero = model.hero;

    if (assignments.hero) {
      model.hero = assignments.hero;
    } else if (fallbackHero) {
      model.hero = fallbackHero;
    }

    model.reasons = asArray(model.reasons).map(function (reason, index) {
      var role = "reason-" + (index + 1);
      var image = assignments[role] || reason.image || model.hero;
      return Object.assign({}, reason, {
        image: image
          ? {
              url: image.url,
              alt: image.alt,
              objectPosition:
                image.objectPosition ||
                (reason.image && reason.image.objectPosition) ||
                "center center"
            }
          : null
      });
    });

    model.adviceImage = assignments.advice || model.hero;
    model.ctaImage = assignments.cta || assignments.advice || model.hero;

    var mediaUsed = [];
    MEDIA_ASSIGNMENT_ORDER.forEach(function (role) {
      var image = assignments[role];
      if (!image) return;
      mediaUsed.push({
        component: role,
        mediaId: image.mediaId || null,
        title: image.title || "",
        url: image.url,
        association: (model.name || "Destination") + " destination (Media Library)",
        note: image.source || ""
      });
    });
    if (mediaUsed.length) {
      model.mediaUsed = mediaUsed;
    }
    model.mediaSource = assignmentResult.usedFallback ? "cruise_finder_fallback" : "media_library_snapshot";
    return model;
  }

  root.DestinationExperienceData = {
    STYLE_LABELS: STYLE_LABELS,
    MONTH_SHORT: MONTH_SHORT,
    MONTH_LONG: MONTH_LONG,
    fromCruiseFinder: fromCruiseFinder,
    applyCruiseLineLogos: applyCruiseLineLogos,
    applyMediaAssignments: applyMediaAssignments,
    matchPublicCruiseLine: matchPublicCruiseLine,
    normaliseLineName: normaliseLineName,
    applyTimingContext: applyTimingContext,
    parseTimingFromSearch: parseTimingFromSearch,
    parseTimingFromCruiseFinder: parseTimingFromCruiseFinder,
    buildSeasonTimeline: buildSeasonTimeline,
    buildTimingVerdict: buildTimingVerdict,
    monthsCrossedByDates: monthsCrossedByDates,
    monthState: monthState,
    esc: esc
  };
})(typeof window !== "undefined" ? window : globalThis);
