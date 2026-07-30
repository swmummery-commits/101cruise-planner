/**
 * Featured Cruise sections for the shared Destination Experience.
 * Browser global: DestinationExperienceFeaturedCruiseComponents
 */
(function (root) {
  "use strict";

  var Base = root.DestinationExperienceComponents;

  function esc(value) {
    if (root.DestinationExperienceData && root.DestinationExperienceData.esc) {
      return root.DestinationExperienceData.esc(value);
    }
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function has(value) {
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return String(value).trim() !== "";
  }

  function renderImage(image, role) {
    if (Base && Base.renderDestinationImage) {
      return Base.renderDestinationImage(image, role);
    }
    if (!image || !image.url) return "";
    return `<img class="dx-dest-image" data-dx-dest-image="${esc(role)}" src="${esc(
      image.url
    )}" alt="" decoding="async">`;
  }

  function portInitial(name) {
    return String(name || "?")
      .trim()
      .charAt(0)
      .toUpperCase();
  }

  function renderReasonsFeatured(model) {
    var reasons = Array.isArray(model && model.reasons) ? model.reasons : [];
    if (!reasons.length) return "";
    return `
      <section class="dx-section dx-reasons-section" data-dx-section="reasons" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Why this cruise</p>
            <h2>Three reasons this sailing stands out</h2>
          </header>
          <div class="dx-reason-grid">
            ${reasons
              .map(function (reason, index) {
                var img = reason.image
                  ? `<div class="dx-reason-media">${renderImage(reason.image, "reason-" + (index + 1))}</div>`
                  : `<div class="dx-reason-media dx-reason-media--empty" aria-hidden="true"></div>`;
                return `
                <article class="dx-reason-card" data-dx-stagger="${index}">
                  ${img}
                  <div class="dx-reason-body">
                    ${has(reason.category) ? `<p class="dx-reason-cat">${esc(reason.category)}</p>` : ""}
                    <h3>${esc(reason.headline)}</h3>
                    ${has(reason.body) ? `<p>${esc(reason.body)}</p>` : ""}
                  </div>
                </article>`;
              })
              .join("")}
          </div>
        </div>
      </section>`;
  }

  function renderRouteMap(model) {
    var map = model && model.routeMap;
    if (!map || !map.url) return "";
    return `
      <section class="dx-section dx-fc-route-map-section" data-dx-section="route-map" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Your route</p>
            <h2>Route map</h2>
          </header>
          <figure class="dx-fc-route-map">
            <img src="${esc(map.url)}" alt="Route map for ${esc(model.name || "this cruise")}" loading="lazy" decoding="async">
          </figure>
        </div>
      </section>`;
  }

  function renderItineraryPorts(model) {
    var ports = Array.isArray(model && model.ports) ? model.ports : [];
    if (!ports.length) return "";
    return `
      <section class="dx-section dx-ports-section dx-fc-itinerary-section" data-dx-section="itinerary" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Itinerary</p>
            <h2>Every port on this sailing</h2>
          </header>
          <div class="dx-ports-grid dx-fc-itinerary-grid" role="list">
            ${ports
              .map(function (port) {
                var dayLabel =
                  port.day_number != null ? `<p class="dx-fc-port-day">Day ${esc(port.day_number)}</p>` : "";
                if (port.is_sea_day) {
                  return `
                <article class="dx-port-card dx-port-card--fallback dx-fc-port-sea" role="listitem">
                  <div class="dx-port-monogram" aria-hidden="true">~</div>
                  ${dayLabel}
                  <h3 class="dx-port-name">${esc(port.name)}</h3>
                </article>`;
                }
                if (port.image && port.image.url) {
                  return `
                <article class="dx-port-card dx-port-card--photo" role="listitem">
                  <div class="dx-port-photo" aria-hidden="true">
                    <img src="${esc(port.image.url)}" alt="" loading="lazy" decoding="async">
                  </div>
                  <div class="dx-port-photo-veil" aria-hidden="true"></div>
                  ${dayLabel}
                  <h3 class="dx-port-name">${esc(port.name)}</h3>
                </article>`;
                }
                return `
                <article class="dx-port-card dx-port-card--fallback" role="listitem">
                  <div class="dx-port-monogram" aria-hidden="true">${esc(portInitial(port.name))}</div>
                  ${dayLabel}
                  <h3 class="dx-port-name">${esc(port.name)}</h3>
                </article>`;
              })
              .join("")}
          </div>
        </div>
      </section>`;
  }

  function renderDestinationExperience(model) {
    var bits = [];
    if (has(model.destinationPersonality)) {
      bits.push(`
        <div class="dx-fc-dest-block" data-dx-reveal>
          <p class="dx-kicker">Destination personality</p>
          <h3>What you'll experience ashore</h3>
          <p>${esc(model.destinationPersonality)}</p>
        </div>`);
    }
    if (Base && Base.renderStyles && has(model.styles)) {
      bits.push(Base.renderStyles(model));
    }
    var summary = model.seasonSummary;
    if (
      summary &&
      (summary.weatherCharacter || summary.bestWindow) &&
      (!model.seasonTimeline || !model.seasonTimeline.verdict)
    ) {
      bits.push(Base.renderSeasonAdvice(model));
    } else if (summary && summary.weatherCharacter && model.seasonTimeline && model.seasonTimeline.verdict) {
      bits.push(`
        <section class="dx-section dx-advice-section dx-fc-advice-compact" data-dx-section="advice" data-dx-reveal>
          <div class="dx-wrap">
            <div class="dx-advice-copy">
              <p class="dx-kicker">Seasonal character</p>
              <h2>What to expect</h2>
              ${
                has(summary.weatherCharacter)
                  ? `<p class="dx-advice-value">${esc(summary.weatherCharacter)}</p>`
                  : ""
              }
            </div>
          </div>
        </section>`);
    }
    return bits.join("");
  }

  function renderFactCounter(label, value, suffix) {
    if (value == null || value === "") return "";
    var display = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    if (suffix && typeof value === "number") display = display + suffix;
    return `
      <article class="dx-fc-ship-fact" data-dx-reveal>
        <p class="dx-fc-ship-fact-value" data-dx-count="${esc(display)}">${esc(display)}</p>
        <p class="dx-fc-ship-fact-label">${esc(label)}</p>
      </article>`;
  }

  function renderShipFacts(facts) {
    if (!facts) return "";
    var items = [
      renderFactCounter("Guests", facts.guests),
      renderFactCounter("Crew", facts.crew),
      renderFactCounter("Decks", facts.decks),
      renderFactCounter("Staterooms", facts.staterooms),
      renderFactCounter("Length", facts.length_metres, "m"),
      renderFactCounter("Tonnage", facts.gross_tonnage),
      renderFactCounter("Built", facts.built),
      renderFactCounter("Refurbished", facts.refurbished),
      renderFactCounter("Restaurants", facts.restaurants),
      renderFactCounter("Bars", facts.bars),
      renderFactCounter("Pools", facts.pools),
      renderFactCounter("Hot tubs", facts.hot_tubs),
      renderFactCounter("Spa", facts.spa),
      renderFactCounter("Gym", facts.gym),
      renderFactCounter("Theatre", facts.theatre),
      renderFactCounter("Casino", facts.casino),
      renderFactCounter("Kids club", facts.kids_club)
    ].filter(Boolean);
    if (!items.length) return "";
    return `
      <div class="dx-fc-ship-facts-grid" role="list">
        ${items.join("")}
      </div>`;
  }

  function renderShipExperience(model) {
    var ship = model && model.ship;
    if (!ship) return "";
    var categories = Array.isArray(ship.categories) ? ship.categories : [];
    var firstCategory = categories[0] || null;

    return `
      <section class="dx-section dx-fc-ship-section" data-dx-section="ship" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Onboard experience</p>
            <h2>About ${esc(ship.name)}</h2>
            ${has(ship.line) ? `<p class="dx-section-sub">${esc(ship.line)}</p>` : ""}
          </header>
          <div class="dx-fc-ship-intro">
            ${
              ship.hero
                ? `<div class="dx-fc-ship-hero">${renderImage(ship.hero, "ship-hero")}</div>`
                : `<div class="dx-fc-ship-hero dx-fc-ship-hero--empty" aria-hidden="true"></div>`
            }
            <div class="dx-fc-ship-copy">
              ${has(ship.overview) ? `<p>${esc(ship.overview)}</p>` : ""}
              ${has(ship.personality) ? `<p class="dx-fc-ship-personality">${esc(ship.personality)}</p>` : ""}
            </div>
          </div>
          ${
            has(ship.best_for)
              ? `<div class="dx-fc-ship-best" data-dx-reveal>
            <h3>Best suited to</h3>
            <ul class="dx-fc-chip-list">${ship.best_for
              .map(function (item) {
                return `<li>${esc(item)}</li>`;
              })
              .join("")}</ul>
          </div>`
              : ""
          }
          ${
            has(ship.not_ideal_for)
              ? `<div class="dx-fc-ship-not-ideal" data-dx-reveal>
            <h3>May not suit travellers who…</h3>
            <ul class="dx-fc-chip-list dx-fc-chip-list--muted">${ship.not_ideal_for
              .map(function (item) {
                return `<li>${esc(item)}</li>`;
              })
              .join("")}</ul>
          </div>`
              : ""
          }
          ${
            categories.length
              ? `<div class="dx-fc-ship-tabs" data-dx-ship-tabs data-dx-reveal>
            <div class="dx-fc-ship-tablist" role="tablist" aria-label="Ship features">
              ${categories
                .map(function (cat, index) {
                  return `<button type="button" class="dx-fc-ship-tab${
                    index === 0 ? " is-active" : ""
                  }" role="tab" aria-selected="${index === 0 ? "true" : "false"}" data-dx-ship-tab="${esc(
                    cat.id
                  )}">${esc(cat.label)}</button>`;
                })
                .join("")}
            </div>
            <div class="dx-fc-ship-tabpanel" role="tabpanel" data-dx-ship-panel>
              ${firstCategory ? `<p>${esc(firstCategory.body)}</p>` : ""}
            </div>
          </div>`
              : ""
          }
          ${
            has(ship.standout)
              ? `<div class="dx-fc-ship-standout" data-dx-reveal>
            <h3>Standout onboard features</h3>
            <ul class="dx-fc-chip-list">${ship.standout
              .map(function (item) {
                return `<li>${esc(item)}</li>`;
              })
              .join("")}</ul>
          </div>`
              : ""
          }
          ${
            ship.facts
              ? `<div class="dx-fc-ship-glance" data-dx-reveal>
            <h3>Ship at a glance</h3>
            ${renderShipFacts(ship.facts)}
          </div>`
              : ""
          }
        </div>
      </section>`;
  }

  function renderPaulsTip(model) {
    var tip =
      (model.ship && model.ship.pauls_tip) ||
      (model.research && model.research && model.research.destination_full && model.research.destination_full.pauls_tip) ||
      "";
    if (!has(tip)) return "";
    return `
      <section class="dx-section dx-fc-paul-tip" data-dx-section="paul-tip" data-dx-reveal>
        <div class="dx-wrap">
          <blockquote class="dx-fc-paul-tip-inner">
            <p class="dx-kicker">Paul's tip</p>
            <p>${esc(tip)}</p>
          </blockquote>
        </div>
      </section>`;
  }

  function renderFeaturedCta(model) {
    if (Base && Base.renderCta) {
      var ctaModel = Object.assign({}, model, {
        cta: Object.assign({}, model.cta, {
          headline: model.cta && model.cta.headline ? model.cta.headline : "Interested in this cruise?"
        })
      });
      return Base.renderCta(ctaModel);
    }
    return "";
  }

  function renderFeaturedCruisePage(model) {
    if (!model) {
      return `<div class="dx-wrap dx-error"><p>This cruise experience is not available.</p></div>`;
    }
    var seasonSection =
      model.months && model.months.length && Base && Base.renderSeasonTimeline
        ? Base.renderSeasonTimeline(model)
        : "";

    return `
      <div class="dx-page dx-page--featured-cruise" data-dx-page data-dx-mode="featuredCruise" data-dx-slug="${esc(
        model.slug || ""
      )}">
        ${Base && Base.renderHero ? Base.renderHero(model) : ""}
        ${Base && Base.renderSnapshot ? Base.renderSnapshot(model) : ""}
        ${renderReasonsFeatured(model)}
        ${seasonSection}
        ${renderRouteMap(model)}
        ${renderItineraryPorts(model)}
        ${renderDestinationExperience(model)}
        ${renderShipExperience(model)}
        ${renderPaulsTip(model)}
        ${renderFeaturedCta(model)}
      </div>`;
  }

  root.DestinationExperienceFeaturedCruiseComponents = {
    renderFeaturedCruisePage: renderFeaturedCruisePage,
    renderRouteMap: renderRouteMap,
    renderItineraryPorts: renderItineraryPorts,
    renderShipExperience: renderShipExperience
  };
})(typeof window !== "undefined" ? window : globalThis);
