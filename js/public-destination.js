/**
 * Public Destination Experience page: /destination/{slug}
 * Sprint 11A polish — template + placeholders (no live Discovery Engine).
 *
 * FUTURE (architecture only):
 * - Port images: Media Library via mediaId / mediaKey only
 * - Cruise count + cards: Cruise Discovery Engine
 * - Port cards: link to Port Guide pages (/port/{slug})
 */
(function () {
  "use strict";

  const HOME_URL = "https://www.101cruise.com.au";
  const Data = window.DestinationPageData;
  let activeDestination = null;
  let cruisesVisible = 0;

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function slugFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("destination");
    if (idx >= 0 && parts[idx + 1]) {
      const raw = decodeURIComponent(parts[idx + 1]);
      if (/^index\.html?$/i.test(raw)) return "";
      return slugify(raw);
    }
    const params = new URLSearchParams(window.location.search);
    return slugify(params.get("slug") || params.get("destination") || "");
  }

  function setMetadata(dest) {
    const title = `${dest.name} Cruises | 101cruise`;
    const description = String(dest.summary || "").trim().slice(0, 160);
    const canonical = `${window.location.origin}/destination/${dest.slug}`;

    document.title = title;

    function setMeta(selector, attr, value) {
      if (!value) return;
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement("meta");
        if (selector.startsWith('meta[name="')) {
          el.setAttribute("name", selector.match(/name="([^"]+)"/)[1]);
        } else if (selector.startsWith('meta[property="')) {
          el.setAttribute("property", selector.match(/property="([^"]+)"/)[1]);
        }
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    }

    setMeta('meta[name="description"]', "content", description || `Explore ${dest.name} cruises with 101cruise.`);
    setMeta('meta[property="og:title"]', "content", title);
    setMeta('meta[property="og:description"]', "content", description || title);
    setMeta('meta[property="og:url"]', "content", canonical);
    if (dest.hero?.url) setMeta('meta[property="og:image"]', "content", dest.hero.url);

    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", canonical);
  }

  function scrollToCruises(event) {
    if (event) event.preventDefault();
    const section = document.getElementById("cruises");
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    // Keep the URL clean so refresh does not jump mid-page via #cruises
    if (window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  function ensurePageStartsAtTop() {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    window.scrollTo(0, 0);
  }

  function suitabilityRow(key, levelKey) {
    const labels = {
      couples: "Couples",
      families: "Families",
      luxury: "Luxury",
      adventure: "Adventure",
      food_wine: "Food & Wine",
      first_cruise: "First Cruise"
    };
    const level = Data.SUITABILITY[levelKey] || Data.SUITABILITY.good;
    return `
      <div class="dest-suit-row" data-level="${esc(levelKey)}">
        <div class="dest-suit-meta">
          <span class="dest-suit-label">${esc(labels[key] || key)}</span>
          <span class="dest-suit-rating">${esc(level.label)}</span>
        </div>
        <div class="dest-suit-track" aria-hidden="true">
          <div class="dest-suit-fill" style="--dest-fill: ${level.fill}%"></div>
        </div>
      </div>
    `;
  }

  function renderHero(dest, contactUrl) {
    const pos = dest.hero?.objectPosition || "center center";
    return `
      <section class="dest-hero dest-reveal" aria-label="${esc(dest.name)} hero">
        <div class="dest-hero-media" style="--dest-hero-pos: ${esc(pos)}">
          <img src="${esc(dest.hero.url)}" alt="${esc(dest.hero.alt || dest.name)}" fetchpriority="high">
        </div>
        <div class="dest-hero-veil" aria-hidden="true"></div>
        <div class="dest-hero-inner">
          <p class="dest-kicker">Destination</p>
          <h1 class="dest-hero-title">${esc(dest.name)}</h1>
          <p class="dest-hero-summary">${esc(dest.summary)}</p>
          <div class="dest-hero-ctas">
            <a class="dest-btn dest-btn-primary" href="#cruises" onclick="DestinationExperience.scrollToCruises(event)">View Current Cruises</a>
            <a class="dest-btn dest-btn-secondary" href="${esc(contactUrl)}">Contact Paul for a better price</a>
          </div>
        </div>
      </section>
    `;
  }

  function renderWhy(dest) {
    return `
      <section class="dest-section dest-reveal" style="--dest-delay: 60ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title">Why Cruise Here</h2>
          <p class="dest-prose">${esc(dest.whyCruiseHere)}</p>
        </div>
      </section>
    `;
  }

  function renderSnapshot(dest) {
    const cards = (dest.snapshot || [])
      .map(
        (item) => `
        <article class="dest-snap-card">
          <p class="dest-snap-label">${esc(item.label)}</p>
          <p class="dest-snap-value">${esc(item.value)}</p>
        </article>`
      )
      .join("");
    return `
      <section class="dest-section dest-section-soft dest-reveal" style="--dest-delay: 100ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title">Destination Snapshot</h2>
          <div class="dest-snap-grid">${cards}</div>
        </div>
      </section>
    `;
  }

  function renderSuitability(dest) {
    const s = dest.suitability || {};
    const keys = ["couples", "families", "luxury", "adventure", "food_wine", "first_cruise"];
    const rows = keys.map((k) => suitabilityRow(k, s[k] || "good")).join("");
    return `
      <section class="dest-section dest-reveal" style="--dest-delay: 140ms">
        <div class="dest-wrap dest-wrap-narrow">
          <h2 class="dest-section-title">Is This Destination Right For Me?</h2>
          <div class="dest-suit-list">${rows}</div>
          ${s.summary ? `<p class="dest-suit-summary">${esc(s.summary)}</p>` : ""}
        </div>
      </section>
    `;
  }

  function renderPorts(dest) {
    const cards = (dest.ports || [])
      .slice(0, 5)
      .map((port) => {
        const image = Data.resolvePortImage(port);
        const href = port.guideHref || `#ports`;
        const mediaAttr = port.mediaKey ? ` data-media-key="${esc(port.mediaKey)}"` : "";
        const mediaIdAttr = port.mediaId ? ` data-media-id="${esc(port.mediaId)}"` : "";
        const placeholderClass = image.source === "placeholder" ? " is-placeholder" : "";
        const imgHtml = image.url
          ? `<img src="${esc(image.url)}" alt="${esc(image.alt)}" loading="lazy">`
          : `<div class="dest-port-placeholder" aria-hidden="true"></div>`;
        return `
        <a class="dest-port-card${placeholderClass}" href="${esc(href)}" data-port-slug="${esc(port.slug || "")}"${mediaAttr}${mediaIdAttr} aria-label="${esc(port.name)}${port.guideHref ? "" : " — port guide coming soon"}">
          <div class="dest-port-media" style="--dest-port-pos: ${esc(image.objectPosition || "center center")}">
            ${imgHtml}
          </div>
          <div class="dest-port-body">
            <h3 class="dest-port-name">${esc(port.name)}</h3>
            <p class="dest-port-desc">${esc(port.description)}</p>
          </div>
        </a>`;
      })
      .join("");
    return `
      <section class="dest-section dest-section-soft dest-reveal" id="ports" style="--dest-delay: 180ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title">Featured Ports</h2>
          <p class="dest-section-lead">Signature stops you’ll often see on ${esc(dest.name)} itineraries.</p>
          <div class="dest-port-grid">${cards}</div>
        </div>
      </section>
    `;
  }

  function renderCruiseCard(dest, c) {
    return `
      <article class="dest-cruise-card">
        <div class="dest-cruise-top">
          <p class="dest-cruise-line">${esc(c.cruiseLine)}</p>
          <h3 class="dest-cruise-ship">${esc(c.shipName)}</h3>
        </div>
        <div class="dest-cruise-meta">
          <span>${esc(c.duration)}</span>
          <span>${esc(c.departureDate)}</span>
        </div>
        <div class="dest-cruise-itinerary">
          <p class="dest-cruise-itin-label">Itinerary</p>
          <p class="dest-cruise-itin-value">${esc(c.itinerary)}</p>
        </div>
        <div class="dest-cruise-foot">
          <p class="dest-cruise-fare">
            <span class="dest-cruise-fare-label">Official Brochure Fare</span>
            <span class="dest-cruise-fare-value">${esc(c.brochureFare)}</span>
          </p>
          <a class="dest-btn dest-btn-primary dest-btn-block dest-btn-cruise-cta" href="${esc(
            Data.contactMailto(dest.name, `${c.shipName} · ${c.departureDate}`)
          )}">Contact Paul for a better price</a>
        </div>
      </article>`;
  }

  function cruiseShowingText(visible, total) {
    if (!total) return "Showing 0";
    return `Showing 1–${visible} of ${total}`;
  }

  function renderCruises(dest, contactUrl) {
    const catalog = Data.getCruiseCatalog(dest);
    const total = catalog.totalCount || catalog.sailings.length;
    const pageSize = catalog.pageSize || Data.CRUISE_PAGE_SIZE || 6;
    cruisesVisible = Math.min(pageSize, total);
    const visibleSailings = catalog.sailings.slice(0, cruisesVisible);
    const cards = visibleSailings.map((c) => renderCruiseCard(dest, c)).join("");
    const hasMore = cruisesVisible < total;

    return `
      <section class="dest-section dest-reveal" id="cruises" style="--dest-delay: 220ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title" id="dest-cruise-heading">${esc(String(total))} Cruises Available for ${esc(dest.name)}</h2>
          <p class="dest-section-lead dest-cruise-showing" id="dest-cruise-showing">${esc(cruiseShowingText(cruisesVisible, total))}</p>
          <div class="dest-cruise-list" id="dest-cruise-list">${cards}</div>
          <div class="dest-cruise-load-wrap" id="dest-cruise-load-wrap" ${hasMore ? "" : "hidden"}>
            <button type="button" class="dest-btn dest-btn-secondary-ink" id="dest-cruise-load-more" onclick="DestinationExperience.loadMoreCruises()">
              Load More Cruises
            </button>
          </div>
          <div class="dest-cruise-section-cta">
            <a class="dest-btn dest-btn-primary" href="${esc(contactUrl)}">Contact Paul for a better price</a>
          </div>
        </div>
      </section>
    `;
  }

  function loadMoreCruises() {
    if (!activeDestination) return;
    const catalog = Data.getCruiseCatalog(activeDestination);
    const total = catalog.totalCount || catalog.sailings.length;
    const pageSize = catalog.pageSize || Data.CRUISE_PAGE_SIZE || 6;
    if (cruisesVisible >= total) return;

    const nextVisible = Math.min(cruisesVisible + pageSize, total);
    const list = document.getElementById("dest-cruise-list");
    const showing = document.getElementById("dest-cruise-showing");
    const loadWrap = document.getElementById("dest-cruise-load-wrap");
    if (!list) return;

    const fragment = document.createDocumentFragment();
    const temp = document.createElement("div");
    temp.innerHTML = catalog.sailings
      .slice(cruisesVisible, nextVisible)
      .map((c) => renderCruiseCard(activeDestination, c))
      .join("");
    while (temp.firstChild) fragment.appendChild(temp.firstChild);
    list.appendChild(fragment);

    cruisesVisible = nextVisible;
    if (showing) showing.textContent = cruiseShowingText(cruisesVisible, total);
    if (loadWrap) loadWrap.hidden = cruisesVisible >= total;
  }

  function renderLines(dest) {
    const items = (dest.cruiseLines || [])
      .map(
        (line) => `
        <li class="dest-line-item">
          ${
            line.logo
              ? `<img src="${esc(line.logo)}" alt="${esc(line.name)}" loading="lazy">`
              : `<span class="dest-line-wordmark">${esc(line.name)}</span>`
          }
        </li>`
      )
      .join("");
    return `
      <section class="dest-section dest-section-soft dest-reveal" style="--dest-delay: 260ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title">Cruise Lines Visiting</h2>
          <ul class="dest-line-strip">${items}</ul>
        </div>
      </section>
    `;
  }

  function renderGoodToKnow(dest) {
    const cells = (dest.goodToKnow || [])
      .map(
        (item) => `
        <div class="dest-gtk-cell">
          <p class="dest-gtk-label">${esc(item.label)}</p>
          <p class="dest-gtk-value">${esc(item.value)}</p>
        </div>`
      )
      .join("");
    return `
      <section class="dest-section dest-reveal" style="--dest-delay: 300ms">
        <div class="dest-wrap">
          <h2 class="dest-section-title">Good To Know</h2>
          <div class="dest-gtk-strip" role="list">${cells}</div>
        </div>
      </section>
    `;
  }

  function renderFaqs(dest) {
    const items = (dest.faqs || [])
      .slice(0, 4)
      .map(
        (faq, i) => `
        <details class="dest-faq" ${i === 0 ? "open" : ""}>
          <summary>${esc(faq.q)}</summary>
          <p>${esc(faq.a)}</p>
        </details>`
      )
      .join("");
    return `
      <section class="dest-section dest-section-soft dest-reveal" style="--dest-delay: 340ms">
        <div class="dest-wrap dest-wrap-narrow">
          <h2 class="dest-section-title">FAQs</h2>
          <div class="dest-faq-list">${items}</div>
        </div>
      </section>
    `;
  }

  function renderFinalCta(dest, contactUrl) {
    return `
      <section class="dest-final dest-reveal" style="--dest-delay: 380ms">
        <div class="dest-wrap dest-wrap-narrow">
          <div class="dest-final-panel">
            <h2 class="dest-final-title">Ready to Cruise ${esc(dest.name)}?</h2>
            <p class="dest-final-text">Tell Paul your dates, cabin preference and travel party — he’ll check current offers and find a better price than the brochure fare whenever he can.</p>
            <a class="dest-btn dest-btn-dark" href="${esc(contactUrl)}">Contact Paul for a better price</a>
          </div>
        </div>
      </section>
    `;
  }

  function renderFooter() {
    return `
      <footer class="dest-footer">
        <div class="dest-wrap dest-footer-inner">
          <a class="dest-footer-home" href="${HOME_URL}">101cruise</a>
          <nav class="dest-footer-nav" aria-label="Footer contact">
            <a href="mailto:paul@101cruise.com.au">Contact Me</a>
            <a href="tel:+61411224036">Request a Call</a>
            <a href="${esc(Data.QUOTE_URL)}">Request a Quote</a>
          </nav>
        </div>
      </footer>
    `;
  }

  function renderPage(dest) {
    const contactUrl = Data.contactMailto(dest.name);
    return `
      <article class="dest-page" data-destination="${esc(dest.slug)}">
        ${renderHero(dest, contactUrl)}
        ${renderWhy(dest)}
        ${renderSnapshot(dest)}
        ${renderSuitability(dest)}
        ${renderPorts(dest)}
        ${renderCruises(dest, contactUrl)}
        ${renderLines(dest)}
        ${renderGoodToKnow(dest)}
        ${renderFaqs(dest)}
        ${renderFinalCta(dest, contactUrl)}
        ${renderFooter()}
      </article>
    `;
  }

  function renderNotFound(slug) {
    const available = Data.listSlugs()
      .map((s) => `<a href="/destination/${esc(s)}">${esc(s)}</a>`)
      .join(" · ");
    return `
      <div class="dest-not-found">
        <h1>Destination not found</h1>
        <p>We don’t have a guide for <code>${esc(slug || "this destination")}</code> yet.</p>
        <p class="dest-not-found-hint">Available templates: ${available || "—"}</p>
        <p><a href="${HOME_URL}">Back to 101cruise</a></p>
      </div>
    `;
  }

  function revealPage(root) {
    requestAnimationFrame(() => {
      root.classList.add("is-ready");
    });
  }

  function mount() {
    const root = document.getElementById("public-destination-app");
    if (!root || !Data) return;

    const slug = slugFromPath() || "alaska";
    const dest = Data.getDestination(slug);

    if (!dest) {
      activeDestination = null;
      root.innerHTML = renderNotFound(slug);
      return;
    }

    activeDestination = dest;
    setMetadata(dest);
    root.innerHTML = renderPage(dest);
    ensurePageStartsAtTop();
    revealPage(root.querySelector(".dest-page"));
    // Re-assert after layout/images so Safari does not restore mid-page scroll
    requestAnimationFrame(() => {
      ensurePageStartsAtTop();
      setTimeout(ensurePageStartsAtTop, 50);
    });
  }

  window.DestinationExperience = {
    loadMoreCruises,
    scrollToCruises,
    remount: mount
  };

  // Prevent #cruises (or browser restore) from landing mid-page on refresh
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) ensurePageStartsAtTop();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
