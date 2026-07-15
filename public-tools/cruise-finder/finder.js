/**
 * 101cruise Cruise Finder — AI Holiday Planner (Phase 7A redesign).
 * Guided consultant-style journey → inspirational destination recommendations.
 * No live cruise search, prices, or booking in this phase.
 *
 * Mounts into: <div id="101cruise-cruise-finder"></div>
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-cruise-finder";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const SCRIPT_EL = document.currentScript;

  const TIMING_OPTIONS = [
    { id: "exact", label: "Exact travel dates" },
    { id: "month", label: "Specific month" },
    { id: "school_holidays", label: "School holidays" },
    { id: "this_season", label: "Any time this season" },
    { id: "flexible", label: "I'm flexible" }
  ];

  const DURATION_OPTIONS = [
    { id: "3-5", label: "3–5 nights", min: 3, max: 5 },
    { id: "6-8", label: "6–8 nights", min: 6, max: 8 },
    { id: "9-12", label: "9–12 nights", min: 9, max: 12 },
    { id: "13-16", label: "13–16 nights", min: 13, max: 16 },
    { id: "17-plus", label: "17+ nights", min: 17, max: 40 }
  ];

  const DEPARTURE_OPTIONS = [
    { id: "sydney", label: "Sydney" },
    { id: "brisbane", label: "Brisbane" },
    { id: "melbourne", label: "Melbourne" },
    { id: "perth", label: "Perth" },
    { id: "adelaide", label: "Adelaide" },
    { id: "auckland", label: "Auckland" },
    { id: "anywhere", label: "I'll fly anywhere" }
  ];

  const TRAVELLER_OPTIONS = [
    { id: "couple", label: "Couple" },
    { id: "family", label: "Family" },
    { id: "solo", label: "Solo" },
    { id: "friends", label: "Friends" },
    { id: "multi_generational", label: "Multi-generational" }
  ];

  const STYLE_OPTIONS = [
    { id: "beaches", label: "Beaches" },
    { id: "relaxation", label: "Relaxation" },
    { id: "adventure", label: "Adventure" },
    { id: "wildlife", label: "Wildlife" },
    { id: "culture", label: "Culture" },
    { id: "luxury", label: "Luxury" },
    { id: "expedition", label: "Expedition" },
    { id: "food_wine", label: "Food & Wine" },
    { id: "scenic_cruising", label: "Scenic cruising" },
    { id: "river_cruising", label: "River cruising" },
    { id: "warm_weather", label: "Warm weather" },
    { id: "cold_weather", label: "Cold weather" },
    { id: "bucket_list", label: "Bucket List" }
  ];

  const BUDGET_OPTIONS = [
    { id: "under-3k", label: "Under $3,000 pp", min: 0, max: 3000 },
    { id: "3-5k", label: "$3,000 – $5,000 pp", min: 3000, max: 5000 },
    { id: "5-8k", label: "$5,000 – $8,000 pp", min: 5000, max: 8000 },
    { id: "8k-plus", label: "$8,000+ pp", min: 8000, max: null },
    { id: "prefer_not", label: "I'd rather not say", min: null, max: null }
  ];

  /* Approximate AU school holiday windows (demo only) */
  const SCHOOL_HOLIDAY_MONTHS = [1, 4, 7, 9, 10, 12];

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
    durationId: "",
    departure: "",
    traveller: "",
    styles: [],
    budgetId: "",
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
      .replaceAll("'", "&#39;");
  }

  function destinations() {
    const list = window.CruiseFinderDestinations;
    return Array.isArray(list) ? list.filter((d) => d && d.active !== false) : [];
  }

  function parseYmd(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function monthsFromTiming() {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    if (state.timingMode === "exact") {
      const start = parseYmd(state.startDate);
      const end = parseYmd(state.endDate) || start;
      if (!start) return [];
      const months = new Set();
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
      const last = new Date(end.getFullYear(), end.getMonth(), 1);
      while (cursor <= last) {
        months.add(cursor.getMonth() + 1);
        cursor.setMonth(cursor.getMonth() + 1);
      }
      return Array.from(months);
    }

    if (state.timingMode === "month") {
      const m = Number(state.month);
      return m >= 1 && m <= 12 ? [m] : [];
    }

    if (state.timingMode === "school_holidays") {
      return SCHOOL_HOLIDAY_MONTHS.slice();
    }

    if (state.timingMode === "this_season") {
      const months = [];
      for (let i = 0; i < 4; i += 1) {
        let m = currentMonth + i;
        if (m > 12) m -= 12;
        months.push(m);
      }
      return months;
    }

    if (state.timingMode === "flexible") {
      return null;
    }

    return [];
  }

  function durationRange() {
    return DURATION_OPTIONS.find((d) => d.id === state.durationId) || null;
  }

  function scoreDestination(dest, travelMonths) {
    let score = 0;
    const reasons = [];
    const duration = durationRange();

    /* Timing / seasonal fit */
    if (travelMonths === null) {
      score += 12;
      reasons.push("Your dates are flexible, so we can lean into the seasons that suit this destination best.");
    } else if (travelMonths.length) {
      const bestHits = travelMonths.filter((m) => (dest.best_months || []).includes(m));
      const okHits = travelMonths.filter((m) => (dest.acceptable_months || []).includes(m));
      if (bestHits.length) {
        score += 28 + bestHits.length * 4;
        reasons.push(
          `Your travel window aligns with peak season — especially ${bestHits
            .map((m) => MONTH_NAMES[m - 1])
            .join(", ")}.`
        );
      } else if (okHits.length) {
        score += 14 + okHits.length * 2;
        reasons.push(
          `Your dates can work well, particularly around ${okHits
            .map((m) => MONTH_NAMES[m - 1])
            .join(", ")}.`
        );
      } else {
        score -= 8;
        reasons.push(
          `Your dates sit outside the classic season here — still possible, but we’d talk carefully about weather and sailing schedules.`
        );
      }
    }

    /* Duration */
    if (duration && duration.min != null) {
      const dMin = dest.typical_nights_min || 7;
      const dMax = dest.typical_nights_max || 14;
      const overlaps = duration.max >= dMin && duration.min <= dMax;
      const centred =
        duration.min >= dMin - 2 && duration.max <= dMax + 2;
      if (centred) {
        score += 16;
        reasons.push(
          `A ${duration.label.toLowerCase()} holiday sits nicely with typical cruises here (${dMin}–${dMax} nights).`
        );
      } else if (overlaps) {
        score += 8;
        reasons.push(`Cruise lengths here often fall around ${dMin}–${dMax} nights, close to what you’re considering.`);
      } else {
        score -= 4;
      }
    }

    /* Traveller type */
    if (state.traveller && (dest.suitable_travellers || []).includes(state.traveller)) {
      score += 12;
      const label = (TRAVELLER_OPTIONS.find((t) => t.id === state.traveller) || {}).label || state.traveller;
      reasons.push(`It suits ${label.toLowerCase()} travellers particularly well.`);
    } else if (state.traveller) {
      score -= 6;
    }

    /* Holiday styles (multi) */
    const styleHits = state.styles.filter((s) => (dest.suitable_styles || []).includes(s));
    if (styleHits.length) {
      score += 10 + styleHits.length * 5;
      const labels = styleHits
        .map((id) => (STYLE_OPTIONS.find((s) => s.id === id) || {}).label || id)
        .slice(0, 3);
      reasons.push(`It matches what you’re dreaming of: ${labels.join(", ").toLowerCase()}.`);
    } else if (state.styles.length) {
      score -= 4;
    }

    /* Departure */
    if (state.departure === "anywhere") {
      score += 4;
    } else if (state.departure && (dest.departure_markets || []).includes(state.departure)) {
      score += 8;
      const city = (DEPARTURE_OPTIONS.find((d) => d.id === state.departure) || {}).label || state.departure;
      reasons.push(`It works well for travellers departing from ${city}.`);
    }

    /* Soft budget nudge (demo only — no prices shown) */
    if (state.budgetId && state.budgetId !== "prefer_not") {
      if (dest.id === "antarctica" && (state.budgetId === "under-3k" || state.budgetId === "3-5k")) {
        score -= 10;
      } else if (dest.id === "south-pacific" || dest.id === "australia-new-zealand") {
        if (state.budgetId === "under-3k" || state.budgetId === "3-5k") score += 4;
      }
    }

    return { score, reasons };
  }

  function recommendationLevel(rank, score) {
    if (rank === 0 && score >= 40) return { key: "strong", label: "Strong match" };
    if (rank <= 1 && score >= 28) return { key: "great", label: "Great match" };
    if (score >= 18) return { key: "good", label: "Good match" };
    return { key: "worth", label: "Worth considering" };
  }

  function aiExplanation(dest, level, reasons) {
    const traveller =
      (TRAVELLER_OPTIONS.find((t) => t.id === state.traveller) || {}).label || "you";
    const styleBits = state.styles
      .slice(0, 2)
      .map((id) => (STYLE_OPTIONS.find((s) => s.id === id) || {}).label)
      .filter(Boolean);
    const stylePhrase = styleBits.length
      ? ` with a leaning toward ${styleBits.join(" and ").toLowerCase()}`
      : "";

    const opener =
      level.key === "strong"
        ? `If I were planning this for you, ${dest.name} would be near the top of my list.`
        : level.key === "great"
          ? `${dest.name} feels like a natural fit for the holiday you’ve described.`
          : `I’d keep ${dest.name} in the conversation for a ${traveller.toLowerCase()} trip${stylePhrase}.`;

    const why = reasons.slice(0, 2).join(" ");
    return `${opener} ${why}`.trim();
  }

  function whyDatesSuit(dest, travelMonths, reasons) {
    const dateReason = reasons.find(
      (r) =>
        r.includes("travel window") ||
        r.includes("dates") ||
        r.includes("flexible") ||
        r.includes("season")
    );
    if (dateReason) return dateReason;

    if (travelMonths === null) {
      return `Best months here are typically ${(dest.best_months || [])
        .map((m) => MONTH_NAMES[m - 1])
        .join(", ")} — with flexible dates, we can aim for those.`;
    }

    return `Best months are ${(dest.best_months || []).map((m) => MONTH_NAMES[m - 1]).join(", ")}.`;
  }

  function computeResults() {
    const travelMonths = monthsFromTiming();
    const scored = destinations()
      .map((dest) => {
        const { score, reasons } = scoreDestination(dest, travelMonths);
        return { dest, score, reasons, travelMonths };
      })
      .sort((a, b) => b.score - a.score || (a.dest.display_order || 0) - (b.dest.display_order || 0));

    state.results = scored.slice(0, 5).map((row, index) => {
      const level = recommendationLevel(index, row.score);
      return {
        ...row,
        level,
        explanation: aiExplanation(row.dest, level, row.reasons),
        whyDates: whyDatesSuit(row.dest, row.travelMonths, row.reasons)
      };
    });
  }

  function canShowStep(n) {
    if (n === 1) return true;
    if (n === 2) return timingComplete();
    if (n === 3) return timingComplete() && !!state.durationId;
    if (n === 4) return canShowStep(3) && !!state.departure;
    if (n === 5) return canShowStep(4) && !!state.traveller;
    if (n === 6) return canShowStep(5) && state.styles.length > 0;
    return false;
  }

  function timingComplete() {
    if (state.timingMode === "exact") {
      return !!(state.startDate && parseYmd(state.startDate));
    }
    if (state.timingMode === "month") {
      return !!(state.month && state.year);
    }
    return ["school_holidays", "this_season", "flexible"].includes(state.timingMode);
  }

  function readyForResults() {
    return timingComplete() && state.durationId && state.departure && state.traveller && state.styles.length > 0 && state.budgetId;
  }

  function choiceButtons(options, selectedId, dataAttr) {
    return options
      .map((opt) => {
        const selected = opt.id === selectedId ? " is-selected" : "";
        return `<button type="button" class="cf-choice${selected}" data-${dataAttr}="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
      })
      .join("");
  }

  function styleButtons() {
    return STYLE_OPTIONS.map((opt) => {
      const selected = state.styles.includes(opt.id) ? " is-selected" : "";
      return `<button type="button" class="cf-choice${selected}" data-style="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
    }).join("");
  }

  function yearOptions() {
    const y = new Date().getFullYear();
    return [y, y + 1, y + 2]
      .map(
        (yr) =>
          `<option value="${yr}"${String(state.year) === String(yr) ? " selected" : ""}>${yr}</option>`
      )
      .join("");
  }

  function monthOptions() {
    const opts = MONTH_NAMES.map((name, i) => {
      const m = String(i + 1);
      return `<option value="${m}"${String(state.month) === m ? " selected" : ""}>${name}</option>`;
    }).join("");
    return `<option value="">Select</option>${opts}`;
  }

  function timingDetailHtml() {
    if (state.timingMode === "exact") {
      return `
        <div class="cf-detail">
          <label class="cf-field">
            <span>From</span>
            <input type="date" data-field="startDate" value="${escapeHtml(state.startDate)}" />
          </label>
          <label class="cf-field">
            <span>To <em>(optional)</em></span>
            <input type="date" data-field="endDate" value="${escapeHtml(state.endDate)}" />
          </label>
        </div>`;
    }
    if (state.timingMode === "month") {
      return `
        <div class="cf-detail">
          <label class="cf-field">
            <span>Month</span>
            <select data-field="month">${monthOptions()}</select>
          </label>
          <label class="cf-field">
            <span>Year</span>
            <select data-field="year"><option value="">Select</option>${yearOptions()}</select>
          </label>
        </div>`;
    }
    if (state.timingMode === "school_holidays") {
      return `<p class="cf-hint">We’ll lean toward typical Australian school holiday windows when suggesting destinations.</p>`;
    }
    if (state.timingMode === "this_season") {
      return `<p class="cf-hint">We’ll look at destinations that suit the next few months from now.</p>`;
    }
    if (state.timingMode === "flexible") {
      return `<p class="cf-hint">Perfect — that gives us room to match you with destinations in their best seasons.</p>`;
    }
    return "";
  }

  function bestMonthsLabel(dest) {
    return (dest.best_months || []).map((m) => MONTH_NAMES[m - 1]).join(", ");
  }

  function cruiseLengthLabel(dest) {
    const min = dest.typical_nights_min;
    const max = dest.typical_nights_max;
    if (min == null) return "Varies";
    if (max == null || min === max) return `${min} nights`;
    return `${min}–${max} nights`;
  }

  function resultCard(row) {
    const d = row.dest;
    const imageUrl =
      d.image_url ||
      `https://placehold.co/1200x640/${(d.accent || "#8DD9BF").replace("#", "")}/ffffff?text=${encodeURIComponent(d.name)}`;
    const lines = (d.typical_cruise_lines || []).slice(0, 4).join(" · ");
    const explored = state.exploredId === d.id;

    return `
      <article class="cf-mag-card" data-destination-id="${escapeHtml(d.id)}" style="--cf-accent:${escapeHtml(d.accent || "#8DD9BF")}">
        <div class="cf-mag-hero" data-image-search="${escapeHtml(d.image_search_phrase || d.name + " cruise")}">
          <img
            class="cf-mag-image"
            src="${escapeHtml(imageUrl)}"
            alt=""
            loading="lazy"
            width="1200"
            height="640"
          />
          <div class="cf-mag-hero-fade"></div>
          <div class="cf-mag-hero-meta">
            <span class="cf-mag-level cf-mag-level--${escapeHtml(row.level.key)}">${escapeHtml(row.level.label)}</span>
            <h3 class="cf-mag-title">${escapeHtml(d.name)}</h3>
          </div>
        </div>
        <div class="cf-mag-body">
          <p class="cf-mag-ai">${escapeHtml(row.explanation)}</p>
          <p class="cf-mag-inspire">${escapeHtml(d.inspirational_description || "")}</p>

          <div class="cf-mag-facts">
            <div class="cf-mag-fact">
              <span class="cf-mag-fact-label">Why your dates suit</span>
              <span class="cf-mag-fact-value">${escapeHtml(row.whyDates)}</span>
            </div>
            <div class="cf-mag-fact">
              <span class="cf-mag-fact-label">Best months</span>
              <span class="cf-mag-fact-value">${escapeHtml(bestMonthsLabel(d))}</span>
            </div>
            <div class="cf-mag-fact">
              <span class="cf-mag-fact-label">Typical cruise length</span>
              <span class="cf-mag-fact-value">${escapeHtml(cruiseLengthLabel(d))}</span>
            </div>
            <div class="cf-mag-fact">
              <span class="cf-mag-fact-label">Typical weather</span>
              <span class="cf-mag-fact-value">${escapeHtml(d.typical_weather || "Varies by season")}</span>
            </div>
            <div class="cf-mag-fact cf-mag-fact--wide">
              <span class="cf-mag-fact-label">Typical cruise lines</span>
              <span class="cf-mag-fact-value">${escapeHtml(lines || "A range of premium and expedition lines")}</span>
            </div>
          </div>

          <div class="cf-mag-actions">
            <button type="button" class="cf-btn cf-btn-primary" data-explore="${escapeHtml(d.id)}">Explore Destination</button>
          </div>
          ${
            explored
              ? `<div class="cf-explore-note">
                  <p>Next we’ll expand this destination with richer seasonal detail, then search live for currently available sailings.</p>
                  <p class="cf-explore-ask">Every cruise will include: <em>“Ask Paul for today’s availability and best price.”</em></p>
                  <p class="cf-explore-muted">Cruise search isn’t available in this preview yet — no prices are shown.</p>
                </div>`
              : ""
          }
        </div>
      </article>`;
  }

  function resultsHtml() {
    if (!readyForResults()) return "";
    if (!state.results.length) computeResults();

    const cards = state.results.map(resultCard).join("");
    return `
      <section class="cf-results" id="cf-results">
        <div class="cf-results-intro">
          <p class="cf-step-label">Your recommendations</p>
          <h2 class="cf-results-title">Destinations I’d suggest for you</h2>
          <p class="cf-results-lead">Based on when you can travel and the kind of holiday you’re dreaming of — think of these as a consultant’s shortlist, not a catalogue.</p>
        </div>
        <div class="cf-mag-list">${cards}</div>
        <p class="cf-footnote">Demonstration recommendations only. Live cruise search and pricing come in a later phase.</p>
      </section>`;
  }

  function render() {
    if (!mount) return;

    const step2 = canShowStep(2);
    const step3 = canShowStep(3);
    const step4 = canShowStep(4);
    const step5 = canShowStep(5);
    const step6 = canShowStep(6);

    mount.innerHTML = `
      <div class="cf-finder" data-tools-origin="${escapeHtml(TOOLS_ORIGIN)}">
        <section class="cf-step" data-step="1">
          <p class="cf-step-label">Step 1</p>
          <h2 class="cf-step-title">When are you planning your holiday?</h2>
          <div class="cf-choice-grid">${choiceButtons(TIMING_OPTIONS, state.timingMode, "timing")}</div>
          ${timingDetailHtml()}
        </section>

        <section class="cf-step${step2 ? "" : " is-dimmed"}" data-step="2">
          <p class="cf-step-label">Step 2</p>
          <h2 class="cf-step-title">How long would you like your holiday to be?</h2>
          <div class="cf-choice-grid">${choiceButtons(DURATION_OPTIONS, state.durationId, "duration")}</div>
        </section>

        <section class="cf-step${step3 ? "" : " is-dimmed"}" data-step="3">
          <p class="cf-step-label">Step 3</p>
          <h2 class="cf-step-title">Where would you like to depart from?</h2>
          <div class="cf-choice-grid">${choiceButtons(DEPARTURE_OPTIONS, state.departure, "departure")}</div>
        </section>

        <section class="cf-step${step4 ? "" : " is-dimmed"}" data-step="4">
          <p class="cf-step-label">Step 4</p>
          <h2 class="cf-step-title">Who is travelling?</h2>
          <div class="cf-choice-grid">${choiceButtons(TRAVELLER_OPTIONS, state.traveller, "traveller")}</div>
        </section>

        <section class="cf-step${step5 ? "" : " is-dimmed"}" data-step="5">
          <p class="cf-step-label">Step 5</p>
          <h2 class="cf-step-title">What sort of holiday are you dreaming of?</h2>
          <p class="cf-hint">Choose as many as you like.</p>
          <div class="cf-choice-grid">${styleButtons()}</div>
        </section>

        <section class="cf-step${step6 ? "" : " is-dimmed"}" data-step="6">
          <p class="cf-step-label">Step 6</p>
          <h2 class="cf-step-title">Approximate holiday budget</h2>
          <p class="cf-hint">Per person, roughly — or skip if you’d rather not say.</p>
          <div class="cf-choice-grid">${choiceButtons(BUDGET_OPTIONS, state.budgetId, "budget")}</div>
        </section>

        ${resultsHtml()}
      </div>`;

    bind();
  }

  function invalidateResults() {
    state.results = [];
    state.exploredId = "";
  }

  function bind() {
    mount.querySelectorAll("[data-timing]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.timingMode = btn.getAttribute("data-timing") || "";
        state.startDate = "";
        state.endDate = "";
        state.month = "";
        state.year = "";
        invalidateResults();
        render();
      });
    });

    mount.querySelectorAll("[data-duration]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.durationId = btn.getAttribute("data-duration") || "";
        invalidateResults();
        render();
      });
    });

    mount.querySelectorAll("[data-departure]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.departure = btn.getAttribute("data-departure") || "";
        invalidateResults();
        render();
      });
    });

    mount.querySelectorAll("[data-traveller]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.traveller = btn.getAttribute("data-traveller") || "";
        invalidateResults();
        render();
      });
    });

    mount.querySelectorAll("[data-style]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-style") || "";
        if (!id) return;
        if (state.styles.includes(id)) {
          state.styles = state.styles.filter((s) => s !== id);
        } else {
          state.styles = state.styles.concat(id);
        }
        invalidateResults();
        render();
      });
    });

    mount.querySelectorAll("[data-budget]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.budgetId = btn.getAttribute("data-budget") || "";
        invalidateResults();
        render();
        const el = document.getElementById("cf-results");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    mount.querySelectorAll("[data-field]").forEach((input) => {
      const apply = () => {
        const field = input.getAttribute("data-field");
        if (!field) return;
        state[field] = input.value;
        invalidateResults();
        if (timingComplete() && field !== "endDate") render();
      };
      input.addEventListener("change", apply);
      input.addEventListener("blur", () => {
        if (timingComplete()) render();
      });
    });

    mount.querySelectorAll("[data-explore]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.exploredId = btn.getAttribute("data-explore") || "";
        render();
        const card = mount.querySelector(`[data-destination-id="${state.exploredId}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function init() {
    mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (mount.dataset.cfInit === "1") return;
    mount.dataset.cfInit = "1";
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
