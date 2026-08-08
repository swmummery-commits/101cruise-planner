/**
 * 101cruise Cruise Finder — Destination Detail + live cruise search results.
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
  const PAUL_ENQUIRY_EMAIL = "paul@101cruise.com.au";
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

  const BUDGET_LABELS = {
    "under-3k": "Under $3,000 pp",
    "3-5k": "$3,000 – $5,000 pp",
    "5-8k": "$5,000 – $8,000 pp",
    "8k-plus": "$8,000+ pp",
    no_budget: "No budget yet"
  };

  const MATCH_LABELS = {
    top: "My Top Recommendation",
    excellent: "Excellent Match",
    option: "Another Great Option",
    worth: "Worth Considering"
  };

  const LOADING_MESSAGES = [
    "Hang tight! Just getting your info.",
    "Searching current cruise listings…",
    "Checking cruise-line listings…",
    "Reviewing matching sailings…",
    "Removing duplicate results…"
  ];

  let mount = null;
  let currentDest = null;
  let currentPrefs = null;
  let searchAbort = null;
  let searchInFlight = false;
  let loadingTimer = null;

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

  function toolBaseUrl() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).href.replace(/[^/]+$/, "");
      } catch (_error) {
        /* ignore */
      }
    }
    const scripts = document.querySelectorAll('script[src*="cruise-finder/destination.js"]');
    const last = scripts[scripts.length - 1];
    if (last && last.src) {
      try {
        return new URL(last.src).href.replace(/[^/]+$/, "");
      } catch (_error) {
        /* ignore */
      }
    }
    return `${NETLIFY_ORIGIN}/public-tools/cruise-finder/`;
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.cfLoaded === "1") {
          resolve();
          return;
        }
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
          once: true
        });
        return;
      }
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => {
        el.dataset.cfLoaded = "1";
        resolve();
      };
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  async function ensureImagePipeline() {
    const base = toolBaseUrl();
    if (typeof window.CruiseFinderPickDestinationImage !== "function") {
      await loadScriptOnce(`${base}destination-images.js`);
    }
    if (!window.CruiseFinderHeroImages) {
      await loadScriptOnce(`${base}hero-images.js`);
    }
  }

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

  function approvedLinesFor(dest) {
    const filterLines =
      typeof window.CruiseFinderFilterCruiseLines === "function"
        ? window.CruiseFinderFilterCruiseLines
        : function (names) {
            return Array.isArray(names) ? names : [];
          };
    return filterLines(dest.typical_cruise_lines || []);
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
      bits.push(
        `Sailings here commonly fall around ${cruiseLengthLabel(dest)}, close to a ${duration.toLowerCase()} holiday.`
      );
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

  function searchEndpoint() {
    return `${TOOLS_ORIGIN}/.netlify/functions/search-current-cruises`;
  }

  function stopLoadingMessages() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function displayValue(value) {
    if (value == null || value === "") return "Not confirmed";
    return String(value);
  }

  function buildPaulMailto(result, dest, prefs) {
    const shipBit =
      result.ship && result.ship !== "Not confirmed" ? result.ship : result.cruiseLine || "Cruise";
    const dateBit =
      result.departureDate && result.departureDate !== "Not confirmed"
        ? result.departureDate
        : travelWindowLabel(prefs) || "dates TBC";
    const subject = `Cruise Finder enquiry – ${shipBit} – ${dest.name} – ${dateBit}`;

    const styles = (prefs.styles || [])
      .map((id) => STYLE_LABELS[id] || id)
      .filter(Boolean)
      .join(", ");

    const body = [
      "Hi Paul,",
      "",
      "I found this cruise using the 101cruise Cruise Finder.",
      "",
      "Could you please check the current availability and your best price?",
      "",
      `Destination: ${dest.name}`,
      `Cruise line: ${displayValue(result.cruiseLine)}`,
      `Ship: ${displayValue(result.ship)}`,
      `Departure date: ${displayValue(result.departureDate)}`,
      `Duration: ${displayValue(result.durationLabel || (result.durationNights ? result.durationNights + " nights" : null))}`,
      `Departure port: ${displayValue(result.departurePort)}`,
      `Itinerary: ${displayValue(result.itineraryTitle)}`,
      `Source URL: ${displayValue(result.sourceUrl)}`,
      "",
      "My Cruise Finder preferences:",
      `Travel dates/month: ${travelWindowLabel(prefs) || "Not specified"}`,
      `Preferred duration: ${DURATION_LABELS[prefs.durationId] || "Not specified"}`,
      `Departure city: ${DEPARTURE_LABELS[prefs.departure] || "Not specified"}`,
      `Holiday styles: ${styles || "Not specified"}`,
      `Budget selection: ${BUDGET_LABELS[prefs.budgetId] || "Not specified"}`,
      "",
      "Thank you."
    ].join("\n");

    return `mailto:${PAUL_ENQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function generalPaulMailto(dest, prefs) {
    const subject = `Cruise Finder enquiry – ${dest.name} – ${travelWindowLabel(prefs) || "dates TBC"}`;
    const styles = (prefs.styles || [])
      .map((id) => STYLE_LABELS[id] || id)
      .filter(Boolean)
      .join(", ");
    const body = [
      "Hi Paul,",
      "",
      "I used the 101cruise Cruise Finder and would like help finding a suitable sailing.",
      "",
      `Destination: ${dest.name}`,
      `Travel dates/month: ${travelWindowLabel(prefs) || "Not specified"}`,
      `Preferred duration: ${DURATION_LABELS[prefs.durationId] || "Not specified"}`,
      `Departure city: ${DEPARTURE_LABELS[prefs.departure] || "Not specified"}`,
      `Holiday styles: ${styles || "Not specified"}`,
      `Budget selection: ${BUDGET_LABELS[prefs.budgetId] || "Not specified"}`,
      "",
      "Thank you."
    ].join("\n");
    return `mailto:${PAUL_ENQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function resultCardHtml(result, dest, prefs) {
    const ports =
      Array.isArray(result.portsOfCall) && result.portsOfCall.length
        ? `<div class="cf-sail-row"><span class="cf-sail-label">Ports</span><span class="cf-sail-value">${escapeHtml(result.portsOfCall.join(" · "))}</span></div>`
        : "";
    const departureNote = result.departureNote
      ? `<p class="cf-sail-departure-note">${escapeHtml(result.departureNote)}</p>`
      : "";

    return `
      <article class="cf-sail-card">
        <div class="cf-sail-top">
          <p class="cf-sail-line">${escapeHtml(displayValue(result.cruiseLine))}</p>
          <span class="cf-sail-status">${escapeHtml(result.statusLabel || "Currently listed online")}</span>
        </div>
        <h3 class="cf-sail-ship">${escapeHtml(displayValue(result.ship))}</h3>
        <p class="cf-sail-summary">${escapeHtml(displayValue(result.itineraryTitle))}</p>
        ${departureNote}
        <div class="cf-sail-grid">
          <div class="cf-sail-row"><span class="cf-sail-label">Departure</span><span class="cf-sail-value">${escapeHtml(displayValue(result.departureDate))}</span></div>
          <div class="cf-sail-row"><span class="cf-sail-label">Duration</span><span class="cf-sail-value">${escapeHtml(displayValue(result.durationLabel))}</span></div>
          <div class="cf-sail-row"><span class="cf-sail-label">From</span><span class="cf-sail-value">${escapeHtml(displayValue(result.departurePort))}</span></div>
          <div class="cf-sail-row"><span class="cf-sail-label">Region</span><span class="cf-sail-value">${escapeHtml(displayValue(result.destination || dest.name))}</span></div>
          ${ports}
          <div class="cf-sail-row"><span class="cf-sail-label">Source</span><span class="cf-sail-value"><a class="cf-sail-source" href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayValue(result.sourceName))}</a></span></div>
          <div class="cf-sail-row"><span class="cf-sail-label">Date searched</span><span class="cf-sail-value">${escapeHtml(displayValue(result.dateSearched))}</span></div>
        </div>
        <a class="cf-sail-ask" href="${escapeHtml(buildPaulMailto(result, dest, prefs))}">Ask Paul for current availability and best price</a>
      </article>`;
  }

  function renderError(message) {
    mount.innerHTML = `
      <div class="cf-dest">
        <p class="cf-dest-error">${escapeHtml(message)}</p>
        <p style="text-align:center;"><a class="cf-dest-back" href="${escapeHtml(finderBackUrl())}">← Back to Cruise Finder</a></p>
      </div>`;
  }

  async function renderExperience(dest, prefs) {
    currentDest = dest;
    currentPrefs = prefs;

    if (!window.DestinationExperienceApp) {
      renderError("The destination experience could not be loaded. Please refresh and try again.");
      return;
    }

    mount.classList.add("dx-shell");
    document.body.classList.add("dx-shell");

    try {
      await window.DestinationExperienceApp.boot({
        mount: mount,
        slug: dest.id,
        cruiseFinder: true,
        prefs: prefs,
        finderBackHref: finderBackUrl(),
        onFindCruises: function () {
          runSearch({ forceRefresh: false });
        }
      });
    } catch (error) {
      console.error("Cruise Finder destination experience failed", error);
      renderError("We couldn’t load this destination page just now. Please refresh and try again.");
    }
  }

  function renderLoading() {
    const boxes =
      typeof BrandLoading !== "undefined" && BrandLoading.html
        ? BrandLoading.html({ large: true, className: "cf-search-loading-spinner" })
        : '<span class="brand-loading-boxes brand-loading-boxes--large" aria-hidden="true">' +
          new Array(10).join("<span></span>") +
          "</span>";
    mount.innerHTML = `
      <div class="cf-dest cf-search">
        <div class="cf-search-nav">
          <button type="button" class="cf-dest-back cf-search-linkbtn" data-back-destination>← Back to destination</button>
        </div>
        <section class="cf-search-loading brand-loading-panel cf-search-loading-panel" aria-live="polite">
          ${boxes}
          <p class="brand-loading-message cf-search-loading-title" data-loading-title>${escapeHtml(LOADING_MESSAGES[0])}</p>
        </section>
      </div>`;
    if (typeof BrandLoading?.scan === "function") BrandLoading.scan(mount);

    const back = mount.querySelector("[data-back-destination]");
    if (back) {
      back.addEventListener("click", () => {
        if (searchAbort) searchAbort.abort();
        stopLoadingMessages();
        searchInFlight = false;
        renderExperience(currentDest, currentPrefs);
      });
    }

    let idx = 0;
    stopLoadingMessages();
    loadingTimer = setInterval(() => {
      idx = (idx + 1) % LOADING_MESSAGES.length;
      const el = mount.querySelector("[data-loading-title]");
      if (el) el.textContent = LOADING_MESSAGES[idx];
    }, 1800);
  }

  function renderSearchError(message) {
    stopLoadingMessages();
    mount.innerHTML = `
      <div class="cf-dest cf-search">
        <div class="cf-search-nav">
          <button type="button" class="cf-dest-back cf-search-linkbtn" data-back-destination>← Back to destination</button>
          <a class="cf-search-link" href="${escapeHtml(finderBackUrl())}">Refine my search</a>
        </div>
        <section class="cf-search-state">
          <h2 class="cf-dest-section-title">We couldn’t complete the live search just now.</h2>
          <p class="cf-dest-lead">${escapeHtml(message || "Please try again in a moment.")}</p>
          <div class="cf-search-actions">
            <button type="button" class="cf-dest-cta-btn" data-search-again>Try again</button>
            <a class="cf-search-secondary" href="${escapeHtml(generalPaulMailto(currentDest, currentPrefs))}">Ask Paul directly</a>
          </div>
        </section>
      </div>`;
    bindSearchControls({ forceRefresh: true });
  }

  function renderEmpty(payload) {
    stopLoadingMessages();
    const summary = payload?.departureSummary || {};
    const apiMessage = String(payload?.message || "").trim();
    const catalogueStatus = String(payload?.catalogueStatus || "").trim();
    const lead =
      apiMessage ||
      (catalogueStatus === "no_destination"
        ? `We do not have verified sailings for ${currentDest?.name || "this destination"} in the catalogue yet. Discovery is live for Alaska today.`
        : catalogueStatus === "filtered_out"
          ? "Sailings exist for this destination, but none matched your selected dates, duration, or departure preferences."
          : "Once Discovery has catalogue rows for this destination, complete sailings will appear here. You can also broaden dates/duration or ask Paul directly.");
    const hints =
      catalogueStatus === "no_destination"
        ? [
            "Try Alaska — our live verified catalogue destination today",
            "Broaden your travel dates or choose flexible timing",
            "Choose “I'll fly anywhere” for departure",
            "Ask Paul for a tailored shortlist"
          ]
        : [
            "Broaden your travel dates",
            "Choose a flexible cruise length",
            "Change your departure point to “I'll fly anywhere”",
            "Ask Paul for a tailored shortlist"
          ];

    mount.innerHTML = `
      <div class="cf-dest cf-search">
        <div class="cf-search-nav">
          <button type="button" class="cf-dest-back cf-search-linkbtn" data-back-destination>← Back to destination</button>
          <a class="cf-search-link" href="${escapeHtml(finderBackUrl())}">Refine my search</a>
        </div>
        <section class="cf-search-state">
          <h2 class="cf-dest-section-title">We couldn’t find matching verified sailings for these exact preferences.</h2>
          <p class="cf-dest-lead">${escapeHtml(lead)}</p>
          ${
            summary.message && !apiMessage
              ? `<p class="cf-dest-lead">${escapeHtml(summary.message)}</p>`
              : ""
          }
          <ul class="cf-search-hints">
            ${hints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join("")}
          </ul>
          <div class="cf-search-actions">
            <button type="button" class="cf-dest-cta-btn" data-search-again>Search again</button>
            <a class="cf-search-secondary" href="${escapeHtml(generalPaulMailto(currentDest, currentPrefs))}">Ask Paul directly</a>
          </div>
        </section>
      </div>`;
    bindSearchControls({ forceRefresh: true });
  }

  function isCompleteSailing(result) {
    const missing = (value) => {
      const s = String(value || "").trim();
      return !s || /^not confirmed$/i.test(s);
    };
    return (
      !missing(result?.cruiseLine) &&
      !missing(result?.ship) &&
      !missing(result?.itineraryTitle) &&
      !missing(result?.departureDate) &&
      (Number(result?.durationNights) > 0 || !missing(result?.durationLabel)) &&
      !missing(result?.departurePort) &&
      !missing(result?.sourceUrl)
    );
  }

  function sailingDepartureTimestamp(result) {
    const iso = result?.departureDateIso;
    if (iso) {
      const text = String(iso).trim();
      const parsed = Date.parse(text.includes("T") ? text : `${text}T00:00:00Z`);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const display = String(result?.departureDate || "").trim();
    if (display) {
      const parsed = Date.parse(display);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function sortSailingsChronologically(list) {
    return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
      const byDate = sailingDepartureTimestamp(a) - sailingDepartureTimestamp(b);
      if (byDate !== 0) return byDate;
      const byLine = String(a.cruiseLine || "").localeCompare(String(b.cruiseLine || ""), "en", {
        sensitivity: "base"
      });
      if (byLine !== 0) return byLine;
      return String(a.ship || "").localeCompare(String(b.ship || ""), "en", { sensitivity: "base" });
    });
  }

  function renderResults(payload) {
    stopLoadingMessages();
    const bestMatch = sortSailingsChronologically(
      (Array.isArray(payload.results) ? payload.results : []).filter(isCompleteSailing)
    );
    const alsoWorth = sortSailingsChronologically(
      (Array.isArray(payload.alsoWorthConsidering) ? payload.alsoWorthConsidering : []).filter(isCompleteSailing)
    );
    const alternatives = sortSailingsChronologically(
      (Array.isArray(payload.otherResults) ? payload.otherResults : []).filter(isCompleteSailing)
    );
    const summary = payload.departureSummary || {};
    const totalCount = bestMatch.length + alsoWorth.length + alternatives.length;

    if (!totalCount) {
      renderEmpty(payload);
      return;
    }

    const sections = [];

    if (summary.message && !bestMatch.length) {
      sections.push(`
        <section class="cf-search-state cf-search-state-inline">
          <h2 class="cf-dest-section-title">${escapeHtml(summary.message)}</h2>
          <p class="cf-dest-lead">You can adjust your search or review the alternatives below.</p>
          <ul class="cf-search-hints">
            <li>Adjust your dates</li>
            <li>Increase or remove the budget limit</li>
            <li>Consider another Australian departure port</li>
            <li>View cruises requiring flights below</li>
          </ul>
        </section>`);
    }

    if (bestMatch.length) {
      if (summary.flexible) {
        sections.push(`
        <section class="cf-dest-section cf-search-intro">
          <h2 class="cf-dest-section-title">Current Cruises We Found</h2>
          <p class="cf-dest-lead">These sailings come from the 101cruise Discovery catalogue (verified from official cruise line sources). Itineraries and availability can change.</p>
        </section>
        <div class="cf-sail-list">${bestMatch.map((r) => resultCardHtml(r, currentDest, currentPrefs)).join("")}</div>`);
      } else {
        sections.push(`
        <section class="cf-dest-section cf-search-intro">
          <h2 class="cf-dest-section-title">Best Match</h2>
          <p class="cf-dest-lead">These sailings depart from ${escapeHtml(summary.selectedLabel || "your chosen port")} and match your other preferences.</p>
        </section>
        <div class="cf-sail-list">${bestMatch.map((r) => resultCardHtml(r, currentDest, currentPrefs)).join("")}</div>`);
      }
    }

    if (alsoWorth.length) {
      sections.push(`
        <section class="cf-dest-section cf-search-intro">
          <h2 class="cf-dest-section-title">Also Worth Considering</h2>
          <p class="cf-dest-lead">Another relevant cruise from a nearby or same-country departure port.</p>
        </section>
        <div class="cf-sail-list">${alsoWorth.map((r) => resultCardHtml(r, currentDest, currentPrefs)).join("")}</div>`);
    }

    if (alternatives.length) {
      sections.push(`
        <section class="cf-dest-section cf-search-intro">
          <h2 class="cf-dest-section-title">Alternative Option</h2>
          <p class="cf-dest-lead">These sailings depart from a different port and may require flights or additional travel.</p>
        </section>
        <div class="cf-sail-list">${alternatives.map((r) => resultCardHtml(r, currentDest, currentPrefs)).join("")}</div>`);
    }

    if (!bestMatch.length && !summary.message && !summary.flexible) {
      sections.unshift(`
        <section class="cf-dest-section cf-search-intro">
          <h2 class="cf-dest-section-title">Current Cruises We Found</h2>
          <p class="cf-dest-lead">These sailings come from the 101cruise Discovery catalogue (verified from official cruise line sources). Itineraries and availability can change.</p>
        </section>`);
    }

    mount.innerHTML = `
      <div class="cf-dest cf-search">
        <div class="cf-search-nav">
          <button type="button" class="cf-dest-back cf-search-linkbtn" data-back-destination>← Back to destination</button>
          <a class="cf-search-link" href="${escapeHtml(finderBackUrl())}">Refine my search</a>
        </div>
        ${sections.join("")}
        <div class="cf-search-actions cf-search-actions-bottom">
          <button type="button" class="cf-dest-cta-btn" data-search-again>Search again</button>
        </div>
      </div>`;

    bindSearchControls({ forceRefresh: true });
  }

  function bindSearchControls(options) {
    const back = mount.querySelector("[data-back-destination]");
    if (back) {
      back.addEventListener("click", () => {
        if (searchAbort) searchAbort.abort();
        stopLoadingMessages();
        searchInFlight = false;
        renderExperience(currentDest, currentPrefs);
      });
    }
    const again = mount.querySelector("[data-search-again]");
    if (again) {
      again.addEventListener("click", () => {
        runSearch({ forceRefresh: !!(options && options.forceRefresh) });
      });
    }
  }

  async function runSearch(options) {
    if (!currentDest || !currentPrefs) return;
    if (searchInFlight) return;

    searchInFlight = true;
    renderLoading();

    if (searchAbort) searchAbort.abort();
    searchAbort = typeof AbortController !== "undefined" ? new AbortController() : null;

    const payload = {
      destination: currentDest.id,
      destinationName: currentDest.name,
      timingMode: currentPrefs.timingMode || "",
      month: currentPrefs.month ? Number(currentPrefs.month) : null,
      year: currentPrefs.year ? Number(currentPrefs.year) : null,
      startDate: currentPrefs.startDate || null,
      endDate: currentPrefs.endDate || null,
      durationId: currentPrefs.durationId || null,
      departure: currentPrefs.departure || null,
      styles: currentPrefs.styles || [],
      cruiseLines: approvedLinesFor(currentDest),
      forceRefresh: !!(options && options.forceRefresh)
    };

    try {
      const response = await fetch(searchEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: searchAbort ? searchAbort.signal : undefined
      });

      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }

      searchInFlight = false;

      if (!response.ok || !data || data.ok === false) {
        const message =
          (data && data.message) ||
          (data && data.error === "configuration"
            ? "Live cruise search is not configured yet."
            : "We couldn’t complete the live search just now.");
        renderSearchError(message);
        return;
      }

      renderResults(data);
    } catch (error) {
      searchInFlight = false;
      if (error && error.name === "AbortError") return;
      renderSearchError("We couldn’t complete the live search just now.");
    }
  }

  async function init() {
    mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (mount.dataset.cfDestInit === "1") return;
    mount.dataset.cfDestInit = "1";

    try {
      await ensureImagePipeline();
    } catch (error) {
      console.warn("Cruise Finder destination image pipeline could not load", error);
    }

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
    await renderExperience(dest, prefs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
