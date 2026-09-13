(function () {
  "use strict";

  const page = document.getElementById("shipPage");
  const mount = document.getElementById("shipPresentationMount");
  const extras = document.getElementById("shipPublicExtras");
  const loading = document.getElementById("shipLoading");
  const errorBox = document.getElementById("shipError");
  const errorText = document.getElementById("shipErrorText");
  const lightbox = document.getElementById("shipLightbox");
  const lightboxImage = document.getElementById("shipLightboxImage");

  const esc = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function slugFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("ships");
    if (index >= 0 && parts[index + 1]) return decodeURIComponent(parts[index + 1]);
    return new URLSearchParams(location.search).get("slug") || "";
  }

  function formatDate(value) {
    if (!value) return "";
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  function paragraphsHtml(value) {
    const text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!text) return "";
    return text
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => `<p>${esc(part)}</p>`)
      .join("");
  }

  function forcePublicH1(root) {
    const heading = root?.querySelector(".ship-identity-name");
    if (!heading || heading.tagName === "H1") return;
    const h1 = document.createElement("h1");
    h1.className = heading.className;
    h1.innerHTML = heading.innerHTML;
    Array.from(heading.attributes || []).forEach((attribute) => {
      if (attribute.name !== "class") h1.setAttribute(attribute.name, attribute.value);
    });
    heading.replaceWith(h1);
  }

  function insertSpotlightIntro(root, spotlight) {
    const intro = String(spotlight?.intro || "").trim();
    if (!intro) return;
    const hero = root?.querySelector(".ship-hero");
    if (!hero) return;
    const section = document.createElement("section");
    section.className = "public-spotlight-intro ship-reveal-block";
    section.style.setProperty("--ship-delay", "20ms");
    section.innerHTML = `
      <div class="public-spotlight-eyebrow">${esc(spotlight.eyebrow || "SHIP SPOTLIGHT")}</div>
      <p>${esc(intro)}</p>`;
    hero.insertAdjacentElement("afterend", section);
  }

  function removeUnavailableSummaryFacts(root) {
    root?.querySelectorAll(".ship-summary-stat").forEach((stat) => {
      const value = String(stat.querySelector(".ship-summary-value")?.textContent || "").trim().toLowerCase();
      if (value === "not listed") stat.remove();
    });
    root?.querySelectorAll(".ship-glance-item.is-empty").forEach((item) => item.remove());
  }

  function enhanceFeatureColumn(column, items) {
    if (!column) return;
    const rows = Array.from(column.querySelectorAll(".ship-feature-item"));
    rows.forEach((row, index) => {
      const description = String(items?.[index]?.description || "").trim();
      const copy = row.querySelector(".ship-feature-copy");
      if (!copy) return;
      let descriptionNode = copy.querySelector(".ship-feature-description");
      if (!description) {
        if (descriptionNode) descriptionNode.remove();
        return;
      }
      if (!descriptionNode) {
        descriptionNode = document.createElement("div");
        descriptionNode.className = "ship-feature-description planner-muted";
        copy.appendChild(descriptionNode);
      }
      descriptionNode.innerHTML = paragraphsHtml(description);
    });
  }

  function enhanceFeatureLayout(root, profile) {
    const exclusive = Array.isArray(profile?.exclusiveAreas) ? profile.exclusiveAreas : [];
    const specialty = Array.isArray(profile?.specialtyFeatures) ? profile.specialtyFeatures : [];
    const grid = root?.querySelector(".ship-feature-experiences-grid");
    if (!grid) return;

    const exclusiveColumn = grid.querySelector(".ship-feature-column--exclusive");
    const specialtyColumn = grid.querySelector(".ship-feature-column--specialty");
    const divider = grid.querySelector(".ship-feature-column-divider");

    enhanceFeatureColumn(exclusiveColumn, exclusive);
    enhanceFeatureColumn(specialtyColumn, specialty);

    if (!exclusive.length && exclusiveColumn) exclusiveColumn.remove();
    if (!specialty.length && specialtyColumn) specialtyColumn.remove();

    const hasExclusive = exclusive.length > 0;
    const hasSpecialty = specialty.length > 0;
    if (hasExclusive && hasSpecialty) return;

    if (divider) divider.remove();
    if (hasExclusive) {
      grid.style.gridTemplateColumns = "minmax(0,1fr)";
      grid.style.gridTemplateAreas = '"exclusive" "deckplans"';
    } else if (hasSpecialty) {
      grid.style.gridTemplateColumns = "minmax(0,1fr)";
      grid.style.gridTemplateAreas = '"specialty" "deckplans"';
    }
  }

  function galleryHtml(data) {
    const ship = data.ship || {};
    const heroUrl = String(data.spotlight?.hero_image_url || "").trim();
    const gallery = (data.gallery || [])
      .filter((row) => row?.url && String(row.url).trim() !== heroUrl)
      .slice(0, 12);
    if (!gallery.length) return "";
    return `
      <section class="public-extra-section" aria-labelledby="shipGalleryHeading">
        <div class="public-section-head">
          <div>
            <div class="public-section-eyebrow">ON BOARD</div>
            <h2 id="shipGalleryHeading">More photos of ${esc(ship.name)}</h2>
          </div>
        </div>
        <div class="public-gallery-grid">
          ${gallery.map((row, index) => `
            <button class="public-gallery-item" type="button" data-gallery-index="${index}" data-gallery-src="${esc(row.url)}" data-gallery-alt="${esc(row.alt || row.title || ship.name)}">
              <img src="${esc(row.url)}" alt="${esc(row.alt || row.title || ship.name)}" loading="lazy">
            </button>`).join("")}
        </div>
      </section>`;
  }

  function sailingCard(row, shipName) {
    const title = String(row.destination || row.itinerary || `${shipName} cruise`).trim();
    const meta = [
      row.nights ? `${row.nights} nights` : "",
      row.departure_port ? `from ${row.departure_port}` : ""
    ].filter(Boolean).join(" · ");
    const fare = String(row.fare || "").trim();
    return `
      <article class="public-sailing-card">
        <div class="public-sailing-date">${esc(formatDate(row.departure_date))}</div>
        <div class="public-sailing-title">${esc(title)}</div>
        ${meta ? `<div class="public-sailing-meta">${esc(meta)}</div>` : ""}
        ${fare ? `<div class="public-sailing-fare">From ${esc(fare)}</div>` : ""}
      </article>`;
  }

  function cruisesHtml(data) {
    const ship = data.ship || {};
    const sailings = Array.isArray(data.sailings) ? data.sailings : [];
    const cards = sailings.slice(0, 6).map((row) => sailingCard(row, ship.name)).join("");
    const finderUrl = "/cruise-finder";
    return `
      <section class="public-extra-section" aria-labelledby="shipCruisesHeading">
        <div class="public-section-head">
          <div>
            <div class="public-section-eyebrow">CURRENT CRUISES</div>
            <h2 id="shipCruisesHeading">Cruise on ${esc(ship.name)}</h2>
            <p>Upcoming validated sailings currently in the 101CRUISE cruise database.</p>
          </div>
        </div>
        ${cards ? `<div class="public-sailings">${cards}</div>` : `<div class="public-sailing-empty">There are no current validated sailings to show for ${esc(ship.name)} right now.</div>`}
        <div class="public-cruise-cta">
          <div class="public-cruise-cta-copy">
            <strong>Looking for the right cruise?</strong>
            <span>Use Cruise Finder to narrow down dates, duration, departure point and holiday style.</span>
          </div>
          <a href="${finderUrl}">Search Cruise Finder →</a>
        </div>
      </section>`;
  }

  function bindGallery() {
    document.querySelectorAll("[data-gallery-src]").forEach((button) => {
      button.addEventListener("click", () => {
        const src = button.getAttribute("data-gallery-src") || "";
        if (!src || !lightbox || !lightboxImage) return;
        lightboxImage.src = src;
        lightboxImage.alt = button.getAttribute("data-gallery-alt") || "Ship photo";
        lightbox.classList.add("is-open");
        lightbox.setAttribute("aria-hidden", "false");
      });
    });
  }

  function closeLightbox() {
    if (!lightbox || !lightboxImage) return;
    lightbox.classList.remove("is-open");
    lightbox.setAttribute("aria-hidden", "true");
    lightboxImage.src = "";
  }

  function bindLightboxChrome() {
    lightbox?.querySelector(".public-lightbox-close")?.addEventListener("click", closeLightbox);
    lightbox?.addEventListener("click", (event) => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && lightbox?.classList.contains("is-open")) closeLightbox();
    });
  }

  function render(data) {
    const spotlight = data.spotlight || {};
    const ship = data.ship || {};
    const line = data.line || {};
    const editorial = data.editorial || {};
    const presentation = window.CiShipPresentation;

    if (!presentation?.buildProfile || !presentation?.mountPresentation) {
      throw new Error("The ship presentation could not be loaded.");
    }

    document.title = editorial.seo_title || `${ship.name} | 101CRUISE Ship Spotlight`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.content = editorial.meta_description || spotlight.intro || `Explore ${ship.name} with 101CRUISE.`;

    const profile = presentation.buildProfile(ship, {
      shipName: ship.name,
      cruiseLine: line.name || ""
    });

    presentation.mountPresentation(mount, profile, {
      mode: "public",
      cruiseLineLogo: line.logo_url || "",
      shipImage: spotlight.hero_image_url || data.gallery?.[0]?.url || ""
    });

    const root = mount.querySelector(".ship-page");
    if (root) {
      root.classList.add("public-ship-page");
      forcePublicH1(root);
      insertSpotlightIntro(root, spotlight);
      removeUnavailableSummaryFacts(root);
      enhanceFeatureLayout(root, profile);
    }

    extras.innerHTML = `${galleryHtml(data)}${cruisesHtml(data)}`;
    bindGallery();

    loading.hidden = true;
    errorBox.style.display = "none";
    page.hidden = false;
  }

  async function load() {
    const slug = slugFromPath();
    if (!slug) {
      loading.hidden = true;
      errorText.textContent = "No ship was selected.";
      errorBox.style.display = "block";
      return;
    }

    try {
      const response = await fetch(`/.netlify/functions/public-ship-spotlight?slug=${encodeURIComponent(slug)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || "This Ship Spotlight is unavailable.");
      }
      render(data);
    } catch (error) {
      loading.hidden = true;
      errorText.textContent = error.message || "This Ship Spotlight could not be loaded.";
      errorBox.style.display = "block";
    }
  }

  bindLightboxChrome();
  load();
})();
