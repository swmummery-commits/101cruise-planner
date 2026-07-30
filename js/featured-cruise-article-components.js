/**
 * Featured Cruise Article V2 renderer.
 * Browser global: FeaturedCruiseArticleComponents
 */
(function (root) {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function portInitial(name) {
    var trimmed = String(name || "").trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
  }

  function renderImage(image, className, loading) {
    if (!image || !image.url || image.loadState !== "loaded") return "";
    return `<img class="${esc(className)}" src="${esc(image.url)}" alt="${esc(image.alt || "")}" loading="${loading || "lazy"}" decoding="async">`;
  }

  function renderHero(model) {
    var heroImage =
      model.heroImage && model.heroImage.loadState === "loaded"
        ? `<div class="fca-hero-media" aria-hidden="true">${renderImage(model.heroImage, "fca-hero-img", "eager")}</div>`
        : "";
    var chips = (model.heroChips || [])
      .map(function (chip) {
        return `<li class="fca-chip">${esc(chip)}</li>`;
      })
      .join("");
    return `
      <section class="fca-hero" aria-labelledby="fca-hero-title">
        ${heroImage}
        <div class="fca-hero-overlay" aria-hidden="true"></div>
        <div class="fca-hero-copy">
          ${model.eyebrow ? `<p class="fca-eyebrow">${esc(model.eyebrow)}</p>` : ""}
          <h1 id="fca-hero-title" class="fca-hero-title">${esc(model.routeTitle || model.headline)}</h1>
          ${model.heroIntro ? `<p class="fca-hero-intro">${esc(model.heroIntro)}</p>` : ""}
          ${chips ? `<ul class="fca-chip-list">${chips}</ul>` : ""}
        </div>
      </section>`;
  }

  function renderSnapshot(model) {
    var items = model.snapshot || [];
    if (!items.length) return "";
    return `
      <section class="fca-section fca-snapshot" aria-label="Cruise snapshot">
        <div class="fca-snapshot-grid">
          ${items
            .map(function (item) {
              return `
            <article class="fca-snapshot-card">
              <p class="fca-snapshot-label">${esc(item.label)}</p>
              <p class="fca-snapshot-value">${esc(item.value)}</p>
            </article>`;
            })
            .join("")}
        </div>
      </section>`;
  }

  function renderEditorial(model) {
    var editorial = model.editorial || {};
    if (!editorial.excerpt && !(editorial.paragraphs || []).length) return "";
    var body = editorial.isLong
      ? `
        <div class="fca-editorial-excerpt">
          <p>${esc(editorial.excerpt)}</p>
        </div>
        <details class="fca-read-more">
          <summary>Read more</summary>
          <div class="fca-editorial-full">
            ${(editorial.paragraphs || [])
              .map(function (paragraph) {
                return `<p>${esc(paragraph)}</p>`;
              })
              .join("")}
          </div>
        </details>`
      : (editorial.paragraphs || [])
          .map(function (paragraph) {
            return `<p>${esc(paragraph)}</p>`;
          })
          .join("");
    return `
      <section class="fca-section fca-editorial" aria-labelledby="fca-editorial-heading">
        <h2 id="fca-editorial-heading" class="fca-section-title">Overview</h2>
        <div class="fca-editorial-body">${body}</div>
      </section>`;
  }

  function renderReasons(model) {
    var reasons = model.reasons || [];
    if (!reasons.length) return "";
    var heading =
      model.reasonCount === 1
        ? `<h2 class="fca-section-title">Why this sailing stands out</h2>`
        : model.reasonsHeading
          ? `<h2 class="fca-section-title">${esc(model.reasonsHeading)}</h2>`
          : "";
    return `
      <section class="fca-section fca-reasons" aria-label="Why this sailing">
        ${heading}
        <div class="fca-reason-list">
          ${reasons
            .map(function (reason) {
              var image =
                reason.image && reason.image.loadState === "loaded"
                  ? `<div class="fca-reason-media">${renderImage(reason.image, "fca-reason-img")}</div>`
                  : "";
              return `
            <article class="fca-reason-card">
              ${image}
              <div class="fca-reason-copy">
                <p class="fca-reason-label">${esc(reason.label)}</p>
                <h3 class="fca-reason-headline">${esc(reason.headline)}</h3>
                <p class="fca-reason-body">${esc(reason.body)}</p>
              </div>
            </article>`;
            })
            .join("")}
        </div>
      </section>`;
  }

  function renderRouteMap(model) {
    var map = model.routeMap;
    if (!map || !map.url || map.loadState !== "loaded") return "";
    return `
      <section class="fca-section fca-route-map-section" aria-labelledby="fca-route-map-heading">
        <h2 id="fca-route-map-heading" class="fca-section-title">Route map</h2>
        <figure class="fca-route-map">
          <img src="${esc(map.url)}" alt="${esc(map.alt || "Route map")}" loading="lazy" decoding="async">
        </figure>
      </section>`;
  }

  function renderItinerary(model) {
    var ports = model.ports || [];
    if (!ports.length) return "";
    return `
      <section class="fca-section fca-itinerary" aria-labelledby="fca-itinerary-heading">
        <h2 id="fca-itinerary-heading" class="fca-section-title">Itinerary</h2>
        <div class="fca-itinerary-grid">
          ${ports
            .map(function (port) {
              var day =
                port.day_number != null ? `<p class="fca-port-day">Day ${esc(port.day_number)}</p>` : "";
              if (port.is_sea_day) {
                return `
              <article class="fca-port-card fca-port-card--sea">
                <div class="fca-port-monogram" aria-hidden="true">~</div>
                ${day}
                <h3 class="fca-port-name">${esc(port.name)}</h3>
              </article>`;
              }
              if (port.image && port.image.loadState === "loaded") {
                return `
              <article class="fca-port-card fca-port-card--photo">
                <div class="fca-port-photo">${renderImage(port.image, "fca-port-img")}</div>
                ${day}
                <h3 class="fca-port-name">${esc(port.name)}</h3>
              </article>`;
              }
              return `
              <article class="fca-port-card fca-port-card--fallback">
                <div class="fca-port-monogram" aria-hidden="true">${esc(portInitial(port.name))}</div>
                ${day}
                <h3 class="fca-port-name">${esc(port.name)}</h3>
              </article>`;
            })
            .join("")}
        </div>
      </section>`;
  }

  function renderSeasonCallout(model) {
    var callout = model.seasonCallout;
    if (!callout || !callout.body) return "";
    return `
      <section class="fca-section fca-season" aria-labelledby="fca-season-heading">
        <h2 id="fca-season-heading" class="fca-section-title">${esc(callout.heading)}</h2>
        <p class="fca-season-body">${esc(callout.body)}</p>
      </section>`;
  }

  function renderShip(model) {
    var ship = model.ship;
    if (!ship) return "";
    var hero =
      ship.hero && ship.hero.loadState === "loaded"
        ? `<div class="fca-ship-media">${renderImage(ship.hero, "fca-ship-img")}</div>`
        : "";
    var categories = (ship.categories || [])
      .map(function (category, index) {
        var open = index === 0 ? " open" : "";
        return `
        <details class="fca-ship-panel"${open}>
          <summary>${esc(category.label)}</summary>
          <p>${esc(category.body)}</p>
        </details>`;
      })
      .join("");
    var facts = (ship.facts || [])
      .map(function (row) {
        return `<div class="fca-ship-fact"><span>${esc(row.label)}</span><strong>${esc(row.value)}</strong></div>`;
      })
      .join("");
    return `
      <section class="fca-section fca-ship" aria-labelledby="fca-ship-heading">
        <h2 id="fca-ship-heading" class="fca-section-title">Life on board ${esc(ship.name)}</h2>
        <div class="fca-ship-layout${hero ? "" : " fca-ship-layout--no-image"}">
          ${hero}
          <div class="fca-ship-copy">
            ${ship.overview ? `<p class="fca-ship-overview">${esc(ship.overview)}</p>` : ""}
            ${ship.personality ? `<p class="fca-ship-personality">${esc(ship.personality)}</p>` : ""}
            ${
              (ship.best_for || []).length
                ? `<div class="fca-ship-list-block"><h3>Best suited to</h3><ul>${ship.best_for
                    .map(function (item) {
                      return `<li>${esc(item)}</li>`;
                    })
                    .join("")}</ul></div>`
                : ""
            }
            ${
              (ship.not_ideal_for || []).length
                ? `<div class="fca-ship-list-block"><h3>May not suit travellers who…</h3><ul>${ship.not_ideal_for
                    .map(function (item) {
                      return `<li>${esc(item)}</li>`;
                    })
                    .join("")}</ul></div>`
                : ""
            }
          </div>
        </div>
        ${categories ? `<div class="fca-ship-panels">${categories}</div>` : ""}
        ${facts ? `<div class="fca-ship-facts"><h3>Ship at a glance</h3><div class="fca-ship-facts-grid">${facts}</div></div>` : ""}
      </section>`;
  }

  function renderPaulsTip(model) {
    var tip = CopySafe(model.paulsTip);
    if (!tip) return "";
    return `
      <section class="fca-section fca-tip" aria-labelledby="fca-tip-heading">
        <h2 id="fca-tip-heading" class="fca-section-title">Paul's tip</h2>
        <blockquote class="fca-tip-quote">${esc(tip)}</blockquote>
      </section>`;
  }

  function CopySafe(value) {
    return String(value || "").trim();
  }

  function renderCta(model) {
    var cta = model.cta || {};
    var image =
      model.ctaImage && model.ctaImage.loadState === "loaded"
        ? `<div class="fca-cta-media">${renderImage(model.ctaImage, "fca-cta-img")}</div>`
        : "";
    return `
      <section class="fca-section fca-cta" aria-labelledby="fca-cta-heading">
        ${image}
        <div class="fca-cta-copy">
          <h2 id="fca-cta-heading" class="fca-section-title">${esc(cta.headline || "Interested in this cruise?")}</h2>
          ${cta.body ? `<p class="fca-cta-body">${esc(cta.body)}</p>` : ""}
          <div class="fca-cta-actions">
            ${
              cta.primaryHref
                ? `<a class="fca-btn fca-btn-primary" href="${esc(cta.primaryHref)}">${esc(
                    cta.primaryLabel || "Enquire with Paul"
                  )}</a>`
                : ""
            }
            ${
              cta.secondaryHref
                ? `<a class="fca-btn fca-btn-secondary" href="${esc(cta.secondaryHref)}">${esc(
                    cta.secondaryLabel
                  )}</a>`
                : ""
            }
          </div>
        </div>
      </section>`;
  }

  function renderPage(model) {
    return `
      <article class="fca-article" data-fca-article="v2">
        ${renderHero(model)}
        ${renderSnapshot(model)}
        ${renderEditorial(model)}
        ${renderReasons(model)}
        ${renderRouteMap(model)}
        ${renderItinerary(model)}
        ${renderSeasonCallout(model)}
        ${renderShip(model)}
        ${renderPaulsTip(model)}
        ${renderCta(model)}
      </article>`;
  }

  root.FeaturedCruiseArticleComponents = {
    esc: esc,
    renderPage: renderPage
  };
})(typeof window !== "undefined" ? window : globalThis);
