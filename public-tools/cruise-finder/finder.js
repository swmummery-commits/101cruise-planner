/**
 * 101cruise Cruise Finder — guided destination discovery (Phase 7A).
 *
 * Mounts into: <div id="101cruise-cruise-finder"></div>
 * Rule-based recommendations from local seed data only.
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-cruise-finder";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const SCRIPT_EL = document.currentScript;

  const DURATION_OPTIONS = [
    { id: "3-5", label: "3–5 nights", min: 3, max: 5 },
    { id: "6-9", label: "6–9 nights", min: 6, max: 9 },
    { id: "10-14", label: "10–14 nights", min: 10, max: 14 },
    { id: "15-21", label: "15–21 nights", min: 15, max: 21 },
    { id: "22-plus", label: "22+ nights", min: 22, max: 40 },
    { id: "flexible", label: "Flexible", min: null, max: null }
  ];

  const TRAVELLER_OPTIONS = [
    { id: "solo", label: "Solo" },
    { id: "couple", label: "Couple" },
    { id: "family", label: "Family" },
    { id: "friends", label: "Friends" },
    { id: "group", label: "Group" }
  ];

  const STYLE_OPTIONS = [
    { id: "relaxing", label: "Relaxing" },
    { id: "warm_weather", label: "Warm weather" },
    { id: "cool_climate", label: "Cool climate" },
    { id: "scenic", label: "Scenic" },
    { id: "food_wine", label: "Food & wine" },
    { id: "culture", label: "Culture" },
    { id: "adventure", label: "Adventure" },
    { id: "luxury", label: "Luxury" },
    { id: "family", label: "Family" },
    { id: "expedition", label: "Expedition" }
  ];

  const DEPARTURE_SUGGESTIONS = [
    "Perth",
    "Sydney",
    "Melbourne",
    "Brisbane",
    "Adelaide",
    "Auckland",
    "Other"
  ];

  const FLEX_PERIODS = [
    { id: "3m", label: "Next 3 months", months: 3 },
    { id: "6m", label: "Next 6 months", months: 6 },
    { id: "12m", label: "Next 12 months", months: 12 },
    { id: "any", label: "Any time", months: null }
  ];

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

  const state = {
    timingMode: "",
    startDate: "",
    endDate: "",
    month: "",
    year: "",
    flexPeriod: "",
    durationId: "",
    departure: "",
    traveller: "",
    styles: [],
    budgetMin: "",
    budgetMax: "",
    results: [],
    exploredId: ""
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
    const scripts = document.querySelectorAll('script[src*="cruise-finder/finder.js"]');
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
      .replaceAll("'", "&#039;");
  }

  function destinations() {
    const rows = Array.isArray(window.CruiseFinderDestinations)
      ? window.CruiseFinderDestinations
      : [];
    return rows.filter(row => row && row.active !== false);
  }

  function slugDeparture(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function currentYear() {
    return new Date().getFullYear();
  }

  function yearOptions() {
    const y = currentYear();
    return [y, y + 1, y + 2];
  }

  function resolveTravelMonths() {
    const months = new Set();

    if (state.timingMode === "exact" && state.startDate) {
      const start = new Date(`${state.startDate}T00:00:00`);
      const end = state.endDate
        ? new Date(`${state.endDate}T00:00:00`)
        : new Date(start);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        const last = new Date(end.getFullYear(), end.getMonth(), 1);
        while (cursor <= last) {
          months.add(cursor.getMonth() + 1);
          cursor.setMonth(cursor.getMonth() + 1);
        }
      }
    } else if (state.timingMode === "month" && state.month) {
      months.add(Number(state.month));
    } else if (state.timingMode === "flexible") {
      if (state.flexPeriod === "any" || !state.flexPeriod) {
        return { months: [], anyTime: true };
      }
      const period = FLEX_PERIODS.find(row => row.id === state.flexPeriod);
      const count = period && period.months ? period.months : 12;
      const now = new Date();
      for (let i = 0; i < count; i += 1) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.add(d.getMonth() + 1);
      }
    }

    return { months: Array.from(months), anyTime: false };
  }

  function durationRange() {
    return DURATION_OPTIONS.find(row => row.id === state.durationId) || null;
  }

  function monthListLabel(monthNumbers) {
    if (!monthNumbers || !monthNumbers.length) return "Flexible";
    return monthNumbers
      .slice()
      .sort((a, b) => a - b)
      .map(n => MONTH_NAMES[n - 1])
      .join(", ");
  }

  function typicalLengthLabel(dest) {
    if (dest.typical_nights_min === dest.typical_nights_max) {
      return `${dest.typical_nights_min} nights`;
    }
    return `${dest.typical_nights_min}–${dest.typical_nights_max} nights`;
  }

  /**
   * Transparent rule-based scoring.
   * Timing up to 40, duration 20, traveller 15, styles 20, departure 5, climate boost 5.
   */
  function scoreDestination(dest, travel) {
    let score = 0;
    const reasons = [];
    let seasonStatus = "ideal";

    if (travel.anyTime) {
      score += 28;
      reasons.push("Your timing is flexible, so seasonal fit is open.");
      seasonStatus = "flexible";
    } else {
      const bestHit = travel.months.some(m => dest.best_months.includes(m));
      const okHit = travel.months.some(m => dest.acceptable_months.includes(m));
      if (bestHit) {
        score += 40;
        reasons.push("Your travel window aligns with the best months for this destination.");
        seasonStatus = "ideal";
      } else if (okHit) {
        score += 22;
        reasons.push("Your dates fall in an acceptable season, though not the absolute peak.");
        seasonStatus = "acceptable";
      } else {
        score += 8;
        reasons.push(
          `Your dates sit outside the usual season (${monthListLabel(dest.best_months)} is best).`
        );
        seasonStatus = "off";
      }
    }

    const duration = durationRange();
    if (!duration || duration.id === "flexible") {
      score += 12;
      reasons.push("Cruise length is flexible.");
    } else {
      const overlaps =
        duration.max >= dest.typical_nights_min && duration.min <= dest.typical_nights_max;
      const adjacent =
        duration.max + 2 >= dest.typical_nights_min && duration.min - 2 <= dest.typical_nights_max;
      if (overlaps) {
        score += 20;
        reasons.push(`Typical sailings of ${typicalLengthLabel(dest)} suit your preferred length.`);
      } else if (adjacent) {
        score += 10;
        reasons.push(`Typical length (${typicalLengthLabel(dest)}) is close to what you want.`);
      } else {
        score += 4;
        reasons.push(`Most itineraries run ${typicalLengthLabel(dest)}, which differs from your preference.`);
      }
    }

    if (state.traveller && dest.suitable_travellers.includes(state.traveller)) {
      score += 15;
      reasons.push("It suits the way you prefer to travel.");
    } else if (state.traveller) {
      score += 5;
    } else {
      score += 8;
    }

    if (state.styles.length) {
      const matches = state.styles.filter(style => dest.suitable_styles.includes(style));
      const styleScore = Math.min(20, matches.length * 5);
      score += styleScore;
      if (matches.length) {
        const labels = matches
          .map(id => STYLE_OPTIONS.find(row => row.id === id)?.label || id)
          .slice(0, 3);
        reasons.push(`Matches your interest in ${labels.join(", ").toLowerCase()}.`);
      }
    } else {
      score += 10;
    }

    const dep = slugDeparture(state.departure);
    if (!dep || dep === "other") {
      score += 3;
    } else if (dest.departure_markets.includes(dep) || dest.departure_markets.includes("other")) {
      score += 5;
      reasons.push("It is commonly offered from your side of the world.");
    } else {
      score += 2;
    }

    if (state.styles.includes("warm_weather") && dest.preferred_climate === "warm") {
      score += 5;
    }
    if (state.styles.includes("cool_climate") && dest.preferred_climate === "cool") {
      score += 5;
    }

    return {
      destination: dest,
      score,
      reasons: reasons.slice(0, 3),
      seasonStatus
    };
  }

  function buildRecommendations() {
    const travel = resolveTravelMonths();
    const ranked = destinations()
      .map(dest => scoreDestination(dest, travel))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.destination.display_order - b.destination.display_order
      );

    const labelled = ranked.slice(0, 6).map((row, index) => {
      let label = "Alternative Option";
      if (index === 0) label = "Best Match";
      else if (index === 1 || index === 2) label = "Also Worth Considering";
      return { ...row, label };
    });

    return labelled;
  }

  function stepReady(step) {
    if (step === 1) {
      if (!state.timingMode) return false;
      if (state.timingMode === "exact") return Boolean(state.startDate);
      if (state.timingMode === "month") return Boolean(state.month && state.year);
      if (state.timingMode === "flexible") return Boolean(state.flexPeriod);
      return false;
    }
    if (step === 2) return Boolean(state.durationId);
    if (step === 3) return Boolean(String(state.departure || "").trim());
    if (step === 4) return Boolean(state.traveller);
    if (step === 5) return true;
    return true;
  }

  function canSubmit() {
    return stepReady(1) && stepReady(2) && stepReady(3) && stepReady(4);
  }

  function choiceButtons(options, selectedId, dataAttr) {
    return options
      .map(option => {
        const selected = selectedId === option.id ? "is-selected" : "";
        return `<button type="button" class="cf-choice ${selected}" data-${dataAttr}="${escapeHtml(
          option.id
        )}">${escapeHtml(option.label)}</button>`;
      })
      .join("");
  }

  function renderTimingDetails() {
    if (state.timingMode === "exact") {
      return `
        <div class="cf-fields is-2">
          <div class="cf-field">
            <label for="cf-start-date">Start date</label>
            <input id="cf-start-date" type="date" value="${escapeHtml(state.startDate)}">
          </div>
          <div class="cf-field">
            <label for="cf-end-date">End date</label>
            <input id="cf-end-date" type="date" value="${escapeHtml(state.endDate)}">
          </div>
        </div>
      `;
    }

    if (state.timingMode === "month") {
      return `
        <div class="cf-fields is-2">
          <div class="cf-field">
            <label for="cf-month">Month</label>
            <select id="cf-month">
              <option value="">Select month</option>
              ${MONTH_NAMES.map(
                (name, index) =>
                  `<option value="${index + 1}" ${
                    String(state.month) === String(index + 1) ? "selected" : ""
                  }>${escapeHtml(name)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="cf-field">
            <label for="cf-year">Year</label>
            <select id="cf-year">
              <option value="">Select year</option>
              ${yearOptions()
                .map(
                  year =>
                    `<option value="${year}" ${
                      String(state.year) === String(year) ? "selected" : ""
                    }>${year}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>
      `;
    }

    if (state.timingMode === "flexible") {
      return `
        <div class="cf-choice-grid" style="margin-top:16px">
          ${choiceButtons(FLEX_PERIODS, state.flexPeriod, "flex")}
        </div>
      `;
    }

    return "";
  }

  function renderResults() {
    if (!state.results.length) {
      return `
        <section class="cf-results" id="cf-results">
          <div class="cf-empty">Adjust your answers and try again to see destination ideas.</div>
        </section>
      `;
    }

    const exploreNote = state.exploredId
      ? (() => {
          const found = state.results.find(row => row.destination.id === state.exploredId);
          const name = found ? found.destination.name : "this destination";
          return `<p class="cf-explore-note">You’ve chosen to explore <strong>${escapeHtml(
            name
          )}</strong>. Live sailing search and ship details will connect here in a later phase — for now, these recommendations are your starting point.</p>`;
        })()
      : "";

    return `
      <section class="cf-results" id="cf-results">
        <div class="cf-results-header">
          <h2>Where you could cruise</h2>
          <p>Based on when you can travel and the kind of holiday you enjoy — not a live booking search.</p>
        </div>
        <div class="cf-result-list">
          ${state.results
            .map(row => {
              const dest = row.destination;
              const seasonNote =
                row.seasonStatus === "off"
                  ? `<p class="cf-season-note">Outside the ideal season — best months are usually ${escapeHtml(
                      monthListLabel(dest.best_months)
                    )}. It can still work, with different weather and fewer sailings.</p>`
                  : row.seasonStatus === "acceptable"
                    ? `<p class="cf-season-note">Acceptable timing — peak months are usually ${escapeHtml(
                        monthListLabel(dest.best_months)
                      )}.</p>`
                    : "";
              return `
                <article class="cf-card" style="--cf-accent:${escapeHtml(dest.accent || "#2f5d4a")}">
                  <div class="cf-card-visual">
                    <span class="cf-badge ${row.label === "Best Match" ? "is-best" : ""}">${escapeHtml(
                      row.label
                    )}</span>
                    <h3>${escapeHtml(dest.name)}</h3>
                  </div>
                  <div class="cf-card-body">
                    <p>${escapeHtml(dest.short_description)}</p>
                    <p>${escapeHtml(row.reasons[0] || dest.recommendation_explanation)}</p>
                    ${seasonNote}
                    <dl class="cf-meta">
                      <div><dt>Typical length</dt><dd>${escapeHtml(typicalLengthLabel(dest))}</dd></div>
                      <div><dt>Best time</dt><dd>${escapeHtml(monthListLabel(dest.best_months))}</dd></div>
                      <div><dt>Why it suits</dt><dd>${escapeHtml(
                        row.reasons.slice(0, 2).join(" ")
                      )}</dd></div>
                    </dl>
                    <div class="cf-card-actions">
                      <button type="button" class="cf-secondary" data-explore="${escapeHtml(
                        dest.id
                      )}">Explore This Destination</button>
                    </div>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
        ${exploreNote}
      </section>
    `;
  }

  function renderApp() {
    const unlocked2 = stepReady(1);
    const unlocked3 = unlocked2 && stepReady(2);
    const unlocked4 = unlocked3 && stepReady(3);
    const unlocked5 = unlocked4 && stepReady(4);
    const unlocked6 = unlocked5;

    mount.innerHTML = `
      <section class="cf-finder" aria-labelledby="cf-finder-title">
        <header class="cf-finder-header">
          <p class="cf-finder-kicker">101cruise</p>
          <h1 class="cf-finder-title" id="cf-finder-title">Cruise Finder</h1>
          <p class="cf-finder-tagline">Tell us when you can travel and we’ll help you discover the best places to cruise at that time.</p>
        </header>

        <section class="cf-step" data-step="1">
          <p class="cf-step-label">Step 1</p>
          <h2 class="cf-step-title">When can you travel?</h2>
          <div class="cf-choice-grid">
            ${choiceButtons(
              [
                { id: "exact", label: "I know my exact dates" },
                { id: "month", label: "I know the month" },
                { id: "flexible", label: "I’m flexible" }
              ],
              state.timingMode,
              "timing"
            )}
          </div>
          ${renderTimingDetails()}
        </section>

        <section class="cf-step ${unlocked2 ? "" : "is-dimmed"}" data-step="2">
          <p class="cf-step-label">Step 2</p>
          <h2 class="cf-step-title">How long would you like to cruise?</h2>
          <div class="cf-choice-grid">
            ${choiceButtons(DURATION_OPTIONS, state.durationId, "duration")}
          </div>
        </section>

        <section class="cf-step ${unlocked3 ? "" : "is-dimmed"}" data-step="3">
          <p class="cf-step-label">Step 3</p>
          <h2 class="cf-step-title">Where will you travel from?</h2>
          <div class="cf-field">
            <label for="cf-departure">Departure city or region</label>
            <input id="cf-departure" type="text" list="cf-departure-list" placeholder="Start typing a city" value="${escapeHtml(
              state.departure
            )}" autocomplete="address-level2">
            <datalist id="cf-departure-list">
              ${DEPARTURE_SUGGESTIONS.map(
                city => `<option value="${escapeHtml(city)}"></option>`
              ).join("")}
            </datalist>
          </div>
          <div class="cf-depart-suggest">
            ${DEPARTURE_SUGGESTIONS.map(
              city =>
                `<button type="button" class="cf-chip ${
                  state.departure === city ? "is-selected" : ""
                }" data-depart="${escapeHtml(city)}">${escapeHtml(city)}</button>`
            ).join("")}
          </div>
          <p class="cf-hint">Suggestions are a starting point — you can enter any city or region.</p>
        </section>

        <section class="cf-step ${unlocked4 ? "" : "is-dimmed"}" data-step="4">
          <p class="cf-step-label">Step 4</p>
          <h2 class="cf-step-title">Who is travelling?</h2>
          <div class="cf-choice-grid">
            ${choiceButtons(TRAVELLER_OPTIONS, state.traveller, "traveller")}
          </div>
        </section>

        <section class="cf-step ${unlocked5 ? "" : "is-dimmed"}" data-step="5">
          <p class="cf-step-label">Step 5</p>
          <h2 class="cf-step-title">What kind of holiday would you enjoy?</h2>
          <div class="cf-chip-grid">
            ${STYLE_OPTIONS.map(style => {
              const selected = state.styles.includes(style.id) ? "is-selected" : "";
              return `<button type="button" class="cf-chip ${selected}" data-style="${escapeHtml(
                style.id
              )}">${escapeHtml(style.label)}</button>`;
            }).join("")}
          </div>
          <p class="cf-hint">Choose as many as you like. Optional, but it improves the match.</p>
        </section>

        <section class="cf-step ${unlocked6 ? "" : "is-dimmed"}" data-step="6">
          <p class="cf-step-label">Step 6</p>
          <h2 class="cf-step-title">Budget <span style="font-weight:500;color:#666">(optional)</span></h2>
          <div class="cf-fields is-2">
            <div class="cf-field">
              <label for="cf-budget-min">Minimum (AUD)</label>
              <input id="cf-budget-min" type="number" min="0" step="500" inputmode="numeric" placeholder="e.g. 3000" value="${escapeHtml(
                state.budgetMin
              )}">
            </div>
            <div class="cf-field">
              <label for="cf-budget-max">Maximum (AUD)</label>
              <input id="cf-budget-max" type="number" min="0" step="500" inputmode="numeric" placeholder="e.g. 8000" value="${escapeHtml(
                state.budgetMax
              )}">
            </div>
          </div>
          <p class="cf-budget-note">Budget is optional in this version and does not filter destinations yet.</p>
        </section>

        <div class="cf-actions">
          <button type="button" class="cf-primary" id="cf-submit" ${
            canSubmit() ? "" : "disabled"
          }>Show Me Where To Cruise</button>
        </div>

        ${state.results.length ? renderResults() : ""}
      </section>
    `;

    bindEvents();
  }

  function bindEvents() {
    mount.querySelectorAll("[data-timing]").forEach(button => {
      button.addEventListener("click", () => {
        state.timingMode = button.getAttribute("data-timing");
        state.results = [];
        renderApp();
      });
    });

    mount.querySelectorAll("[data-flex]").forEach(button => {
      button.addEventListener("click", () => {
        state.flexPeriod = button.getAttribute("data-flex");
        state.results = [];
        renderApp();
      });
    });

    mount.querySelectorAll("[data-duration]").forEach(button => {
      button.addEventListener("click", () => {
        state.durationId = button.getAttribute("data-duration");
        state.results = [];
        renderApp();
      });
    });

    mount.querySelectorAll("[data-traveller]").forEach(button => {
      button.addEventListener("click", () => {
        state.traveller = button.getAttribute("data-traveller");
        state.results = [];
        renderApp();
      });
    });

    mount.querySelectorAll("[data-style]").forEach(button => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-style");
        if (state.styles.includes(id)) {
          state.styles = state.styles.filter(row => row !== id);
        } else {
          state.styles = state.styles.concat(id);
        }
        state.results = [];
        renderApp();
      });
    });

    mount.querySelectorAll("[data-depart]").forEach(button => {
      button.addEventListener("click", () => {
        state.departure = button.getAttribute("data-depart");
        state.results = [];
        renderApp();
      });
    });

    const start = mount.querySelector("#cf-start-date");
    if (start) {
      start.addEventListener("change", () => {
        state.startDate = start.value;
        state.results = [];
        renderApp();
      });
    }
    const end = mount.querySelector("#cf-end-date");
    if (end) {
      end.addEventListener("change", () => {
        state.endDate = end.value;
        state.results = [];
        renderApp();
      });
    }
    const month = mount.querySelector("#cf-month");
    if (month) {
      month.addEventListener("change", () => {
        state.month = month.value;
        state.results = [];
        renderApp();
      });
    }
    const year = mount.querySelector("#cf-year");
    if (year) {
      year.addEventListener("change", () => {
        state.year = year.value;
        state.results = [];
        renderApp();
      });
    }
    const departure = mount.querySelector("#cf-departure");
    if (departure) {
      departure.addEventListener("input", () => {
        state.departure = departure.value;
      });
      departure.addEventListener("change", () => {
        state.departure = departure.value;
        state.results = [];
        renderApp();
      });
    }
    const budgetMin = mount.querySelector("#cf-budget-min");
    if (budgetMin) {
      budgetMin.addEventListener("change", () => {
        state.budgetMin = budgetMin.value;
      });
    }
    const budgetMax = mount.querySelector("#cf-budget-max");
    if (budgetMax) {
      budgetMax.addEventListener("change", () => {
        state.budgetMax = budgetMax.value;
      });
    }

    const submit = mount.querySelector("#cf-submit");
    if (submit) {
      submit.addEventListener("click", () => {
        if (!canSubmit()) return;
        state.exploredId = "";
        state.results = buildRecommendations();
        renderApp();
        const results = mount.querySelector("#cf-results");
        if (results) results.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    mount.querySelectorAll("[data-explore]").forEach(button => {
      button.addEventListener("click", () => {
        state.exploredId = button.getAttribute("data-explore");
        renderApp();
        const note = mount.querySelector(".cf-explore-note");
        if (note) note.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function init() {
    mount =
      document.getElementById(MOUNT_ID) ||
      document.querySelector("[data-cf-finder]") ||
      document.getElementById("cruise-finder");
    if (!mount) {
      console.error("[cruise-finder] Mount element #" + MOUNT_ID + " was not found.");
      return;
    }
    if (mount.getAttribute("data-cf-ready") === "1") return;
    mount.setAttribute("data-cf-ready", "1");

    try {
      renderApp();
    } catch (error) {
      console.error("[cruise-finder] Failed to render", error);
      mount.removeAttribute("data-cf-ready");
      mount.innerHTML =
        '<p style="max-width:760px;margin:0 auto;color:#666;">We couldn’t load Cruise Finder. Please refresh and try again.</p>';
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // Quiet reference so TOOLS_ORIGIN is retained for future Netlify APIs.
  void TOOLS_ORIGIN;
})();
