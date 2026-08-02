/**
 * Featured Cruise Article V2 model mapping.
 * Browser global: FeaturedCruiseArticleData
 */
(function (root) {
  "use strict";

  var Copy = root.FeaturedCruiseArticleCopy;

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function formatDateAU(value) {
    if (!value) return "";
    var parts = String(value).split("-");
    if (parts.length !== 3) return String(value);
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
      loadState: "pending"
    };
  }

  function pickHeroImage(cruise) {
    return (
      imageFromMedia(cruise.hero, cruise.headline || "Cruise") ||
      imageFromMedia(cruise.media && cruise.media.ship_hero, cruise.ship_name || "Ship") ||
      imageFromMedia(asArray(cruise.media && cruise.media.ship_gallery)[0], cruise.ship_name || "Ship") ||
      imageFromMedia(asArray(cruise.media && cruise.media.destination_images)[0], cruise.destination_region || "Destination")
    );
  }

  function buildSnapshot(cruise) {
    var items = [];
    if (cruise.nights != null) items.push({ id: "nights", label: "Nights", value: String(cruise.nights) });
    if (cruise.departure_date) {
      items.push({ id: "dates", label: "Sailing dates", value: formatDateRange(cruise.departure_date, cruise.return_date) });
    }
    if (cruise.ship_name) items.push({ id: "ship", label: "Ship", value: cruise.ship_name });
    if (cruise.cruise_line_name) items.push({ id: "line", label: "Cruise line", value: cruise.cruise_line_name });
    if (cruise.departure_port) items.push({ id: "departure", label: "Departure", value: cruise.departure_port });
    if (cruise.arrival_port) items.push({ id: "arrival", label: "Arrival", value: cruise.arrival_port });
    var portCount = cruise.itinerary && cruise.itinerary.port_count;
    if (portCount) items.push({ id: "ports", label: "Ports", value: String(portCount) });
    return items;
  }

  function buildStyles(destFull) {
    return asArray(destFull && destFull.ideal_for)
      .map(function (label) {
        return Copy.normalizeSpace(label);
      })
      .filter(Boolean)
      .slice(0, 4);
  }

  function buildReasons(cruise, registry) {
    var reasons = [];
    var destFull = cruise.research && cruise.research.destination_full;
    var shipFull = cruise.research && cruise.research.ship_full;
    var destImages = asArray(cruise.media && cruise.media.destination_images);
    var imageIndex = 0;

    function nextImage(alt) {
      while (imageIndex < destImages.length) {
        var row = destImages[imageIndex++];
        if (row && row.url) return imageFromMedia(row, alt || "Destination");
      }
      return null;
    }

    function pushReason(entry) {
      if (reasons.length >= 3) return;
      var body = Copy.capCompleteText(entry.body, Copy.REASON_BODY_MAX);
      if (!entry.headline || !body) return;
      if (!Copy.registerTextBlock(registry, body)) return;
      if (
        reasons.some(function (row) {
          return row.headline.toLowerCase() === entry.headline.toLowerCase();
        })
      ) {
        return;
      }
      reasons.push({
        id: entry.id,
        label: entry.label || "Highlight",
        headline: entry.headline,
        body: body,
        image: entry.image || null
      });
    }

    asArray(destFull && destFull.why_visit).forEach(function (text, index) {
      pushReason({
        id: "why-" + (index + 1),
        label: "Destination",
        headline: Copy.normalizeSpace(text),
        body: Copy.capCompleteText(text, Copy.REASON_BODY_MAX),
        image: nextImage("Destination")
      });
    });

    asArray(cruise.highlights || cruise.cruise_highlights).forEach(function (text, index) {
      pushReason({
        id: "cruise-highlight-" + (index + 1),
        label: "This sailing",
        headline: Copy.normalizeSpace(typeof text === "string" ? text : text.headline || text.title || ""),
        body: Copy.capCompleteText(typeof text === "string" ? text : text.body || text.description || text.headline || "", Copy.REASON_BODY_MAX),
        image: nextImage("Cruise highlight")
      });
    });

    asArray(shipFull && shipFull.key_highlights).forEach(function (text, index) {
      pushReason({
        id: "ship-highlight-" + (index + 1),
        label: "On board",
        headline: Copy.normalizeSpace(text),
        body: Copy.capCompleteText(shipFull.overview || text, Copy.REASON_BODY_MAX),
        image: imageFromMedia(cruise.media && cruise.media.ship_hero, cruise.ship_name || "Ship")
      });
    });

    var stops = asArray(cruise.itinerary && cruise.itinerary.stops).filter(function (stop) {
      return stop && !stop.is_sea_day;
    });
    if (reasons.length < 3 && stops.length >= 4) {
      var names = stops
        .slice(0, 4)
        .map(function (stop) {
          return Copy.normalizeSpace(stop.name);
        })
        .filter(Boolean);
      if (names.length >= 3) {
        pushReason({
          id: "itinerary-variety",
          label: "Itinerary",
          headline: "A varied port sequence",
          body: "This sailing calls at " + names.slice(0, 4).join(", ") + ".",
          image: nextImage("Itinerary")
        });
      }
    }

    return reasons.slice(0, 3);
  }

  function buildPorts(cruise) {
    return asArray(cruise.itinerary && cruise.itinerary.stops).map(function (stop) {
      return {
        name: stop.name,
        day_number: stop.day_number,
        is_sea_day: !!stop.is_sea_day,
        image: stop.image && stop.image.url
          ? { url: stop.image.url, alt: stop.image.alt_text || stop.name, loadState: "pending" }
          : null
      };
    });
  }

  function buildShipFacts(facts) {
    if (!facts) return [];
    var rows = [];
    function push(label, value) {
      if (value == null || value === "") return;
      rows.push({ label: label, value: String(value) });
    }
    push("Guests", facts.guests);
    push("Crew", facts.crew);
    push("Decks", facts.decks);
    push("Staterooms", facts.staterooms);
    push("Length", facts.length_m ? facts.length_m + " m" : facts.length_ft ? facts.length_ft + " ft" : "");
    push("Tonnage", facts.tonnage);
    push("Built", facts.year_built);
    push("Refurbished", facts.year_refurbished);
    push("Restaurants", facts.restaurants);
    push("Bars", facts.bars);
    push("Pools", facts.pools);
    push("Spa", facts.spa ? "Yes" : facts.spa === false ? "" : facts.spa);
    asArray(facts.speciality_features)
      .concat(asArray(facts.exclusive_areas))
      .slice(0, 4)
      .forEach(function (item, index) {
        push(index === 0 ? "Standout" : "Feature", item);
      });
    return rows.slice(0, 10);
  }

  function buildShip(cruise) {
    var shipFull = cruise.research && cruise.research.ship_full;
    var shipTeaser = cruise.research && cruise.research.ship;
    var facts = cruise.research && cruise.research.ship_facts;
    if (!shipFull && !shipTeaser && !facts) return null;

    var categories = [];
    function addCategory(id, label, body) {
      var text = Copy.normalizeSpace(body);
      if (!text) return;
      categories.push({ id: id, label: label, body: Copy.capCompleteText(text, 900) });
    }
    if (shipFull) {
      addCategory("dining", "Dining", shipFull.dining_summary);
      addCategory("entertainment", "Entertainment", shipFull.entertainment_summary);
      addCategory("wellness", "Wellness", shipFull.wellness_summary);
      addCategory("families", "Families", shipFull.family_summary);
      addCategory("accommodation", "Accommodation", shipFull.accommodation_summary);
    }

    var paulsTip = Copy.normalizeSpace(
      (shipFull && shipFull.pauls_tip) ||
        (shipTeaser && shipTeaser.pauls_tip) ||
        (cruise.research && cruise.research.destination_full && cruise.research.destination_full.pauls_tip) ||
        ""
    );

    return {
      name: cruise.ship_name || (shipFull && shipFull.entity_name) || "Ship",
      line: cruise.cruise_line_name || "",
      hero: null,
      mode: shipFull ? "full" : "facts",
      overview: Copy.capCompleteText((shipFull && shipFull.overview) || (shipTeaser && shipTeaser.overview) || "", 900),
      personality: Copy.capCompleteText((shipFull && shipFull.personality) || (shipTeaser && shipTeaser.personality) || "", 420),
      best_for: asArray(shipFull && shipFull.best_for).length ? shipFull.best_for : asArray(shipTeaser && shipTeaser.ideal_for),
      not_ideal_for: asArray(shipFull && shipFull.not_ideal_for),
      categories: categories,
      facts: buildShipFacts(facts),
      pauls_tip: paulsTip
    };
  }

  function buildSeasonCallout(cruise) {
    var destFull = cruise.research && cruise.research.destination_full;
    var season = cruise.research && cruise.research.destination_season;
    if (!destFull && !season) return null;
    var body = Copy.normalizeSpace(
      (season && season.best_time_to_visit) ||
        (destFull && destFull.best_time_to_visit) ||
        (destFull && destFull.climate_summary) ||
        ""
    );
    if (!body) return null;
    return {
      heading: "Season at a glance",
      body: Copy.capCompleteText(body, 420)
    };
  }

  function buildCta(cruise, options) {
    options = options || {};
    var mailto =
      root.NewsletterCruiseShared && root.NewsletterCruiseShared.buildEnquiryMailto
        ? root.NewsletterCruiseShared.buildEnquiryMailto(cruise)
        : "mailto:paul@101cruise.com.au";
    var returnUrl = options.newsletterReturnUrl || null;
    return {
      headline: "Interested in this cruise?",
      body: "Tell Paul you're interested in this sailing and we'll follow up with current availability and options.",
      primaryLabel: "Enquire with Paul",
      primaryHref: mailto,
      secondaryLabel: returnUrl ? "Return to Newsletter" : "",
      secondaryHref: returnUrl || ""
    };
  }

  function fromFeaturedCruise(cruise, options) {
    if (!cruise || !Copy) return null;
    options = options || {};

    var registry = Object.create(null);
    var destFull = cruise.research && cruise.research.destination_full;
    var routeTitle =
      Copy.normalizeSpace(cruise.destination_strip) ||
      [cruise.departure_port, cruise.arrival_port].filter(Boolean).join(" to ");

    var eyebrowParts = [];
    if (cruise.cruise_line_name) eyebrowParts.push(cruise.cruise_line_name);
    if (cruise.ship_name) eyebrowParts.push(cruise.ship_name);
    if (cruise.departure_date) eyebrowParts.push(formatDateRange(cruise.departure_date, cruise.return_date));
    if (cruise.nights != null) eyebrowParts.push(String(cruise.nights) + " nights");

    var editorial = Copy.buildEditorialBlocks(cruise);
    var heroIntro = Copy.buildHeroIntro(cruise);
    if (heroIntro && editorial.paragraphs.length) {
      var firstParagraph = editorial.paragraphs[0];
      var firstSentence = Copy.firstCompleteSentence(firstParagraph, Copy.HERO_INTRO_MAX);
      if (firstSentence && firstSentence === heroIntro) {
        var remainder = Copy.normalizeSpace(firstParagraph.slice(firstSentence.length));
        if (remainder) editorial.paragraphs[0] = remainder;
        else editorial.paragraphs.shift();
        editorial.excerpt = editorial.paragraphs.join("\n\n");
        editorial.isLong = editorial.excerpt.length > Copy.EDITORIAL_EXCERPT_MAX;
      }
    }
    if (heroIntro) Copy.registerTextBlock(registry, heroIntro);
    editorial.paragraphs.forEach(function (paragraph) {
      Copy.registerTextBlock(registry, paragraph);
    });

    var reasons = buildReasons(cruise, registry);
    var reasonCount = reasons.length;

    return {
      mode: "featuredCruiseArticleV2",
      slug: cruise.public_slug || "",
      routeTitle: routeTitle,
      headline: Copy.normalizeSpace(cruise.headline) || routeTitle,
      eyebrow: eyebrowParts.join(" · "),
      heroIntro: heroIntro,
      heroImage: pickHeroImage(cruise),
      heroChips: buildStyles(destFull),
      snapshot: buildSnapshot(cruise),
      editorial: editorial,
      reasons: reasons,
      reasonsHeading: Copy.reasonsHeading(reasonCount),
      reasonCount: reasonCount,
      routeMap: imageFromMedia(cruise.route_map, "Route map for " + (routeTitle || "this cruise")),
      ports: buildPorts(cruise),
      seasonCallout: buildSeasonCallout(cruise),
      shipName: Copy.normalizeSpace(cruise.ship_name) || "",
      ciShipEligible: Boolean(String(cruise.ship_name || "").trim()),
      paulsTip:
        Copy.normalizeSpace(
          (cruise.research && cruise.research.ship_full && cruise.research.ship_full.pauls_tip) ||
            (cruise.research && cruise.research.ship && cruise.research.ship.pauls_tip) ||
            (destFull && destFull.pauls_tip) ||
            ""
        ) || "",
      cta: buildCta(cruise, options),
      ctaImage: pickHeroImage(cruise),
      cruise: {
        public_slug: cruise.public_slug || "",
        newsletter_number: cruise.newsletter_number
      }
    };
  }

  root.FeaturedCruiseArticleData = {
    fromFeaturedCruise: fromFeaturedCruise,
    formatDateRange: formatDateRange
  };
})(typeof window !== "undefined" ? window : globalThis);
