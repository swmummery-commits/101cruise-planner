/**
 * 101cruise public Drinks Calculator V2 — guided progressive disclosure.
 *
 * Mounts into: <div id="101cruise-drinks-calculator-v2"></div>
 * URL: /drinks-calculator-v2?line=<id|slug>
 *
 * Visitor inputs are temporary browser state only and are never stored.
 * Does not read My Cruise / booking data.
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-drinks-calculator-v2";
  const INTRO_PAGE_URL = "https://101cruise.com.au/cruise-drinks-calculator";
  const SCRIPT_EL = document.currentScript;
  const REQUEST_TIMEOUT_MS = 12000;
  const INPUT_DEBOUNCE_MS = 250;
  const OWN_PACKAGE_ID = "__own__";

  const STAGE_LABELS = ["Cruise", "Package", "Your Drinks", "Recommendation"];

  const DRINK_FIELDS = [
    { key: "beer", label: "Beer", priceKey: "beer_price", icon: `<svg viewBox="0 0 24 24"><path d="M7 8h8v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8z"></path><path d="M15 10h2.5a2.5 2.5 0 0 1 0 5H15"></path><path d="M8 5c.8-1.5 2-2 3.5-2S14 3.5 15 5"></path></svg>` },
    { key: "wine", label: "Wine", priceKey: "wine_price", icon: `<svg viewBox="0 0 24 24"><path d="M8 4h8l-1.2 7.2A3.8 3.8 0 0 1 12 15a3.8 3.8 0 0 1-2.8-3.8L8 4z"></path><path d="M12 15v5"></path><path d="M9 20h6"></path></svg>` },
    { key: "cocktail", label: "Cocktails", priceKey: "cocktail_price", icon: `<svg viewBox="0 0 24 24"><path d="M5 6h14l-7 8v5"></path><path d="M9 19h6"></path><path d="M8 9h8"></path></svg>` },
    { key: "spirit", label: "Spirits + mixer", priceKey: "spirits_mixer_price", icon: `<svg viewBox="0 0 24 24"><path d="M9 3h6v3l2 3v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9l2-3V3z"></path><path d="M9 12h6"></path></svg>` },
    { key: "coffee", label: "Premium coffee", priceKey: "premium_coffee_price", icon: `<svg viewBox="0 0 24 24"><path d="M6 9h10v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9z"></path><path d="M16 11h2a2 2 0 0 1 0 4h-2"></path><path d="M8 5c.7 1 1.2 1 2 0s1.3-1 2 0"></path></svg>` },
    { key: "soft", label: "Soft drinks", priceKey: "soft_drink_price", icon: `<svg viewBox="0 0 24 24"><path d="M9 7h6l1 13H8L9 7z"></path><path d="M10 4h4l.5 3H9.5L10 4z"></path></svg>` },
    { key: "juice", label: "Juices", priceKey: "juice_price", icon: `<svg viewBox="0 0 24 24"><path d="M8 10c0-3 1.8-6 4-6s4 3 4 6v9H8v-9z"></path><path d="M10 4h4"></path></svg>` },
    { key: "water", label: "Bottled water", priceKey: "bottled_water_price", icon: `<svg viewBox="0 0 24 24"><path d="M10 3h4v3l2 2v13H8V8l2-2V3z"></path><path d="M9 12h6"></path></svg>` }
  ];

  const ICON_CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>`;

  function getScriptOrigin() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    const scripts = document.querySelectorAll('script[src*="drinks-calculator/calculator-v2.js"]');
    const last = scripts[scripts.length - 1];
    if (last && last.src) {
      try {
        return new URL(last.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    return window.location.origin;
  }

  const TOOLS_ORIGIN = getScriptOrigin();
  const LINES_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-lines`;
  const V2_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-v2`;

  let mount = null;
  let lines = [];
  let line = null;
  let packages = [];
  let activeStage = 1;
  let completed = { 1: false, 2: false, 3: false, 4: false };
  let debounceTimer = null;
  let liveMessage = "";

  const state = {
    lineParam: "",
    nights: 7,
    packageId: "",
    packagePrice: "",
    packageWifiIncluded: false,
    packageGratuitiesIncluded: false,
    wifiInFare: false,
    wouldBuyWifi: false,
    qty: {
      beer: 0,
      wine: 0,
      cocktail: 0,
      spirit: 0,
      coffee: 0,
      soft: 0,
      juice: 0,
      water: 0
    }
  };

  function replaceAllLiteral(value, search, replacement) {
    return String(value).split(search).join(replacement);
  }

  function escapeHtml(value) {
    let text = value == null ? "" : String(value);
    text = replaceAllLiteral(text, "&", "&amp;");
    text = replaceAllLiteral(text, "<", "&lt;");
    text = replaceAllLiteral(text, ">", "&gt;");
    text = replaceAllLiteral(text, '"', "&quot;");
    text = replaceAllLiteral(text, "'", "&#039;");
    return text;
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function getLineParam() {
    return String(new URLSearchParams(window.location.search).get("line") || "").trim();
  }

  function money(value, currency) {
    const symbolMap = { USD: "US$", AUD: "AU$", NZD: "NZ$", GBP: "£", EUR: "€" };
    const symbol = symbolMap[currency] || `${currency} $`;
    const number = Number(value);
    if (!Number.isFinite(number)) return `${symbol}—`;
    return symbol + number.toFixed(2);
  }

  function formatDisplayDate(dateString) {
    if (!dateString) return "Not available";
    const date = new Date(`${dateString}T00:00:00`);
    const resolved = Number.isNaN(date.getTime()) ? new Date(dateString) : date;
    if (Number.isNaN(resolved.getTime())) return String(dateString);
    return resolved.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  function fetchJson(url, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) controller.abort();
    }, timeoutMs);
    return fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller ? controller.signal : undefined
    })
      .then(async response => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error((payload && payload.message) || "Request failed");
          error.code = payload && payload.error;
          throw error;
        }
        return payload;
      })
      .finally(() => clearTimeout(timer));
  }

  function selectedPackage() {
    if (state.packageId === OWN_PACKAGE_ID) {
      return {
        id: OWN_PACKAGE_ID,
        package_name: "Enter my own package",
        typical_daily_price: null,
        wifi_included: state.packageWifiIncluded,
        gratuities_included: state.packageGratuitiesIncluded,
        isOwn: true
      };
    }
    return packages.find(pkg => String(pkg.id) === String(state.packageId)) || null;
  }

  function packageDisplayName() {
    const pkg = selectedPackage();
    return pkg ? pkg.package_name : "Package";
  }

  function effectivePackageFlags() {
    const pkg = selectedPackage();
    if (!pkg) {
      return { wifiIncluded: false, gratuitiesIncluded: false };
    }
    if (pkg.isOwn) {
      return {
        wifiIncluded: state.packageWifiIncluded === true,
        gratuitiesIncluded: state.packageGratuitiesIncluded === true
      };
    }
    return {
      wifiIncluded: pkg.wifi_included === true,
      gratuitiesIncluded: pkg.gratuities_included === true
    };
  }

  function sanitizeNonNegative(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return number;
  }

  function priceOrNull(lineData, key) {
    const raw = lineData ? lineData[key] : null;
    if (raw === null || raw === undefined || raw === "") return null;
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * Automatic comparison engine (V2).
   *
   * Package daily:
   *   packagePrice
   *   + packagePrice * gratuity% when gratuities are NOT included in the package price
   *
   * Buy-as-you-go daily drinks:
   *   sum(qty × drink price) for priced drinks
   *   + drinks * gratuity%
   *
   * Wi-Fi differential (only when it creates a genuine difference):
   *   A. wifi in fare → $0 both sides
   *   B. not in fare + would buy standalone:
   *      - package includes Wi-Fi → add standalone Wi-Fi to buy-as-you-go only
   *      - package does not include Wi-Fi → equal both sides → $0 differential
   *   C. would not buy standalone → $0
   */
  function calculateComparison() {
    if (!line) return null;

    const currency = line.currency || "USD";
    const nights = Math.max(0, Math.floor(sanitizeNonNegative(state.nights)));
    const packagePrice = sanitizeNonNegative(state.packagePrice);
    const gratuityPercent = priceOrNull(line, "gratuity_percent");
    const gratuityRate = gratuityPercent == null ? 0 : gratuityPercent / 100;
    const flags = effectivePackageFlags();
    const wifiInFare = state.wifiInFare === true || line.wifi_included_in_fare === true;
    const standaloneWifi = priceOrNull(line, "wifi_package_price");

    let dailyDrinks = 0;
    const drinkRows = [];
    DRINK_FIELDS.forEach(field => {
      const unit = priceOrNull(line, field.priceKey);
      const qty = Math.max(0, Math.floor(sanitizeNonNegative(state.qty[field.key])));
      if (unit == null) return;
      const lineTotal = qty * unit;
      dailyDrinks += lineTotal;
      if (qty > 0) {
        drinkRows.push({ label: field.label, qty, unit, total: lineTotal });
      }
    });

    const dailyDrinkGratuities = dailyDrinks * gratuityRate;
    const packageGratuities = flags.gratuitiesIncluded ? 0 : packagePrice * gratuityRate;

    let wifiOnBuyAsYouGo = 0;
    let wifiDifferential = 0;
    let wifiExplanation = "Wi-Fi is not affecting this comparison.";

    if (wifiInFare) {
      wifiExplanation = "Wi-Fi is included in the cruise fare, so it cancels out of the comparison.";
    } else if (state.wouldBuyWifi) {
      if (flags.wifiIncluded) {
        wifiOnBuyAsYouGo = standaloneWifi == null ? 0 : standaloneWifi;
        wifiDifferential = wifiOnBuyAsYouGo;
        wifiExplanation =
          standaloneWifi == null
            ? "Your package includes Wi-Fi, but a standalone Wi-Fi price is not listed for this cruise line."
            : "Standalone Wi-Fi is added to the buy-as-you-go side only because the selected package includes Wi-Fi.";
      } else {
        wifiExplanation =
          "Wi-Fi would be purchased separately with either option, so it does not change the difference.";
      }
    } else {
      wifiExplanation = "You indicated you would not normally buy Wi-Fi separately.";
    }

    const packageDailyTotal = packagePrice + packageGratuities;
    const buyAsYouGoDailyTotal = dailyDrinks + dailyDrinkGratuities + wifiOnBuyAsYouGo;
    const dailyDifference = buyAsYouGoDailyTotal - packageDailyTotal;
    const cruiseDifference = dailyDifference * nights;

    let recommendationKind = "close";
    let recommendationTitle = "This comparison is close to break-even";
    let recommendationBody =
      "The difference is small on these estimates. Convenience and budgeting certainty may still matter. This is a guide only and is not guaranteed.";

    if (dailyDifference > 5) {
      recommendationKind = "good";
      recommendationTitle = `Buy the ${packageDisplayName()}`;
      recommendationBody = `Based on your selections, you’ll save approximately ${money(cruiseDifference, currency)} over your ${nights} night cruise. This is a guide only and is not guaranteed.`;
    } else if (dailyDifference < -5) {
      recommendationKind = "payg";
      recommendationTitle = "Buying drinks individually may cost less";
      recommendationBody = `Based on your selections, paying as you go could cost around ${money(Math.abs(cruiseDifference), currency)} less over your ${nights} night cruise. This is a guide only and is not guaranteed.`;
    }

    const valueFrom = [];
    const drinksPlusGrat = dailyDrinks + dailyDrinkGratuities;
    const drinksVsPackageCore = drinksPlusGrat - packagePrice;
    if (Math.abs(drinksVsPackageCore) >= 0.005) {
      valueFrom.push({
        label: "Drinks (alcohol & non-alcohol) vs package drinks price",
        amount: drinksVsPackageCore
      });
    }
    if (packageGratuities > 0) {
      valueFrom.push({ label: "Package drink gratuities", amount: -packageGratuities });
    }
    if (wifiDifferential > 0) {
      valueFrom.push({ label: "Wi-Fi", amount: wifiDifferential });
    }

    return {
      currency,
      nights,
      packagePrice,
      packageName: packageDisplayName(),
      gratuityPercent,
      packageGratuities,
      dailyDrinks,
      dailyDrinkGratuities,
      wifiOnBuyAsYouGo,
      wifiDifferential,
      wifiExplanation,
      packageDailyTotal,
      buyAsYouGoDailyTotal,
      dailyDifference,
      cruiseDifference,
      recommendationKind,
      recommendationTitle,
      recommendationBody,
      drinkRows,
      valueFrom,
      flags,
      wifiInFare,
      standaloneWifi
    };
  }

  function stage1Ready() {
    const nightsOk = Number(state.nights) > 0 && Number.isFinite(Number(state.nights));
    const lineOk = Boolean(line);
    const pkg = selectedPackage();
    if (!lineOk || !nightsOk || !pkg) return false;
    return sanitizeNonNegative(state.packagePrice) > 0;
  }

  function applyPackageSelection(packageId) {
    state.packageId = packageId;
    const pkg = selectedPackage();
    if (!pkg) return;
    if (pkg.isOwn) {
      if (!state.packagePrice) state.packagePrice = "";
      return;
    }
    if (pkg.typical_daily_price != null) {
      state.packagePrice = String(pkg.typical_daily_price);
    }
    state.packageWifiIncluded = pkg.wifi_included === true;
    state.packageGratuitiesIncluded = pkg.gratuities_included === true;
  }

  function invalidateFrom(stage) {
    for (let i = stage; i <= 4; i += 1) completed[i] = false;
    if (activeStage > stage) activeStage = stage;
  }

  function renderProgress() {
    return `
      <ol class="dc-v2-progress" aria-label="Calculator progress">
        ${STAGE_LABELS.map((label, index) => {
          const step = index + 1;
          const cls = completed[step] ? "is-done" : activeStage === step ? "is-current" : "";
          const mark = completed[step] ? "✓" : String(step);
          return `<li class="${cls}"><span class="dc-v2-progress-dot" aria-hidden="true">${mark}</span><span>${escapeHtml(label)}</span></li>`;
        }).join("")}
      </ol>
    `;
  }

  function renderSummary(stage, text) {
    return `
      <button type="button" class="dc-v2-summary" data-edit-stage="${stage}" aria-label="Edit stage ${stage}">
        <span class="dc-v2-summary-main">
          <span class="dc-v2-summary-check">${ICON_CHECK}</span>
          <span class="dc-v2-summary-text">${escapeHtml(text)}</span>
        </span>
        <span class="dc-v2-summary-edit">Edit</span>
      </button>
    `;
  }

  function renderTop() {
    const logo = line && line.logo_url
      ? `<img class="dc-v2-logo" src="${escapeHtml(line.logo_url)}" alt="">`
      : `<div class="dc-v2-logo-fallback" aria-hidden="true">101</div>`;
    return `
      <div class="dc-v2-top">
        <div class="dc-v2-brand">
          ${logo}
          <div>
            <p class="dc-v2-kicker">101cruise Drinks Calculator</p>
            <h1 class="dc-v2-title">Is the drinks package worth it?</h1>
          </div>
        </div>
        ${renderProgress()}
      </div>
    `;
  }

  function renderPackageCards() {
    const cards = packages.map(pkg => {
      const selected = String(state.packageId) === String(pkg.id);
      const priceLabel =
        pkg.typical_daily_price == null
          ? "Typical price not listed"
          : `${money(pkg.typical_daily_price, pkg.currency || line.currency)} / day`;
      const tags = [];
      if (pkg.wifi_included) tags.push("Includes Wi-Fi");
      if (pkg.gratuities_included) tags.push("Includes gratuities");
      return `
        <button type="button" class="dc-v2-pkg ${selected ? "is-selected" : ""}" data-package-id="${escapeHtml(pkg.id)}" aria-pressed="${selected ? "true" : "false"}">
          <span class="dc-v2-pkg-radio" aria-hidden="true"></span>
          <span>
            <p class="dc-v2-pkg-name">${escapeHtml(pkg.package_name)}</p>
            <p class="dc-v2-pkg-meta">Typical price</p>
            ${tags.length ? `<div class="dc-v2-pkg-tags">${tags.map(tag => `<span class="dc-v2-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
          </span>
          <span class="dc-v2-pkg-price">${escapeHtml(priceLabel)}</span>
        </button>
      `;
    }).join("");

    const ownSelected = state.packageId === OWN_PACKAGE_ID;
    return `
      <div class="dc-v2-pkg-list" role="listbox" aria-label="Package to compare">
        ${cards}
        <button type="button" class="dc-v2-pkg ${ownSelected ? "is-selected" : ""}" data-package-id="${OWN_PACKAGE_ID}" aria-pressed="${ownSelected ? "true" : "false"}">
          <span class="dc-v2-pkg-radio" aria-hidden="true"></span>
          <span>
            <p class="dc-v2-pkg-name">Enter my own package</p>
            <p class="dc-v2-pkg-meta">Use the price and inclusions from your sailing offer</p>
          </span>
          <span class="dc-v2-pkg-price">Custom</span>
        </button>
      </div>
    `;
  }

  function renderStage1Body() {
    const options = lines
      .map(item => {
        const slug = item.cruise_line_slug || slugify(item.cruise_line_name);
        const selected =
          line &&
          (String(item.cruise_line_id) === String(line.cruise_line_id) ||
            slug === String(line.cruise_line_slug || slugify(line.cruise_line_name)));
        return `<option value="${escapeHtml(slug)}" ${selected ? "selected" : ""}>${escapeHtml(item.cruise_line_name)}</option>`;
      })
      .join("");

    const pkg = selectedPackage();
    const showPrice = Boolean(pkg);
    const own = pkg && pkg.isOwn;

    return `
      <div class="dc-v2-stage-body">
        <h2 class="dc-v2-stage-heading">Let’s start with your cruise</h2>
        <p class="dc-v2-stage-copy">Choose your cruise line, nights, and the package you want to compare.</p>
        <div class="dc-v2-grid-2">
          <div>
            <div class="dc-v2-field">
              <label for="dc-v2-line">Cruise line</label>
              <select id="dc-v2-line">
                <option value="">Select a cruise line</option>
                ${options}
              </select>
              ${
                line
                  ? `<div class="dc-v2-line-selected">${
                      line.logo_url
                        ? `<img src="${escapeHtml(line.logo_url)}" alt="">`
                        : ""
                    }<span>${escapeHtml(line.cruise_line_name)}</span></div>`
                  : ""
              }
            </div>
            <div class="dc-v2-field">
              <span class="dc-v2-label" id="dc-v2-nights-label">Number of nights</span>
              <div class="dc-v2-stepper" role="group" aria-labelledby="dc-v2-nights-label">
                <button type="button" data-nights-delta="-1" aria-label="Decrease nights">−</button>
                <input id="dc-v2-nights" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(state.nights)}" aria-label="Number of nights">
                <button type="button" data-nights-delta="1" aria-label="Increase nights">+</button>
              </div>
            </div>
            ${
              showPrice
                ? `<div class="dc-v2-field">
                    <label for="dc-v2-package-price">${own ? "Your package price per day" : "Typical price (editable)"}</label>
                    <input id="dc-v2-package-price" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(state.packagePrice)}" placeholder="0.00">
                    ${
                      own
                        ? ""
                        : `<p class="dc-v2-caveat">Typical price only — your sailing offer may differ by ship, date and promotion.</p>`
                    }
                  </div>`
                : ""
            }
          </div>
          <div>
            <span class="dc-v2-label">Package to compare</span>
            ${line ? renderPackageCards() : `<p class="dc-v2-caveat">Select a cruise line to see packages.</p>`}
          </div>
        </div>
        <div class="dc-v2-actions">
          <button type="button" class="dc-v2-btn dc-v2-btn-primary" data-continue="1" ${stage1Ready() ? "" : "disabled"}>Continue →</button>
        </div>
      </div>
    `;
  }

  function renderStage2Body() {
    const flags = effectivePackageFlags();
    const own = state.packageId === OWN_PACKAGE_ID;
    const wifiInFare = state.wifiInFare === true;

    const inclusionBlock = own
      ? `
        <div class="dc-v2-checks" style="margin-bottom:14px">
          <label class="dc-v2-check">
            <input type="checkbox" id="dc-v2-pkg-wifi" ${state.packageWifiIncluded ? "checked" : ""}>
            <span>
              <span class="dc-v2-check-label">This package includes Wi-Fi</span>
            </span>
          </label>
          <label class="dc-v2-check">
            <input type="checkbox" id="dc-v2-pkg-grat" ${state.packageGratuitiesIncluded ? "checked" : ""}>
            <span>
              <span class="dc-v2-check-label">This package price includes drink gratuities</span>
            </span>
          </label>
        </div>
      `
      : `
        <div class="dc-v2-checks" style="margin-bottom:14px">
          <div class="dc-v2-check is-confirmed" aria-live="polite">
            <span class="dc-v2-summary-check" aria-hidden="true">${ICON_CHECK}</span>
            <span>
              <span class="dc-v2-check-label">Wi-Fi included with this package: ${flags.wifiIncluded ? "Yes" : "No"}</span>
              <p class="dc-v2-check-note">Based on the package record maintained by 101cruise.</p>
            </span>
          </div>
          <div class="dc-v2-check is-confirmed">
            <span class="dc-v2-summary-check" aria-hidden="true">${ICON_CHECK}</span>
            <span>
              <span class="dc-v2-check-label">Drink gratuities included with this package: ${flags.gratuitiesIncluded ? "Yes" : "No"}</span>
            </span>
          </div>
        </div>
      `;

    return `
      <div class="dc-v2-stage-body">
        <h2 class="dc-v2-stage-heading">A few quick questions</h2>
        <p class="dc-v2-stage-copy">We’ll only count Wi-Fi where it creates a real difference between the package and buying separately.</p>
        ${inclusionBlock}
        <div class="dc-v2-checks">
          <label class="dc-v2-check">
            <input type="checkbox" id="dc-v2-wifi-fare" ${wifiInFare ? "checked" : ""}>
            <span>
              <span class="dc-v2-check-label">Wi-Fi is already included in my cruise fare</span>
              ${
                line && line.wifi_included_in_fare
                  ? `<p class="dc-v2-check-note">This cruise line is recorded as including Wi-Fi in the fare. You can uncheck if your sailing differs.</p>`
                  : ""
              }
            </span>
          </label>
          ${
            wifiInFare
              ? `<p class="dc-v2-caveat">Because Wi-Fi is included in the fare, it cancels out of the comparison.</p>`
              : `<label class="dc-v2-check">
                  <input type="checkbox" id="dc-v2-wifi-buy" ${state.wouldBuyWifi ? "checked" : ""}>
                  <span>
                    <span class="dc-v2-check-label">If not, I would normally buy Wi-Fi separately</span>
                  </span>
                </label>`
          }
        </div>
        <div class="dc-v2-actions">
          <button type="button" class="dc-v2-btn dc-v2-btn-secondary" data-back="2">← Back</button>
          <button type="button" class="dc-v2-btn dc-v2-btn-primary" data-continue="2">Continue →</button>
        </div>
      </div>
    `;
  }

  function renderStage3Body() {
    const drinks = DRINK_FIELDS.map(field => {
      const unit = priceOrNull(line, field.priceKey);
      const unavailable = unit == null;
      return `
        <div class="dc-v2-drink">
          <div class="dc-v2-drink-icon" aria-hidden="true">${field.icon}</div>
          <div>
            <p class="dc-v2-drink-name">${escapeHtml(field.label)}</p>
            <p class="dc-v2-drink-price">${
              unavailable
                ? "Pricing not available"
                : `avg ${money(unit, line.currency)}`
            }</p>
          </div>
          ${
            unavailable
              ? `<span class="dc-v2-caveat">—</span>`
              : `<div class="dc-v2-stepper" role="group" aria-label="${escapeHtml(field.label)} quantity">
                  <button type="button" data-qty-key="${field.key}" data-qty-delta="-1" aria-label="Decrease ${escapeHtml(field.label)}">−</button>
                  <input type="number" min="0" step="1" inputmode="numeric" data-qty-input="${field.key}" value="${escapeHtml(state.qty[field.key])}" aria-label="${escapeHtml(field.label)} per day">
                  <button type="button" data-qty-key="${field.key}" data-qty-delta="1" aria-label="Increase ${escapeHtml(field.label)}">+</button>
                </div>`
          }
        </div>
      `;
    }).join("");

    return `
      <div class="dc-v2-stage-body">
        <h2 class="dc-v2-stage-heading">Tell us about your typical day</h2>
        <p class="dc-v2-stage-copy">Enter how many of each drink you’d usually buy each day. Results update automatically.</p>
        <div class="dc-v2-drink-grid">${drinks}</div>
        <p class="dc-v2-live" aria-live="polite">${escapeHtml(liveMessage || "Updating your comparison…")}</p>
        <div class="dc-v2-actions">
          <button type="button" class="dc-v2-btn dc-v2-btn-secondary" data-back="3">← Back</button>
          <button type="button" class="dc-v2-btn dc-v2-btn-primary" data-continue="3">See recommendation →</button>
        </div>
      </div>
    `;
  }

  function renderStage4Body() {
    const result = calculateComparison();
    if (!result) {
      return `<div class="dc-v2-stage-body"><p class="dc-v2-status is-error">We couldn’t calculate a comparison yet.</p></div>`;
    }

    const valueList = result.valueFrom.length
      ? result.valueFrom
          .map(
            row =>
              `<li><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(money(row.amount, result.currency))}</strong></li>`
          )
          .join("")
      : `<li><span>No separate value components to highlight</span><strong>${escapeHtml(money(result.dailyDifference, result.currency))}</strong></li>`;

    const fullBreakdown = `
      <li><span>Drinks</span><span>${escapeHtml(money(result.dailyDrinks, result.currency))}</span></li>
      <li><span>Drink gratuities</span><span>${escapeHtml(money(result.dailyDrinkGratuities, result.currency))}</span></li>
      ${
        result.packageGratuities > 0
          ? `<li><span>Package gratuities</span><span>${escapeHtml(money(result.packageGratuities, result.currency))}</span></li>`
          : ""
      }
      ${
        result.wifiDifferential > 0
          ? `<li><span>Wi-Fi value in comparison</span><span>${escapeHtml(money(result.wifiDifferential, result.currency))}</span></li>`
          : ""
      }
      <li><span>Package total / day</span><span>${escapeHtml(money(result.packageDailyTotal, result.currency))}</span></li>
      <li><span>Buy as you go / day</span><span>${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</span></li>
      <li><span>Difference / day</span><span>${escapeHtml(money(result.dailyDifference, result.currency))}</span></li>
      <li><span>Difference over cruise</span><span>${escapeHtml(money(result.cruiseDifference, result.currency))}</span></li>
    `;

    return `
      <div class="dc-v2-stage-body">
        <h2 class="dc-v2-stage-heading">Your recommendation</h2>
        <div class="dc-v2-rec">
          <article class="dc-v2-rec-card">
            <h3 class="dc-v2-rec-title">${escapeHtml(result.recommendationTitle)}</h3>
            <p class="dc-v2-rec-body">${escapeHtml(result.recommendationBody)}</p>
          </article>
          <div class="dc-v2-metrics">
            <div class="dc-v2-metric"><span>Package cost / day</span><strong>${escapeHtml(money(result.packageDailyTotal, result.currency))}</strong></div>
            <div class="dc-v2-metric"><span>Estimated spend as you go / day</span><strong>${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</strong></div>
            <div class="dc-v2-metric"><span>Difference / day</span><strong>${escapeHtml(money(result.dailyDifference, result.currency))}</strong></div>
          </div>
          <div class="dc-v2-split">
            <div class="dc-v2-panel">
              <h3>Where the value comes from</h3>
              <ul class="dc-v2-breakdown">${valueList}</ul>
            </div>
            <div class="dc-v2-panel">
              <h3>Cruise total difference</h3>
              <p style="margin:0;font-size:1.2rem;font-weight:650">${escapeHtml(money(result.cruiseDifference, result.currency))}</p>
              <p class="dc-v2-caveat">Over ${escapeHtml(result.nights)} nights</p>
            </div>
          </div>
          <p class="dc-v2-warn">Prices are estimates and may vary by ship, sailing, itinerary and promotion. This is a guide only.</p>
          <details class="dc-v2-details">
            <summary>View full breakdown</summary>
            <ul class="dc-v2-breakdown" style="margin-top:10px">${fullBreakdown}</ul>
          </details>
          <div class="dc-v2-actions">
            <button type="button" class="dc-v2-btn dc-v2-btn-secondary" data-restart>← Start again</button>
            <button type="button" class="dc-v2-btn dc-v2-btn-secondary" data-edit-stage="1">Edit selections</button>
          </div>
        </div>
        <section class="dc-v2-explain" aria-labelledby="dc-v2-how-title">
          <h2 id="dc-v2-how-title">How this comparison works</h2>
          <article>
            <h3>Wi-Fi</h3>
            <p>${escapeHtml(result.wifiExplanation)} Wi-Fi is included in the comparison only where it creates a genuine difference between buying the package and paying separately. If Wi-Fi is already included in the cruise fare, or must be purchased separately with either option, it does not affect the result.</p>
          </article>
          <article>
            <h3>Gratuities</h3>
            <p>Drink gratuities are added where they are not already included. ${
              result.gratuityPercent == null
                ? "A typical gratuity rate is not listed for this cruise line."
                : `The percentage used is ${escapeHtml(String(result.gratuityPercent))}%, based on the typical gratuity rate maintained for ${escapeHtml(line.cruise_line_name)}.`
            }</p>
          </article>
          <article>
            <h3>Purchase timing</h3>
            <p>Cruise lines often offer better drinks-package pricing before departure. The price and inclusions offered for a particular sailing may differ from the typical price shown here.</p>
          </article>
          <article>
            <h3>Important to know</h3>
            <p>This calculator uses typical onboard prices and provides an estimate only. Prices, taxes, gratuities, package inclusions and availability may vary by ship, sailing and promotion.</p>
          </article>
          <article>
            <h3>About the data</h3>
            <p>Data is maintained by 101cruise. Last verified ${escapeHtml(formatDisplayDate(line.last_verified_at))}. Check the package terms for your sailing, contact 101cruise, or confirm directly with the cruise line.</p>
          </article>
        </section>
      </div>
    `;
  }

  function stage1SummaryText() {
    const nights = Math.max(0, Math.floor(sanitizeNonNegative(state.nights)));
    return `${line ? line.cruise_line_name : "Cruise"} · ${packageDisplayName()} · ${nights} nights`;
  }

  function stage2SummaryText() {
    const flags = effectivePackageFlags();
    const parts = [
      flags.wifiIncluded ? "Wi-Fi included in package" : "Wi-Fi not in package",
      flags.gratuitiesIncluded ? "Gratuities included" : "Gratuities not included",
      state.wifiInFare ? "Fare Wi-Fi included" : "Fare Wi-Fi not included"
    ];
    return parts.join(" · ");
  }

  function stage3SummaryText() {
    const totalQty = DRINK_FIELDS.reduce((sum, field) => sum + (Number(state.qty[field.key]) || 0), 0);
    return `${totalQty} drink${totalQty === 1 ? "" : "s"} per day estimated`;
  }

  function renderStage(stage) {
    const isActive = activeStage === stage;
    const isComplete = completed[stage] && !isActive;

    if (stage > 1 && !completed[stage - 1] && !isActive) {
      return "";
    }

    let body = "";
    if (isComplete) {
      const text =
        stage === 1 ? stage1SummaryText() : stage === 2 ? stage2SummaryText() : stage3SummaryText();
      return `<section class="dc-v2-stage is-complete" data-stage="${stage}">${renderSummary(stage, text)}</section>`;
    }

    if (!isActive) return "";

    if (stage === 1) body = renderStage1Body();
    if (stage === 2) body = renderStage2Body();
    if (stage === 3) body = renderStage3Body();
    if (stage === 4) body = renderStage4Body();

    return `<section class="dc-v2-stage is-active" data-stage="${stage}">${body}</section>`;
  }

  function renderIncludedFare() {
    return `
      <section class="dc-v2-stage is-active">
        <div class="dc-v2-stage-body">
          <h2 class="dc-v2-stage-heading">Drinks are included in the fare</h2>
          <p class="dc-v2-stage-copy">${escapeHtml(line.cruise_line_name)} is recorded as including drinks in the cruise fare, so a package comparison isn’t needed for a typical sailing.</p>
          <p class="dc-v2-caveat">${escapeHtml(line.general_notes || "Confirm inclusions for your specific sailing with the cruise line or 101cruise.")}</p>
          <div class="dc-v2-actions">
            <a class="dc-v2-btn dc-v2-btn-secondary" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a>
          </div>
        </div>
      </section>
    `;
  }

  function renderApp() {
    if (!mount) return;
    if (!line) {
      mount.innerHTML = `
        <div class="dc-v2">
          ${renderTop()}
          ${renderStage(1)}
        </div>
      `;
      bindEvents();
      return;
    }

    if (line.drinks_included_in_fare && (!packages || packages.length === 0)) {
      mount.innerHTML = `<div class="dc-v2">${renderTop()}${renderIncludedFare()}</div>`;
      bindEvents();
      return;
    }

    mount.innerHTML = `
      <div class="dc-v2">
        ${renderTop()}
        ${renderStage(1)}
        ${renderStage(2)}
        ${renderStage(3)}
        ${renderStage(4)}
      </div>
    `;
    bindEvents();
  }

  function scheduleLiveUpdate() {
    liveMessage = "Updating your comparison…";
    const live = mount && mount.querySelector(".dc-v2-live");
    if (live) live.textContent = liveMessage;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      liveMessage = "Results update instantly as you change quantities.";
      if (completed[3] || activeStage === 4) {
        renderApp();
      } else {
        const el = mount && mount.querySelector(".dc-v2-live");
        if (el) el.textContent = liveMessage;
      }
    }, INPUT_DEBOUNCE_MS);
  }

  function setLineUrl(slug) {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set("line", slug);
    else url.searchParams.delete("line");
    window.history.replaceState({}, "", url.toString());
  }

  async function loadLineDetail(lineParam) {
    const payload = await fetchJson(
      `${V2_API_URL}?line=${encodeURIComponent(lineParam)}`,
      REQUEST_TIMEOUT_MS
    );
    if (!payload || !payload.success || !payload.line) {
      throw new Error((payload && payload.message) || "Unable to load this calculator.");
    }
    line = payload.line;
    packages = Array.isArray(payload.packages) ? payload.packages : [];
    state.lineParam = lineParam;
    state.wifiInFare = line.wifi_included_in_fare === true;
    if (state.packageId && state.packageId !== OWN_PACKAGE_ID) {
      const stillThere = packages.some(pkg => String(pkg.id) === String(state.packageId));
      if (!stillThere) {
        state.packageId = "";
        state.packagePrice = "";
      }
    }
  }

  async function onCruiseLineChange(slug) {
    if (!slug) {
      line = null;
      packages = [];
      state.packageId = "";
      state.packagePrice = "";
      setLineUrl("");
      invalidateFrom(1);
      renderApp();
      return;
    }
    try {
      await loadLineDetail(slug);
      setLineUrl(line.cruise_line_slug || slug);
      invalidateFrom(1);
      renderApp();
    } catch (_error) {
      showFatalError();
    }
  }

  function showFatalError() {
    if (!mount) return;
    mount.innerHTML = `
      <div class="dc-v2">
        <p class="dc-v2-status is-error">We couldn’t load the calculator information. Please try again shortly.</p>
        <button type="button" class="dc-v2-btn dc-v2-btn-primary dc-v2-retry" data-retry>Retry</button>
      </div>
    `;
    const retry = mount.querySelector("[data-retry]");
    if (retry) retry.addEventListener("click", () => init());
  }

  function continueFrom(stage) {
    if (stage === 1 && !stage1Ready()) return;
    completed[stage] = true;
    activeStage = Math.min(4, stage + 1);
    if (stage === 3) completed[4] = true;
    renderApp();
    const active = mount.querySelector(".dc-v2-stage.is-active");
    if (active) active.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function editStage(stage) {
    activeStage = stage;
    for (let i = stage; i <= 4; i += 1) completed[i] = false;
    renderApp();
  }

  function restart() {
    state.nights = 7;
    state.packageId = "";
    state.packagePrice = "";
    state.packageWifiIncluded = false;
    state.packageGratuitiesIncluded = false;
    state.wifiInFare = line ? line.wifi_included_in_fare === true : false;
    state.wouldBuyWifi = false;
    Object.keys(state.qty).forEach(key => {
      state.qty[key] = 0;
    });
    completed = { 1: false, 2: false, 3: false, 4: false };
    activeStage = 1;
    renderApp();
  }

  function bindEvents() {
    if (!mount) return;

    const lineSelect = mount.querySelector("#dc-v2-line");
    if (lineSelect) {
      lineSelect.addEventListener("change", () => onCruiseLineChange(lineSelect.value));
    }

    mount.querySelectorAll("[data-package-id]").forEach(button => {
      button.addEventListener("click", () => {
        applyPackageSelection(button.getAttribute("data-package-id"));
        invalidateFrom(1);
        renderApp();
      });
    });

    const nightsInput = mount.querySelector("#dc-v2-nights");
    if (nightsInput) {
      nightsInput.addEventListener("input", () => {
        state.nights = nightsInput.value;
        scheduleLiveUpdate();
      });
      nightsInput.addEventListener("change", () => {
        state.nights = Math.max(1, Math.floor(sanitizeNonNegative(nightsInput.value)) || 1);
        invalidateFrom(1);
        renderApp();
      });
    }

    mount.querySelectorAll("[data-nights-delta]").forEach(button => {
      button.addEventListener("click", () => {
        const delta = Number(button.getAttribute("data-nights-delta")) || 0;
        state.nights = Math.max(1, Math.floor(sanitizeNonNegative(state.nights)) + delta);
        invalidateFrom(1);
        renderApp();
      });
    });

    const priceInput = mount.querySelector("#dc-v2-package-price");
    if (priceInput) {
      priceInput.addEventListener("input", () => {
        state.packagePrice = priceInput.value;
        scheduleLiveUpdate();
      });
      priceInput.addEventListener("change", () => {
        state.packagePrice = priceInput.value;
        invalidateFrom(1);
      });
    }

    const pkgWifi = mount.querySelector("#dc-v2-pkg-wifi");
    if (pkgWifi) {
      pkgWifi.addEventListener("change", () => {
        state.packageWifiIncluded = pkgWifi.checked;
        invalidateFrom(2);
      });
    }
    const pkgGrat = mount.querySelector("#dc-v2-pkg-grat");
    if (pkgGrat) {
      pkgGrat.addEventListener("change", () => {
        state.packageGratuitiesIncluded = pkgGrat.checked;
        invalidateFrom(2);
      });
    }

    const wifiFare = mount.querySelector("#dc-v2-wifi-fare");
    if (wifiFare) {
      wifiFare.addEventListener("change", () => {
        state.wifiInFare = wifiFare.checked;
        if (state.wifiInFare) state.wouldBuyWifi = false;
        invalidateFrom(2);
        renderApp();
      });
    }
    const wifiBuy = mount.querySelector("#dc-v2-wifi-buy");
    if (wifiBuy) {
      wifiBuy.addEventListener("change", () => {
        state.wouldBuyWifi = wifiBuy.checked;
        invalidateFrom(2);
      });
    }

    mount.querySelectorAll("[data-qty-delta]").forEach(button => {
      button.addEventListener("click", () => {
        const key = button.getAttribute("data-qty-key");
        const delta = Number(button.getAttribute("data-qty-delta")) || 0;
        state.qty[key] = Math.max(0, Math.floor(sanitizeNonNegative(state.qty[key])) + delta);
        scheduleLiveUpdate();
        renderApp();
      });
    });

    mount.querySelectorAll("[data-qty-input]").forEach(input => {
      input.addEventListener("input", () => {
        const key = input.getAttribute("data-qty-input");
        state.qty[key] = input.value;
        scheduleLiveUpdate();
      });
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-qty-input");
        state.qty[key] = Math.max(0, Math.floor(sanitizeNonNegative(input.value)));
        renderApp();
      });
    });

    mount.querySelectorAll("[data-continue]").forEach(button => {
      button.addEventListener("click", () => continueFrom(Number(button.getAttribute("data-continue"))));
    });
    mount.querySelectorAll("[data-back]").forEach(button => {
      button.addEventListener("click", () => {
        const stage = Number(button.getAttribute("data-back"));
        editStage(Math.max(1, stage - 1));
      });
    });
    mount.querySelectorAll("[data-edit-stage]").forEach(button => {
      button.addEventListener("click", () => editStage(Number(button.getAttribute("data-edit-stage"))));
    });
    const restartBtn = mount.querySelector("[data-restart]");
    if (restartBtn) restartBtn.addEventListener("click", restart);

    mount.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target && event.target.id === "dc-v2-package-price") {
        if (stage1Ready()) continueFrom(1);
      }
    });
  }

  async function init() {
    mount = document.getElementById(MOUNT_ID) || document.querySelector("[data-dc-calculator-v2]");
    if (!mount) {
      console.error("[drinks-calculator-v2] Mount element was not found.");
      return;
    }

    mount.innerHTML = `<div class="dc-v2"><p class="dc-v2-status">Loading calculator…</p></div>`;

    try {
      const linesPayload = await fetchJson(LINES_API_URL, REQUEST_TIMEOUT_MS);
      if (!linesPayload || !linesPayload.success || !Array.isArray(linesPayload.lines)) {
        throw new Error("Unable to load cruise lines.");
      }
      lines = linesPayload.lines.slice().sort((a, b) =>
        a.cruise_line_name.localeCompare(b.cruise_line_name, undefined, { sensitivity: "base" })
      );

      const initialLine = getLineParam();
      if (initialLine) {
        await loadLineDetail(initialLine);
      } else {
        line = null;
        packages = [];
      }

      activeStage = 1;
      completed = { 1: false, 2: false, 3: false, 4: false };
      renderApp();
    } catch (_error) {
      showFatalError();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
