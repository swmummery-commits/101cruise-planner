/**
 * Destination Experience — reusable section renderers.
 * Components accept a generic destination model (no Caribbean hard-coding).
 *
 * Browser global: DestinationExperienceComponents
 */
(function (root) {
  "use strict";

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

  function renderHero(model) {
    if (!model) return "";
    var hero = model.hero;
    var styles = Array.isArray(model.heroStyles) ? model.heroStyles.slice(0, 4) : [];
    var media = hero
      ? `<div class="dx-hero-media" aria-hidden="true">
          <img src="${esc(hero.url)}" alt="" style="object-position:${esc(hero.objectPosition || "center center")}" decoding="async" fetchpriority="high">
        </div>`
      : `<div class="dx-hero-media dx-hero-media--empty" aria-hidden="true"></div>`;

    return `
      <section class="dx-hero" data-dx-section="hero">
        ${media}
        <div class="dx-hero-veil" aria-hidden="true"></div>
        <div class="dx-wrap dx-hero-copy">
          ${has(model.eyebrow) ? `<p class="dx-hero-eyebrow">${esc(model.eyebrow)}</p>` : ""}
          <h1 class="dx-hero-title">${esc(model.name || "")}</h1>
          ${has(model.tagline) ? `<p class="dx-hero-tagline">${esc(model.tagline)}</p>` : ""}
          ${
            styles.length
              ? `<ul class="dx-hero-styles">${styles
                  .map(function (s) {
                    return `<li>${esc(s.label)}</li>`;
                  })
                  .join("")}</ul>`
              : ""
          }
        </div>
      </section>`;
  }

  function renderSnapshot(model) {
    var items = Array.isArray(model && model.snapshot) ? model.snapshot : [];
    if (!items.length) return "";
    return `
      <section class="dx-section dx-snapshot-section" data-dx-section="snapshot" data-dx-reveal>
        <div class="dx-wrap">
          <div class="dx-snapshot" role="list">
            ${items
              .map(function (item) {
                return `
                <article class="dx-snapshot-card" role="listitem" data-snap="${esc(item.id || "")}">
                  <p class="dx-snapshot-label">${esc(item.label)}</p>
                  <p class="dx-snapshot-value">${esc(item.value)}</p>
                </article>`;
              })
              .join("")}
          </div>
        </div>
      </section>`;
  }

  function renderReasons(model) {
    var reasons = Array.isArray(model && model.reasons) ? model.reasons : [];
    if (!reasons.length) return "";
    return `
      <section class="dx-section dx-reasons-section" data-dx-section="reasons" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Why cruise here</p>
            <h2>Three reasons this destination works</h2>
          </header>
          <div class="dx-reason-grid">
            ${reasons
              .map(function (reason, index) {
                var img = reason.image
                  ? `<div class="dx-reason-media"><img src="${esc(reason.image.url)}" alt="" style="object-position:${esc(
                      reason.image.objectPosition || "center center"
                    )}" loading="lazy" decoding="async"></div>`
                  : `<div class="dx-reason-media dx-reason-media--empty" aria-hidden="true"></div>`;
                return `
                <article class="dx-reason-card" data-dx-stagger="${index}">
                  ${img}
                  <div class="dx-reason-body">
                    ${has(reason.category) ? `<p class="dx-reason-cat">${esc(reason.category)}</p>` : ""}
                    <h3>${esc(reason.headline)}</h3>
                    ${has(reason.body) ? `<p>${esc(reason.body)}</p>` : ""}
                    <span class="dx-reason-cue" aria-hidden="true">→</span>
                  </div>
                </article>`;
              })
              .join("")}
          </div>
        </div>
      </section>`;
  }

  function renderStyles(model) {
    var styles = Array.isArray(model && model.styles) ? model.styles : [];
    if (!styles.length) return "";
    var first = styles[0];
    return `
      <section class="dx-section dx-styles-section" data-dx-section="styles" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Destination personality</p>
            <h2>What kind of holiday is this?</h2>
          </header>
          <div class="dx-style-tiles" role="tablist" aria-label="Holiday styles">
            ${styles
              .map(function (style, index) {
                var selected = index === 0 ? "true" : "false";
                return `<button type="button" class="dx-style-tile${index === 0 ? " is-active" : ""}" role="tab" aria-selected="${selected}" data-dx-style="${esc(
                  style.id
                )}">${esc(style.label)}</button>`;
              })
              .join("")}
          </div>
          <div class="dx-style-panel" role="tabpanel" data-dx-style-panel>
            <p>${esc(first && first.support ? first.support : "")}</p>
          </div>
        </div>
      </section>`;
  }

  function renderTimingVerdict(timeline) {
    if (!timeline || !timeline.verdict) return "";
    var verdict = timeline.verdict;
    return `
      <div class="dx-timing-verdict tone-${esc(verdict.tone || "neutral")}" data-dx-timing-verdict>
        <p class="dx-timing-verdict-label">${esc(verdict.label || "")}</p>
        <h3 class="dx-timing-verdict-headline">${esc(verdict.headline || "")}</h3>
        ${has(verdict.detail) ? `<p class="dx-timing-verdict-detail">${esc(verdict.detail)}</p>` : ""}
      </div>`;
  }

  function renderSeasonTimeline(model) {
    var months = Array.isArray(model && model.months) ? model.months : [];
    if (!months.length) return "";
    var timeline = model.seasonTimeline || {
      mode: "general",
      kicker: "Season guide",
      heading: "Pick a month",
      allowManualSelection: true,
      highlightedMonths: [],
      activeMonth: Number(model.defaultMonth) || months[0].month,
      panel: null,
      showLegend: true
    };
    var selected = Number(timeline.activeMonth) || months[0].month;
    var highlighted = Array.isArray(timeline.highlightedMonths) ? timeline.highlightedMonths : [];
    var active = months.find(function (m) {
      return m.month === selected;
    }) || months[0];
    var panel = timeline.panel || null;
    var manualHint = timeline.allowManualSelection
      ? `<p class="dx-season-hint">Select a month to see how it fits this destination.</p>`
      : "";

    return `
      <section class="dx-section dx-season-section" data-dx-section="season" data-dx-reveal data-dx-season-mode="${esc(
        timeline.mode || "general"
      )}">
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">${esc(timeline.kicker || "Season guide")}</p>
            <h2>${esc(timeline.heading || "Pick a month")}</h2>
          </header>
          ${renderTimingVerdict(timeline)}
          <div class="dx-month-track${
            timeline.allowManualSelection ? "" : " is-readonly"
          }" role="${timeline.allowManualSelection ? "listbox" : "group"}" aria-label="Travel months" data-dx-month-track${
            timeline.allowManualSelection ? "" : ' aria-readonly="true"'
          }>
            ${months
              .map(function (m) {
                var isActive = m.month === selected;
                var isHighlighted = highlighted.indexOf(m.month) !== -1;
                return `<button type="button" class="dx-month-chip state-${esc(m.state)}${
                  isActive ? " is-active" : ""
                }${isHighlighted ? " is-highlighted" : ""}" role="${
                  timeline.allowManualSelection ? "option" : "presentation"
                }" aria-selected="${isActive ? "true" : "false"}" data-dx-month="${m.month}"${
                  timeline.allowManualSelection ? "" : " tabindex=\"-1\""
                }>
                  <span class="dx-month-short">${esc(m.short)}</span>
                  <span class="dx-month-state" aria-hidden="true"></span>
                </button>`;
              })
              .join("")}
          </div>
          ${
            timeline.showLegend
              ? `<div class="dx-month-legend" aria-hidden="true">
            <span><i class="dx-dot best"></i> Best</span>
            <span><i class="dx-dot shoulder"></i> Shoulder</span>
            <span><i class="dx-dot neutral"></i> Neutral</span>
          </div>`
              : ""
          }
          ${manualHint}
          <article class="dx-month-panel" data-dx-month-panel>
            ${panel ? renderContextMonthPanel(panel, active) : renderMonthPanel(active)}
          </article>
        </div>
      </section>`;
  }

  function renderContextMonthPanel(panel, month) {
    if (!panel && month) return renderMonthPanel(month);
    panel = panel || {};
    var bits = [];
    if (has(panel.kicker)) bits.push(`<p class="dx-month-panel-kicker">${esc(panel.kicker)}</p>`);
    if (has(panel.title)) bits.push(`<h3 class="dx-month-panel-title">${esc(panel.title)}</h3>`);
    if (has(panel.datesLine)) bits.push(`<p class="dx-month-panel-dates">${esc(panel.datesLine)}</p>`);
    if (has(panel.body)) bits.push(`<p class="dx-month-rec">${esc(panel.body)}</p>`);
    if (!bits.length && month) return renderMonthPanel(month);
    return bits.join("");
  }

  function renderMonthPanel(month) {
    if (!month) return "";
    return `
      <p class="dx-month-panel-kicker">${esc(month.long)} · ${esc(month.state === "best" ? "Best period" : month.state === "shoulder" ? "Shoulder season" : "Open period")}</p>
      ${has(month.conditions) ? `<p><strong>Typical conditions</strong> ${esc(month.conditions)}</p>` : ""}
      ${has(month.advantage) ? `<p><strong>Seasonal advantage</strong> ${esc(month.advantage)}</p>` : ""}
      ${has(month.consideration) ? `<p><strong>Planning note</strong> ${esc(month.consideration)}</p>` : ""}
      ${has(month.recommendation) ? `<p class="dx-month-rec">${esc(month.recommendation)}</p>` : ""}
    `;
  }

  function renderPorts(model) {
    var ports = Array.isArray(model && model.ports) ? model.ports : [];
    if (!ports.length) return "";
    return `
      <section class="dx-section dx-ports-section" data-dx-section="ports" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head dx-section-head-row">
            <div>
              <p class="dx-kicker">Port discovery</p>
              <h2>Popular ports</h2>
            </div>
            <div class="dx-carousel-nav">
              <button type="button" class="dx-carousel-btn" data-dx-ports-prev aria-label="Previous ports">‹</button>
              <button type="button" class="dx-carousel-btn" data-dx-ports-next aria-label="Next ports">›</button>
            </div>
          </header>
          <div class="dx-ports-viewport">
            <div class="dx-ports-track" data-dx-ports-track tabindex="0" aria-label="Port cards">
              ${ports
                .map(function (port) {
                  var media = port.image
                    ? `<div class="dx-port-media"><img src="${esc(port.image.url)}" alt="${esc(
                        port.image.alt || port.name
                      )}" loading="lazy" decoding="async"></div>`
                    : `<div class="dx-port-media dx-port-media--text" aria-hidden="true"><span>${esc(
                        (port.name || "?").slice(0, 1)
                      )}</span></div>`;
                  return `
                  <article class="dx-port-card">
                    ${media}
                    <div class="dx-port-body">
                      <h3>${esc(port.name)}</h3>
                      ${has(port.country) ? `<p class="dx-port-meta">${esc(port.country)}</p>` : ""}
                      ${has(port.description) ? `<p>${esc(port.description)}</p>` : ""}
                      ${has(port.knownFor) ? `<p class="dx-port-known"><span>Known for</span> ${esc(port.knownFor)}</p>` : ""}
                    </div>
                  </article>`;
                })
                .join("")}
            </div>
          </div>
          <div class="dx-ports-dots" data-dx-ports-dots aria-hidden="true"></div>
        </div>
      </section>`;
  }

  function renderCruiseLines(model) {
    var lines = Array.isArray(model && model.cruiseLines) ? model.cruiseLines : [];
    if (!lines.length) return "";
    return `
      <section class="dx-section dx-lines-section" data-dx-section="lines" data-dx-reveal>
        <div class="dx-wrap">
          <header class="dx-section-head">
            <p class="dx-kicker">Cruise lines</p>
            <h2>Lines that suit this destination</h2>
            <p class="dx-section-sub">Curated from current destination guidance — not a ranking.</p>
          </header>
          <div class="dx-line-grid">
            ${lines
              .map(function (line) {
                if (line.logo) {
                  return `
                <article class="dx-line-card">
                  <div class="dx-line-logo"><img src="${esc(line.logo)}" alt="${esc(line.name)} logo" loading="lazy" decoding="async"></div>
                  <h3>${esc(line.name)}</h3>
                  ${has(line.note) ? `<p>${esc(line.note)}</p>` : ""}
                </article>`;
                }
                return `
                <article class="dx-line-card">
                  <div class="dx-line-logo"><span class="dx-line-fallback">${esc(line.name)}</span></div>
                  ${has(line.note) ? `<p>${esc(line.note)}</p>` : ""}
                </article>`;
              })
              .join("")}
          </div>
        </div>
      </section>`;
  }

  function renderSeasonAdvice(model) {
    var summary = model && model.seasonSummary;
    if (!summary || (!summary.bestWindow && !summary.shoulder && !summary.weatherCharacter && !summary.planningNote)) {
      return "";
    }
    var hero = model.hero;
    var media = hero
      ? `<div class="dx-advice-media"><img src="${esc(hero.url)}" alt="" style="object-position:center 60%" loading="lazy" decoding="async"></div>`
      : "";
    return `
      <section class="dx-section dx-advice-section" data-dx-section="advice" data-dx-reveal>
        <div class="dx-wrap">
          <div class="dx-advice-split">
            ${media}
            <div class="dx-advice-copy">
              <p class="dx-kicker">Seasonal advice</p>
              <h2>How to time it</h2>
              ${
                has(summary.bestWindow)
                  ? `<div class="dx-advice-block"><p class="dx-advice-label">Best window</p><p class="dx-advice-value">${esc(
                      summary.bestWindow
                    )}</p></div>`
                  : ""
              }
              ${
                has(summary.shoulder)
                  ? `<div class="dx-advice-block"><p class="dx-advice-label">Shoulder months</p><p class="dx-advice-value">${esc(
                      summary.shoulder
                    )}</p></div>`
                  : ""
              }
              ${
                has(summary.weatherCharacter)
                  ? `<div class="dx-advice-block"><p class="dx-advice-label">Weather character</p><p class="dx-advice-value">${esc(
                      summary.weatherCharacter
                    )}</p></div>`
                  : ""
              }
              ${
                has(summary.planningNote)
                  ? `<div class="dx-advice-block"><p class="dx-advice-label">Planning note</p><p class="dx-advice-value">${esc(
                      summary.planningNote
                    )}</p></div>`
                  : ""
              }
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderCta(model) {
    var cta = model && model.cta;
    if (!cta) return "";
    var hero = model.hero;
    var media = hero
      ? `<div class="dx-cta-media" aria-hidden="true"><img src="${esc(hero.url)}" alt="" style="object-position:center 40%" loading="lazy" decoding="async"></div>`
      : "";
    return `
      <section class="dx-cta" data-dx-section="cta">
        ${media}
        <div class="dx-cta-veil" aria-hidden="true"></div>
        <div class="dx-wrap dx-cta-copy">
          <h2>${esc(cta.headline || "")}</h2>
          ${has(cta.body) ? `<p>${esc(cta.body)}</p>` : ""}
          <div class="dx-cta-actions">
            ${
              has(cta.primaryHref)
                ? `<a class="dx-btn dx-btn-primary" href="${esc(cta.primaryHref)}">${esc(
                    cta.primaryLabel || "Find current cruises"
                  )}</a>`
                : ""
            }
            ${
              has(cta.secondaryHref)
                ? `<a class="dx-btn dx-btn-secondary" href="${esc(cta.secondaryHref)}">${esc(
                    cta.secondaryLabel || "Back"
                  )}</a>`
                : ""
            }
          </div>
        </div>
      </section>`;
  }

  function renderPage(model) {
    if (!model) {
      return `<div class="dx-wrap dx-error"><p>This destination experience is not available.</p></div>`;
    }
    return `
      <div class="dx-page" data-dx-page data-dx-slug="${esc(model.slug || "")}">
        ${renderHero(model)}
        ${renderSnapshot(model)}
        ${renderReasons(model)}
        ${renderStyles(model)}
        ${renderSeasonTimeline(model)}
        ${renderPorts(model)}
        ${renderCruiseLines(model)}
        ${renderSeasonAdvice(model)}
        ${renderCta(model)}
      </div>`;
  }

  root.DestinationExperienceComponents = {
    renderPage: renderPage,
    renderHero: renderHero,
    renderSnapshot: renderSnapshot,
    renderReasons: renderReasons,
    renderStyles: renderStyles,
    renderSeasonTimeline: renderSeasonTimeline,
    renderTimingVerdict: renderTimingVerdict,
    renderContextMonthPanel: renderContextMonthPanel,
    renderMonthPanel: renderMonthPanel,
    renderPorts: renderPorts,
    renderCruiseLines: renderCruiseLines,
    renderSeasonAdvice: renderSeasonAdvice,
    renderCta: renderCta
  };
})(typeof window !== "undefined" ? window : globalThis);
