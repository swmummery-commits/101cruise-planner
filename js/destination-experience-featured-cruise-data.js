/**
 * Featured Cruise → Destination Experience model mapping.
 * Browser global: DestinationExperienceFeaturedCruiseData
 */
(function (root) {
  "use strict";

  var Data = root.DestinationExperienceData;

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function formatDateAU(value) {
    if (!value) return "";
    var parts = String(value).split("-");
    if (parts.length !== 3) return String(value);
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    var monthIndex = Number(parts[1]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return String(value);
    return Number(parts[2]) + " " + months[monthIndex] + " " + parts[0];
  }

  function formatDateRange(start, end) {
    if (!start) return "";
    if (!end || end === start) return formatDateAU(start);
    return formatDateAU(start) + " – " + formatDateAU(end);
  }

  function imageFromMedia(media, fallbackAlt) {
    if (!media || !media.url) return null;
    return {
      url: media.url,
      alt: media.alt_text || fallbackAlt || "",
      title: media.title || fallbackAlt || "",
      objectPosition: "center center",
      loadState: "loaded"
    };
  }

  function pickHero(cruise) {
    var hero = imageFromMedia(cruise.hero, cruise.headline || "Cruise");
    if (hero) return hero;
    var destImages = asArray(cruise.media && cruise.media.destination_images);
    if (destImages[0]) return imageFromMedia(destImages[0], cruise.destination_region || "Destination");
    var shipHero = cruise.media && cruise.media.ship_hero;
    if (shipHero) return imageFromMedia(shipHero, cruise.ship_name || "Ship");
    var gallery = asArray(cruise.media && cruise.media.ship_gallery);
    if (gallery[0]) return imageFromMedia(gallery[0], cruise.ship_name || "Ship");
    return null;
  }

  function buildSnapshot(cruise) {
    var items = [];
    if (cruise.nights != null) {
      items.push({ id: "nights", label: "Nights", value: String(cruise.nights) });
    }
    if (cruise.departure_date) {
      items.push({
        id: "dates",
        label: "Sailing dates",
        value: formatDateRange(cruise.departure_date, cruise.return_date)
      });
    }
    if (cruise.ship_name) items.push({ id: "ship", label: "Ship", value: cruise.ship_name });
    if (cruise.cruise_line_name) {
      items.push({ id: "line", label: "Cruise line", value: cruise.cruise_line_name });
    }
    if (cruise.departure_port) {
      items.push({ id: "departure", label: "Departure", value: cruise.departure_port });
    }
    if (cruise.arrival_port) {
      items.push({ id: "arrival", label: "Arrival", value: cruise.arrival_port });
    }
    if (cruise.itinerary && cruise.itinerary.port_count) {
      items.push({
        id: "ports",
        label: "Ports",
        value: String(cruise.itinerary.port_count)
      });
    }
    if (cruise.destination_region) {
      items.push({ id: "region", label: "Region", value: cruise.destination_region });
    }
    return items;
  }

  function buildReasons(cruise, hero, destFull) {
    var reasons = [];
    var destImages = asArray(cruise.media && cruise.media.destination_images);
    var imageIndex = 0;

    function nextImage() {
      if (destImages[imageIndex]) {
        return imageFromMedia(destImages[imageIndex++], "Destination");
      }
      if (hero) return Object.assign({}, hero, { objectPosition: "center 40%" });
      return null;
    }

    asArray(destFull && destFull.why_visit).forEach(function (text, index) {
      if (reasons.length >= 3) return;
      reasons.push({
        id: "why-" + (index + 1),
        category: index === 0 ? "Destination" : index === 1 ? "Itinerary" : "Experience",
        headline: String(text).trim(),
        body: destFull.overview || cruise.short_editorial || "",
        image: nextImage()
      });
    });

    asArray(destFull && destFull.key_highlights).forEach(function (text, index) {
      if (reasons.length >= 3) return;
      if (
        reasons.some(function (row) {
          return row.headline === String(text).trim();
        })
      ) {
        return;
      }
      reasons.push({
        id: "highlight-" + (index + 1),
        category: "Highlight",
        headline: String(text).trim(),
        body: destFull.climate_summary || cruise.short_editorial || "",
        image: nextImage()
      });
    });

    if (reasons.length < 3 && cruise.short_editorial) {
      reasons.push({
        id: "editorial",
        category: "This sailing",
        headline: "A curated route with strong destination variety",
        body: cruise.short_editorial,
        image: nextImage()
      });
    }

    return reasons.slice(0, 3);
  }

  function buildStyles(destFull) {
    var labels = asArray(destFull && destFull.ideal_for);
    if (!labels.length) return [];
    return labels.slice(0, 5).map(function (label, index) {
      return {
        id: "style-" + index,
        label: String(label).trim(),
        support: destFull.overview || destFull.climate_summary || ""
      };
    });
  }

  function buildMonths(season) {
    if (!Data || !season || !asArray(season.best_months).length) return [];
    var bestMonths = asArray(season.best_months).map(Number);
    var shoulderMonths = [];
    var months = [];
    for (var i = 1; i <= 12; i += 1) {
      var state = Data.monthState(i, bestMonths, shoulderMonths);
      months.push({
        month: i,
        short: Data.MONTH_SHORT[i - 1],
        long: Data.MONTH_LONG[i - 1],
        state: state,
        conditions: season.climate_summary || "",
        demand: "",
        advantage: state === "best" ? season.best_time_to_visit || "" : "",
        consideration: "",
        recommendation: state === "best" ? season.best_time_to_visit || "" : season.climate_summary || ""
      });
    }
    return months;
  }

  function buildPorts(cruise) {
    return asArray(cruise.itinerary && cruise.itinerary.stops).map(function (stop) {
      return {
        name: stop.name,
        day_number: stop.day_number,
        is_sea_day: !!stop.is_sea_day,
        stop_type: stop.stop_type,
        image: stop.image
          ? {
              url: stop.image.url,
              alt: stop.image.alt_text || stop.name,
              objectPosition: "center center"
            }
          : null
      };
    });
  }

  function buildShipExperience(cruise) {
    var shipFull = cruise.research && cruise.research.ship_full;
    var shipTeaser = cruise.research && cruise.research.ship;
    var facts = cruise.research && cruise.research.ship_facts;
    if (!shipFull && !shipTeaser && !facts) return null;

    var hero =
      imageFromMedia(shipFull && shipFull.image, cruise.ship_name) ||
      imageFromMedia(cruise.media && cruise.media.ship_hero, cruise.ship_name) ||
      (asArray(cruise.media && cruise.media.ship_gallery)[0]
        ? imageFromMedia(cruise.media.ship_gallery[0], cruise.ship_name)
        : null);

    var categories = [];
    if (shipFull && shipFull.dining_summary) {
      categories.push({ id: "dining", label: "Dining", body: shipFull.dining_summary });
    }
    if (shipFull && shipFull.entertainment_summary) {
      categories.push({
        id: "entertainment",
        label: "Entertainment",
        body: shipFull.entertainment_summary
      });
    }
    if (shipFull && shipFull.wellness_summary) {
      categories.push({ id: "wellness", label: "Wellness", body: shipFull.wellness_summary });
    }
    if (shipFull && shipFull.family_summary) {
      categories.push({ id: "families", label: "Families", body: shipFull.family_summary });
    }
    if (shipFull && shipFull.accommodation_summary) {
      categories.push({
        id: "accommodation",
        label: "Accommodation",
        body: shipFull.accommodation_summary
      });
    }

    var standout = []
      .concat(asArray(facts && facts.speciality_features))
      .concat(asArray(facts && facts.exclusive_areas))
      .concat(asArray(shipFull && shipFull.key_highlights))
      .filter(Boolean)
      .slice(0, 8);

    var paulsTip =
      (shipFull && shipFull.pauls_tip) ||
      (shipTeaser && shipTeaser.pauls_tip) ||
      (cruise.research &&
        cruise.research.destination_full &&
        cruise.research.destination_full.pauls_tip) ||
      "";

    return {
      name: cruise.ship_name || (shipFull && shipFull.entity_name) || (shipTeaser && shipTeaser.entity_name) || "Ship",
      line: cruise.cruise_line_name || "",
      hero: hero,
      overview: (shipFull && shipFull.overview) || (shipTeaser && shipTeaser.overview) || "",
      personality: (shipFull && shipFull.personality) || (shipTeaser && shipTeaser.personality) || "",
      best_for: asArray(shipFull && shipFull.best_for).length
        ? shipFull.best_for
        : asArray(shipTeaser && shipTeaser.ideal_for),
      not_ideal_for: asArray(shipFull && shipFull.not_ideal_for),
      categories: categories,
      standout: standout,
      facts: facts,
      pauls_tip: String(paulsTip || "").trim(),
      gallery: asArray(cruise.media && cruise.media.ship_gallery).map(function (row) {
        return imageFromMedia(row, cruise.ship_name);
      })
    };
  }

  function buildSeasonSummary(destFull, season) {
    if (!destFull && !season) return null;
    return {
      bestWindow: (season && season.best_time_to_visit) || (destFull && destFull.best_time_to_visit) || "",
      shoulder: "",
      weatherCharacter: (destFull && destFull.climate_summary) || (season && season.climate_summary) || "",
      planningNote: ""
    };
  }

  function buildCta(cruise, options) {
    options = options || {};
    var mailto =
      root.NewsletterCruiseShared && root.NewsletterCruiseShared.buildEnquiryMailto
        ? root.NewsletterCruiseShared.buildEnquiryMailto(cruise)
        : "mailto:paul@101cruise.com.au";
    var secondaryHref = options.newsletterReturnUrl || null;
    return {
      headline: "Interested in this cruise?",
      body: "Tell Paul you're interested in this sailing and we'll follow up with current availability and options.",
      primaryLabel: "Enquire with Paul",
      primaryHref: mailto,
      secondaryLabel: secondaryHref ? "Return to Newsletter" : "",
      secondaryHref: secondaryHref || ""
    };
  }

  function parseTimingFromFeaturedCruise(cruise) {
    if (!Data) return { mode: "general", allowManualSelection: false };
    var startDate = String(cruise.departure_date || "").trim();
    var endDate = String(cruise.return_date || startDate).trim();
    if (!startDate) {
      return { mode: "general", allowManualSelection: false, source: "featured_cruise" };
    }
    var crossed = Data.monthsCrossedByDates(startDate, endDate);
    return {
      mode: "cruise",
      startDate: startDate,
      endDate: endDate,
      departureMonth: crossed[0] || null,
      highlightedMonths: crossed,
      activeMonth: crossed[0] || null,
      dateLabel: formatDateRange(startDate, endDate),
      allowManualSelection: false,
      source: "featured_cruise"
    };
  }

  function fromFeaturedCruise(cruise, options) {
    options = options || {};
    if (!cruise) return null;

    var destFull = cruise.research && cruise.research.destination_full;
    var season = cruise.research && cruise.research.destination_season;
    var hero = pickHero(cruise);
    var routeTitle =
      String(cruise.destination_strip || "").trim() ||
      [cruise.departure_port, cruise.arrival_port].filter(Boolean).join(" to ");

    var eyebrowParts = [];
    if (cruise.cruise_line_name) eyebrowParts.push(cruise.cruise_line_name);
    if (cruise.ship_name) eyebrowParts.push(cruise.ship_name);
    if (cruise.departure_date) {
      eyebrowParts.push(formatDateRange(cruise.departure_date, cruise.return_date));
    }
    if (cruise.nights != null) eyebrowParts.push(String(cruise.nights) + " nights");

    var tagline =
      (destFull && destFull.tagline) ||
      cruise.short_editorial ||
      (destFull && destFull.overview && String(destFull.overview).slice(0, 160)) ||
      "";

    var model = {
      mode: "featuredCruise",
      slug: cruise.public_slug || "",
      name: routeTitle,
      headline: cruise.headline || routeTitle,
      eyebrow: eyebrowParts.join(" · "),
      tagline: tagline,
      summary: destFull && destFull.overview ? destFull.overview : cruise.short_editorial || "",
      accent: "#8DD9BF",
      hero: hero,
      heroStyles: buildStyles(destFull)
        .slice(0, 4)
        .map(function (row) {
          return { id: row.id, label: row.label };
        }),
      snapshot: buildSnapshot(cruise),
      reasons: buildReasons(cruise, hero, destFull),
      styles: buildStyles(destFull),
      months: buildMonths(season),
      bestMonths: season ? asArray(season.best_months).map(Number) : [],
      shoulderMonths: [],
      defaultMonth: season && season.best_months && season.best_months[0] ? season.best_months[0] : null,
      ports: buildPorts(cruise),
      routeMap: imageFromMedia(cruise.route_map, "Route map"),
      ship: buildShipExperience(cruise),
      destinationPersonality: destFull && destFull.overview ? destFull.overview : "",
      seasonSummary: buildSeasonSummary(destFull, season),
      adviceImage: hero,
      ctaImage: hero,
      cta: buildCta(cruise, options),
      cruise: {
        public_slug: cruise.public_slug || "",
        departure_date: cruise.departure_date || "",
        return_date: cruise.return_date || "",
        nights: cruise.nights,
        departure_port: cruise.departure_port || "",
        arrival_port: cruise.arrival_port || "",
        cruise_line_name: cruise.cruise_line_name || "",
        ship_name: cruise.ship_name || "",
        newsletter_number: cruise.newsletter_number
      },
      source: "featured_cruise_public_api"
    };

    if (Data) {
      var timing = parseTimingFromFeaturedCruise(cruise);
      if (model.months.length) {
        model = Data.applyTimingContext(model, timing);
        if (model.seasonTimeline) {
          model.seasonTimeline.kicker = "Your cruise dates";
          model.seasonTimeline.heading = "How your sailing fits the season";
          model.seasonTimeline.allowManualSelection = false;
        }
      } else if (timing.mode === "cruise" && timing.dateLabel) {
        model.seasonTimeline = {
          mode: "cruise",
          kicker: "Your cruise dates",
          heading: "Your sailing dates",
          allowManualSelection: false,
          highlightedMonths: timing.highlightedMonths || [],
          activeMonth: timing.activeMonth,
          dateLabel: timing.dateLabel,
          showLegend: false,
          showMonthTrack: false,
          verdict: null,
          panel: {
            kicker: "Exact dates",
            title: timing.dateLabel,
            datesLine: "",
            body: cruise.short_editorial || ""
          }
        };
      }
    }

    return model;
  }

  root.DestinationExperienceFeaturedCruiseData = {
    fromFeaturedCruise: fromFeaturedCruise,
    parseTimingFromFeaturedCruise: parseTimingFromFeaturedCruise,
    formatDateRange: formatDateRange
  };
})(typeof window !== "undefined" ? window : globalThis);
