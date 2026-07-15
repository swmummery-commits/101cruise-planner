/**
 * 101cruise Cruise Finder — Destination Detail page.
 *
 * Mounts into: <div id="101cruise-cruise-destination"></div>
 * URL: /cruise-destination?destination=<slug>
 * Prefs: sessionStorage + compact URL params from Cruise Finder.
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-cruise-destination";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const PREFS_KEY = "101cruise-cf-prefs";
  const SCRIPT_EL = document.currentScript;

  const MONTH_NAMES = [
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

  const STYLE_LABELS = {
    beaches: "Beaches",
    relaxation: "Relaxation",
    adventure: "Adventure",
    wildlife: "Wildlife",
    culture: "Culture",
    luxury: "Luxury",
    expedition: "Expedition",
    food_wine: "Food & Wine",
    scenic_cruising: "Scenic cruising",
    river_cruising: "River cruising",
    warm_weather: "Warm weather",
    cold_weather: "Cold weather",
    bucket_list: "Bucket List"
  };

  const DEPARTURE_LABELS = {
    sydney: "Sydney",
    brisbane: "Brisbane",
    melbourne: "Melbourne",
    perth: "Perth",
    adelaide: "Adelaide",
    auckland: "Auckland",
    anywhere: "I'll fly anywhere"
  };

  const DURATION_LABELS = {
    "3-5": "3–5 nights",
    "6-8": "6–8 nights",
    "9-12": "9–12 nights",
    "13-16": "13–16 nights",
    "17-plus": "17+ nights",
    flexible: "I'm flexible"
  };

  const MATCH_LABELS = {
    top: "My Top Recommendation",
    excellent: "Excellent Match",
    option: "Another Great Option",
    worth: "Worth Considering"
  };

  let mount = null;

  function getScriptOrigin() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    const scripts = document.querySelectorAll('script[src*="cruise-finder/destination.js"]');
    const last = scripts[scripts.length - 1];
    if (last && last.src) {
      try {
        return new URL(last.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    return NETLIFY_ORIGIN;
  }

  const TOOLS_ORIGIN = getScriptOrigin();

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function queryParams() {
    try {
      return new URLSearchParams(window.location.search || "");
    } catch (_error) {
      return new URLSearchParams();
    }
  }

  function readSessionPrefs() {
    try {
      const raw = sessionStorage.getItem(PREFS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function prefsFromUrl(params) {
    const styles = String(params.get("st") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      timingMode: params.get("tm") || "",
      startDate: params.get("sd") || "",
      endDate: params.get("ed") || "",
      month: params.get("m") || "",
      year: params.get("y") || "",
      durationId: params.get("dur") || "",
      departure: params.get("dep") || "",
      styles,
      budgetId: params.get("bud") || "",
      matchKey: params.get("mk") || "",
      matchLabel: ""
    };
  }

  function mergePrefs(urlPrefs, sessionPrefs) {
    const base = Object.assign({}, sessionPrefs || {}, urlPrefs || {});
    if (!base.matchLabel && base.matchKey) {
      base.matchLabel = MATCH_LABELS[base.matchKey] || "Worth Considering";
    }
    if (!base.matchLabel) base.matchLabel = "Worth Considering";
    if (!base.matchKey) base.matchKey = "worth";
    return base;
  }

  function findDestination(slug) {
    const list = window.CruiseFinderDestinations;
    if (!Array.isArray(list)) return null;
    const key = String(slug || "")
      .trim()
      .toLowerCase();
    return list.find((d) => d && (d.id === key || d.slug === key) && d.active !== false) || null;
  }

  function contentFor(dest) {
    if (typeof window.CruiseFinderGetDestinationContent === "function") {
      return window.CruiseFinderGetDestinationContent(dest.id) || {};
    }
    return {};
  }

  function monthNames(months) {
    return (months || [])
      .map((m) => MONTH_NAMES[m - 1])
      .filter(Boolean)
      .join(", ");
  }

  function cruiseLengthLabel(dest) {
    const min = dest.typical_nights_min;
    const max = dest.typical_nights_max;
    if (min == null) return "Varies";
    if (max == null || min === max) return `${min} nights`;
    return `${min}–${max} nights`;
  }

  function travelWindowLabel(prefs) {
    if (prefs.timingMode === "exact" && prefs.startDate) {
      return prefs.endDate && prefs.endDate !== prefs.startDate
        ? `${prefs.startDate} to ${prefs.endDate}`
        : prefs.startDate;
    }
    if (prefs.timingMode === "month" && prefs.month) {
      const name = MONTH_NAMES[Number(prefs.month) - 1] || prefs.month;
      return prefs.year ? `${name} ${prefs.year}` : name;
    }
    if (prefs.timingMode === "school_holidays") return "school holiday dates";
    if (prefs.timingMode === "this_season") return "this season";
    if (prefs.timingMode === "flexible") return "flexible dates";
    return "";
  }

  function primaryMonth(prefs) {
    if (prefs.timingMode === "month" && prefs.month) return Number(prefs.month) || 0;
    if (prefs.timingMode === "exact" && prefs.startDate) {
      const parts = String(prefs.startDate).split("-");
      return Number(parts[1]) || 0;
    }
    if (prefs.timingMode === "this_season") return new Date().getMonth() + 1;
    return 0;
  }

  function personalisedWhy(dest, content, prefs) {
    const windowLabel = travelWindowLabel(prefs);
    const month = primaryMonth(prefs);
    const best = dest.best_months || [];
    const shoulder = dest.acceptable_months || [];
    const departure = DEPARTURE_LABELS[prefs.departure] || "";
    const styles = (prefs.styles || [])
      .map((id) => STYLE_LABELS[id] || id)
      .filter(Boolean)
      .slice(0, 2);
    const duration = DURATION_LABELS[prefs.durationId] || "";

    const bits = [];

    if (windowLabel) {
      if (month && best.includes(month)) {
        bits.push(
          `Your ${windowLabel} travel window aligns well with ${dest.name}’s stronger cruise season.`
        );
      } else if (month && shoulder.includes(month)) {
        bits.push(
          `Your ${windowLabel} dates can still work well for ${dest.name}, typically as a shoulder-season option.`
        );
      } else if (prefs.timingMode === "flexible") {
        bits.push(
          `With flexible dates, we can typically aim for ${dest.name}’s best months — ${monthNames(best) || "peak season"}.`
        );
      } else {
        bits.push(
          `${dest.name} is still worth considering for your ${windowLabel} plans, though we’d talk carefully about seasonality.`
        );
      }
    }

    if (styles.length) {
      bits.push(
        `Your interest in ${styles.join(" and ").toLowerCase()} commonly suits this destination.`
      );
    }

    if (prefs.durationId === "flexible") {
      bits.push(`Your flexible cruise length typically opens a wider range of ${dest.name} itineraries.`);
    } else if (duration) {
      bits.push(`Sailings here commonly fall around ${cruiseLengthLabel(dest)}, close to a ${duration.toLowerCase()} holiday.`);
    }

    if (prefs.departure === "anywhere") {
      bits.push(`Being open to flying anywhere usually improves access to the best ${dest.name} departures.`);
    } else if (
      departure &&
      (dest.departure_markets || []).includes(prefs.departure) &&
      (content.proximity || "").toLowerCase().includes("closer")
    ) {
      bits.push(`From ${departure}, ${dest.name} often offers some of the simplest departure options.`);
    } else if (departure && prefs.departure !== "anywhere") {
      bits.push(`From ${departure}, travellers commonly connect to the main embarkation ports for this region.`);
    }

    if (!bits.length) {
      return `${dest.name} is commonly a strong cruise destination for the kind of holiday you’ve described.`;
    }

    return bits.slice(0, 3).join(" ");
  }

  function finderBackUrl() {
    if (location.hostname.indexOf("101cruise.com.au") !== -1) {
      return "https://101cruise.com.au/cruise-finder";
    }
    return `${TOOLS_ORIGIN}/cruise-finder`;
  }

  function renderError(message) {
    mount.innerHTML = `
      <div class="cf-dest">
        <p class="cf-dest-error">${escapeHtml(message)}</p>
        <p style="text-align:center;"><a class="cf-dest-back" href="${escapeHtml(finderBackUrl())}">← Back to Cruise Finder</a></p>
      </div>`;
  }

  function render(dest, prefs) {
    const content = contentFor(dest);
    const month = primaryMonth(prefs);
    const heroApi = window.CruiseFinderHeroImages;
    const image =
      heroApi && typeof heroApi.pick === "function" ? heroApi.pick(dest, month) : null;
    const imageUrl = image && image.url ? image.url : "";
    const objectPosition = (image && image.objectPosition) || "center center";
    const filterLines =
      typeof window.CruiseFinderFilterCruiseLines === "function"
        ? window.CruiseFinderFilterCruiseLines
        : function (names) {
            return Array.isArray(names) ? names : [];
          };
    const lines = filterLines(dest.typical_cruise_lines || []);
    const why = personalisedWhy(dest, content, prefs);
    const advice = content.seasonal_advice || {};
    const ports = content.popular_ports || [];
    const departures = content.departure_ports || [];
    const reasons = content.key_reasons || [];

    mount.innerHTML = `
      <div class="cf-dest" data-destination="${escapeHtml(dest.id)}" style="--cf-accent:${escapeHtml(dest.accent || "#8DD9BF")}">
        <a class="cf-dest-back" href="${escapeHtml(finderBackUrl())}">← Back to Cruise Finder</a>

        <section class="cf-dest-intro">
          <div class="cf-dest-media" data-image-url="${escapeHtml(imageUrl)}" data-object-position="${escapeHtml(objectPosition)}">
            <img alt="" loading="lazy" decoding="async" width="1280" height="720" style="object-position:${escapeHtml(objectPosition)}" />
            <div class="cf-dest-media-fade" aria-hidden="true"></div>
            <div class="cf-dest-media-centre">
              <span class="cf-dest-badge">${escapeHtml(prefs.matchLabel || "Worth Considering")}</span>
              <h1 class="cf-dest-title">${escapeHtml(dest.name)}</h1>
              <p class="cf-dest-tagline">${escapeHtml(dest.hero_tagline || "")}</p>
            </div>
          </div>
          <div class="cf-dest-intro-body">
            <p class="cf-dest-why-label">Why it suits your holiday</p>
            <p class="cf-dest-why">${escapeHtml(why)}</p>
          </div>
        </section>

        <section class="cf-dest-section">
          <h2 class="cf-dest-section-title">At a glance</h2>
          <div class="cf-dest-glance">
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Best months</span>
              <span class="cf-dest-fact-value">${escapeHtml(monthNames(dest.best_months) || "Ask Paul")}</span>
            </div>
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Typical cruise length</span>
              <span class="cf-dest-fact-value">${escapeHtml(cruiseLengthLabel(dest))}</span>
            </div>
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Typical weather</span>
              <span class="cf-dest-fact-value">${escapeHtml(dest.typical_weather || "Varies by season")}</span>
            </div>
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Common departure ports</span>
              <span class="cf-dest-fact-value">${escapeHtml(departures.slice(0, 4).join(" · ") || "Varies by itinerary")}</span>
            </div>
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Best suited to</span>
              <span class="cf-dest-fact-value">${escapeHtml(content.suited_to || "A wide range of travellers")}</span>
            </div>
            <div class="cf-dest-fact">
              <span class="cf-dest-fact-label">Long-haul or closer to home</span>
              <span class="cf-dest-fact-value">${escapeHtml(content.proximity || "Depends on your home port")}</span>
            </div>
          </div>
        </section>

        <section class="cf-dest-section">
          <h2 class="cf-dest-section-title">Why cruise here</h2>
          <ul class="cf-dest-reasons">
            ${reasons
              .slice(0, 5)
              .map((r) => `<li>${escapeHtml(r)}</li>`)
              .join("")}
          </ul>
        </section>

        <section class="cf-dest-section">
          <h2 class="cf-dest-section-title">Popular ports</h2>
          <p class="cf-dest-lead">Key stops commonly featured on ${escapeHtml(dest.name)} itineraries.</p>
          <div class="cf-dest-chips">
            ${ports.map((p) => `<span class="cf-dest-chip">${escapeHtml(p)}</span>`).join("")}
          </div>
        </section>

        <section class="cf-dest-section">
          <h2 class="cf-dest-section-title">Cruise lines</h2>
          <p class="cf-dest-lead">Cruise lines sold by 101cruise that commonly sail this region.</p>
          <div class="cf-dest-chips">
            ${
              lines.length
                ? lines.map((l) => `<span class="cf-dest-chip">${escapeHtml(l)}</span>`).join("")
                : `<span class="cf-dest-chip">Ask Paul for today’s best options</span>`
            }
          </div>
        </section>

        <section class="cf-dest-section">
          <h2 class="cf-dest-section-title">Seasonal advice</h2>
          <div class="cf-dest-season">
            <div class="cf-dest-season-item">
              <strong>Best period</strong>
              <p>${escapeHtml(advice.best || "Ask Paul for the best window for your dates.")}</p>
            </div>
            <div class="cf-dest-season-item">
              <strong>Shoulder season</strong>
              <p>${escapeHtml(advice.shoulder || "Shoulder months can still work with careful planning.")}</p>
            </div>
            <div class="cf-dest-season-item">
              <strong>Fewer sailings</strong>
              <p>${escapeHtml(advice.quieter || "Some months have fewer itineraries.")}</p>
            </div>
            <div class="cf-dest-season-item">
              <strong>Weather to note</strong>
              <p>${escapeHtml(advice.weather || dest.typical_weather || "")}</p>
            </div>
          </div>
        </section>

        <section class="cf-dest-cta">
          <button type="button" class="cf-dest-cta-btn" data-find-cruises>Find Current Cruises</button>
          <p class="cf-dest-cta-note">We’ll search for current sailings that match your dates and preferences.</p>
          <p class="cf-dest-placeholder" hidden data-search-placeholder>
            Live cruise search is the next phase. For today’s availability and best price, ask Paul — no prices are shown in this preview.
          </p>
        </section>
      </div>`;

    const media = mount.querySelector(".cf-dest-media");
    const img = media && media.querySelector("img");
    if (media && img && imageUrl) {
      img.addEventListener(
        "load",
        () => {
          media.classList.add("is-loaded");
        },
        { once: true }
      );
      img.addEventListener(
        "error",
        () => {
          media.classList.add("is-fallback");
        },
        { once: true }
      );
      img.src = imageUrl;
      if (img.complete && img.naturalWidth > 0) media.classList.add("is-loaded");
    } else if (media) {
      media.classList.add("is-fallback");
    }

    const findBtn = mount.querySelector("[data-find-cruises]");
    const placeholder = mount.querySelector("[data-search-placeholder]");
    if (findBtn && placeholder) {
      findBtn.addEventListener("click", () => {
        placeholder.hidden = false;
        findBtn.setAttribute("aria-expanded", "true");
      });
    }
  }

  function init() {
    mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (mount.dataset.cfDestInit === "1") return;
    mount.dataset.cfDestInit = "1";

    const params = queryParams();
    const slug = params.get("destination") || params.get("d") || "";
    if (!slug) {
      renderError("Choose a destination from Cruise Finder to continue.");
      return;
    }

    const dest = findDestination(slug);
    if (!dest) {
      renderError("We couldn’t find that destination. Please return to Cruise Finder and try again.");
      return;
    }

    const prefs = mergePrefs(prefsFromUrl(params), readSessionPrefs());
    render(dest, prefs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
