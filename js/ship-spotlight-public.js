(function () {
  "use strict";

  const page = document.getElementById("shipPage");
  const loading = document.getElementById("shipLoading");
  const errorBox = document.getElementById("shipError");
  const errorText = document.getElementById("shipErrorText");

  const esc = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function slugFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("ships");
    if (index >= 0 && parts[index + 1]) return decodeURIComponent(parts[index + 1]);
    return new URLSearchParams(location.search).get("slug") || "";
  }

  function date(value) {
    if (!value) return "";
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  function number(value, suffix = "") {
    if (value == null || value === "") return "";
    const n = Number(value);
    return `${Number.isFinite(n) ? n.toLocaleString("en-AU", { maximumFractionDigits: 1 }) : value}${suffix}`;
  }

  function stat(label, value) {
    if (!value) return "";
    return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div></div>`;
  }

  function flattenEditorial(value, out = []) {
    if (out.length >= 6 || value == null) return out;
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      if (text.length >= 45 && text.length <= 650 && !out.includes(text)) out.push(text);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) flattenEditorial(item, out);
      return out;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) flattenEditorial(item, out);
    }
    return out;
  }

  function render(data) {
    const s = data.spotlight || {};
    const ship = data.ship || {};
    const line = data.line || {};
    const editorial = data.editorial || {};
    const gallery = (data.gallery || []).filter((row) => row?.url);
    const sailings = data.sailings || [];

    document.title = editorial.seo_title || `${ship.name} | 101cruise Ship Spotlight`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.content = editorial.meta_description || s.intro || `Explore ${ship.name} with 101cruise.`;

    const stats = [
      stat("Launched", number(ship.year_built)),
      stat("Refurbished", number(ship.year_refurbished)),
      stat("Guests", number(ship.passenger_capacity)),
      stat("Crew", number(ship.crew_count)),
      stat("Tonnage", number(ship.gross_tonnage, " GT")),
      stat("Length", number(ship.length_metres, " m")),
      stat("Beam", number(ship.beam_metres, " m")),
      stat("Decks", number(ship.deck_count)),
      stat("Staterooms", number(ship.stateroom_count)),
      stat("Cruising speed", number(ship.cruising_speed_knots, " kn"))
    ].filter(Boolean).join("");

    const highlights = (s.highlights || []).filter(Boolean).slice(0, 5);
    const extraEditorial = flattenEditorial(editorial.content || {}).filter((text) => text !== s.intro && text !== editorial.summary).slice(0, 3);
    const descriptive = extraEditorial.length
      ? extraEditorial.map((text) => `<p>${esc(text)}</p>`).join("")
      : editorial.summary && editorial.summary !== s.intro
        ? `<p>${esc(editorial.summary)}</p>`
        : `<p>Explore the ship's key facilities, accommodation and current sailings below.</p>`;

    const galleryHtml = gallery.slice(0, 12).map((row) => `<img src="${esc(row.url)}" alt="${esc(row.alt || ship.name)}" loading="lazy">`).join("");
    const sailingsHtml = sailings.map((row) => {
      const destination = row.destination || row.itinerary || "Cruise itinerary";
      const details = [date(row.departure_date), row.nights ? `${row.nights} nights` : "", row.departure_port ? `from ${row.departure_port}` : ""].filter(Boolean).join(" · ");
      return `<a class="sailing" href="${esc(row.official_url || "/cruise-finder")}" ${row.official_url ? 'target="_blank" rel="noopener"' : ""}><div class="sailing-destination">${esc(destination)}</div><div class="sailing-meta">${esc(details)}</div>${row.fare ? `<div class="sailing-fare">From ${esc(row.fare)}</div>` : ""}</a>`;
    }).join("");

    page.innerHTML = `
      <section class="hero">
        <img class="hero-image" src="${esc(s.hero_image_url || gallery[0]?.url || "")}" alt="${esc(ship.name)}">
        <div class="hero-copy">
          <div class="eyebrow">${esc(s.eyebrow || "SHIP SPOTLIGHT")}</div>
          <h1>${esc(s.heading || ship.name)}</h1>
          <div class="line-name">${esc(line.name || "")}${ship.ship_class ? ` · ${esc(ship.ship_class)}` : ""}</div>
          ${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ""}
        </div>
      </section>
      <section class="stats">${stats}</section>
      <section class="grid">
        <article class="card"><h2>About ${esc(ship.name)}</h2>${descriptive}${highlights.length ? `<div class="highlights">${highlights.map((text) => `<div class="highlight">${esc(text)}</div>`).join("")}</div>` : ""}</article>
        <aside class="card"><h2>At a glance</h2>${line.description ? `<p>${esc(line.description)}</p>` : `<p>${esc(line.name || "Cruise line")}</p>`}${editorial.pauls_tip ? `<div class="tip"><strong>Paul's tip</strong><p>${esc(editorial.pauls_tip)}</p></div>` : ""}<div class="actions">${ship.deck_plan_url ? `<a class="button secondary" href="${esc(ship.deck_plan_url)}" target="_blank" rel="noopener">View deck plan</a>` : ""}<a class="button" href="/cruise-finder">Find a cruise</a></div></aside>
      </section>
      ${galleryHtml ? `<section><div class="gallery-head"><div><div class="eyebrow" style="color:var(--green)">ON BOARD</div><h2>Explore ${esc(ship.name)}</h2></div></div><div class="gallery">${galleryHtml}</div></section>` : ""}
      <section><div class="sailings-head"><div><div class="eyebrow" style="color:var(--green)">CURRENT CRUISES</div><h2>Sail aboard ${esc(ship.name)}</h2></div></div>${sailingsHtml ? `<div class="sailings">${sailingsHtml}</div>` : `<div class="empty">There are no current validated sailings to show for this ship right now. <a href="/cruise-finder">Search Cruise Finder</a>.</div>`}</section>`;

    loading.hidden = true;
    errorBox.style.display = "none";
    page.hidden = false;
  }

  async function load() {
    const slug = slugFromPath();
    if (!slug) {
      loading.hidden = true; errorText.textContent = "No ship was selected."; errorBox.style.display = "block"; return;
    }
    try {
      const response = await fetch(`/.netlify/functions/public-ship-spotlight?slug=${encodeURIComponent(slug)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.error || "This Ship Spotlight is unavailable.");
      render(data);
    } catch (error) {
      loading.hidden = true; errorText.textContent = error.message || "This Ship Spotlight could not be loaded."; errorBox.style.display = "block";
    }
  }

  load();
})();
