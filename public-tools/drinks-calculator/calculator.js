/**
 * 101cruise public Drinks Calculator — reusable page 2.
 *
 * Mounts into: <div id="101cruise-drinks-calculator"></div>
 * URL: /drinks-calculator?line=<id|slug>
 *
 * Comparison math matches the existing Squarespace / Apps Script calculator.
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-drinks-calculator";
  const INTRO_PAGE_URL = "/public-tools/drinks-calculator/intro-preview.html";
  const CALCULATOR_PAGE_URL = "/drinks-calculator";
  const SCRIPT_EL = document.currentScript;

  const ICON_CURRENCY = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10"></path><path d="M15 9.5c0-1.4-1.3-2-3-2s-3 .7-3 2 1.3 1.7 3 2.1 3 .8 3 2.1-1.3 2-3 2-3-.7-3-2"></path></svg>`;
  const ICON_WIFI = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5a9 9 0 0 1 14 0"></path><path d="M8.5 15.5a5 5 0 0 1 7 0"></path><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"></circle></svg>`;
  const ICON_DATE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4"></path><path d="M16 3v4"></path><path d="M4 10h16"></path></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>`;
  const ICON_CALC = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"></rect><path d="M8 7h8"></path><path d="M8 12h2"></path><path d="M11.5 12h2"></path><path d="M15 12h1"></path><path d="M8 16h2"></path><path d="M11.5 16h2"></path><path d="M15 16h1"></path></svg>`;

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

  function getScriptOrigin() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    const scripts = document.querySelectorAll('script[src*="drinks-calculator/calculator.js"]');
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
  const LINE_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-line`;
  const LINES_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-lines`;

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

  function getMount() {
    return document.getElementById(MOUNT_ID) || document.querySelector("[data-dc-calculator]");
  }

  function getLineParam() {
    return String(new URLSearchParams(window.location.search).get("line") || "").trim();
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

  function money(value, currency) {
    const symbolMap = {
      USD: "US$",
      AUD: "AU$",
      NZD: "NZ$",
      GBP: "£",
      EUR: "€"
    };
    const symbol = symbolMap[currency] || `${currency} $`;
    return symbol + Number(value).toFixed(2);
  }

  function sheetNumber(line, fieldName) {
    return Number(line[fieldName]) || 0;
  }

  function isWifiEffectivelyFree(line) {
    const label = String(line.wifi_price_label || "").trim().toLowerCase();
    if (label === "free" || label === "included" || label === "complimentary") return true;
    if (line.wifi_included && (line.wifi_package_price == null || Number(line.wifi_package_price) === 0)) {
      return true;
    }
    return false;
  }

  function wifiPurchasePrice(line) {
    if (isWifiEffectivelyFree(line)) return 0;
    return Number(line.wifi_package_price) || 0;
  }

  function wifiStatusLabel(line) {
    if (isWifiEffectivelyFree(line)) return "Included";
    if (line.wifi_package_price != null || line.wifi_included) return "Not included";
    return "Not listed";
  }

  function buildWifiInformation(line) {
    const parts = [];
    if (isWifiEffectivelyFree(line)) {
      parts.push("Wi-Fi appears to be included for this cruise line.");
    } else if (line.wifi_package_price != null) {
      parts.push(`Typical Wi-Fi package about ${money(line.wifi_package_price, line.currency)} per day.`);
    } else if (line.wifi_price_label) {
      parts.push(`Wi-Fi: ${line.wifi_price_label}.`);
    }
    if (line.wifi_notes) parts.push(line.wifi_notes);
    return parts.join(" ").trim();
  }

  /* Existing calculator comparison engine (ported, formulas unchanged). */
  function calculateComparison(line, inputs) {
    const currency = line.currency || "USD";
    const packagePrice = Number(inputs.packagePrice) || 0;
    const cruiseNights = Number(inputs.cruiseNights) || 0;
    const gratuityPercent = Number(line.gratuity_percent) || 0;
    const wifiIncluded = line.wifi_included === true || isWifiEffectivelyFree(line);
    const wifiPrice = inputs.includeWifi ? wifiPurchasePrice(line) : 0;

    const dailyDrinks =
      (Number(inputs.qty.beer) || 0) * sheetNumber(line, "beer_price") +
      (Number(inputs.qty.wine) || 0) * sheetNumber(line, "wine_price") +
      (Number(inputs.qty.cocktail) || 0) * sheetNumber(line, "cocktail_price") +
      (Number(inputs.qty.spirit) || 0) * sheetNumber(line, "spirits_mixer_price") +
      (Number(inputs.qty.coffee) || 0) * sheetNumber(line, "premium_coffee_price") +
      (Number(inputs.qty.soft) || 0) * sheetNumber(line, "soft_drink_price") +
      (Number(inputs.qty.juice) || 0) * sheetNumber(line, "juice_price") +
      (Number(inputs.qty.water) || 0) * sheetNumber(line, "bottled_water_price");

    const dailyGratuities = dailyDrinks * (gratuityPercent / 100);
    const buyAsYouGoDailyTotal = dailyDrinks + dailyGratuities + wifiPrice;
    const packageDailyTotal = packagePrice;
    const totalBuyAsYouGo = buyAsYouGoDailyTotal * cruiseNights;
    const totalPackage = packageDailyTotal * cruiseNights;
    const dailyDifference = buyAsYouGoDailyTotal - packageDailyTotal;
    const cruiseDifference = totalBuyAsYouGo - totalPackage;

    let recommendationKind = "close";
    let recommendationTitle = "You’re very close to break-even.";
    let recommendationBody =
      "The difference is small on these estimates. Convenience and budgeting certainty may still matter. This is a guide only and is not guaranteed.";

    if (dailyDifference > 5) {
      recommendationKind = "good";
      recommendationTitle = "The package appears to offer better value.";
      recommendationBody = `Based on your estimate, you could save around ${money(dailyDifference, currency)} per day, or ${money(cruiseDifference, currency)} over your cruise. This is a guide only and is not guaranteed.`;
    } else if (dailyDifference < -5) {
      recommendationKind = "bad";
      recommendationTitle = "Buying drinks individually appears to cost less.";
      recommendationBody = `Based on your estimate, paying as you go could cost around ${money(Math.abs(dailyDifference), currency)} less per day, or ${money(Math.abs(cruiseDifference), currency)} less over your cruise. This is a guide only and is not guaranteed.`;
    }

    return {
      currency,
      packagePrice,
      cruiseNights,
      gratuityPercent,
      wifiIncluded,
      wifiPrice,
      dailyDrinks,
      dailyGratuities,
      buyAsYouGoDailyTotal,
      packageDailyTotal,
      totalBuyAsYouGo,
      totalPackage,
      cruiseDifference,
      recommendationKind,
      recommendationTitle,
      recommendationBody
    };
  }

  function renderTopBar(line, lines) {
    const options = (lines || []).map(item => {
      const slug = item.cruise_line_slug || slugify(item.cruise_line_name);
      const selected =
        String(item.cruise_line_id) === String(line.cruise_line_id) ||
        slug === String(line.cruise_line_slug || slugify(line.cruise_line_name));
      return `<option value="${escapeHtml(slug)}" ${selected ? "selected" : ""}>${escapeHtml(item.cruise_line_name)}</option>`;
    }).join("");

    return `
      <div class="dc-calc-topbar">
        <a class="dc-calc-back" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a>
        <div class="dc-calc-change-wrap">
          <label class="dc-calc-label" for="dc-change-line" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Change cruise line</label>
          <select id="dc-change-line" class="dc-calc-change-select" aria-label="Change cruise line">
            <option value="">Change cruise line</option>
            ${options}
          </select>
        </div>
      </div>
    `;
  }

  function renderHeader(line) {
    const logo = line.logo_url
      ? `<img class="dc-calc-logo" src="${escapeHtml(line.logo_url)}" alt="${escapeHtml(line.cruise_line_name)} logo">`
      : `<div class="dc-calc-logo-fallback">${escapeHtml(line.cruise_line_name)}</div>`;

    return `
      <header class="dc-calc-header">
        ${logo}
        <div>
          <h1 class="dc-calc-heading">Is the Drinks Package Worth It?</h1>
          <p class="dc-calc-sub">Using typical onboard pricing for ${escapeHtml(line.cruise_line_name)}. Prices last verified ${escapeHtml(formatDisplayDate(line.last_verified_at))}.</p>
        </div>
        <aside class="dc-calc-meta" aria-label="Cruise line pricing summary">
          <div class="dc-calc-meta-row">
            <span class="dc-calc-meta-icon">${ICON_CURRENCY}</span>
            <span>Currency</span>
            <strong>${escapeHtml(line.currency || "USD")}</strong>
          </div>
          <div class="dc-calc-meta-row">
            <span class="dc-calc-meta-icon">${ICON_WIFI}</span>
            <span>Wi-Fi</span>
            <strong>${escapeHtml(wifiStatusLabel(line))}</strong>
          </div>
          <div class="dc-calc-meta-row">
            <span class="dc-calc-meta-icon">${ICON_DATE}</span>
            <span>Last verified</span>
            <strong>${escapeHtml(formatDisplayDate(line.last_verified_at))}</strong>
          </div>
        </aside>
      </header>
    `;
  }

  function renderInfoPanel(line) {
    const wifi = buildWifiInformation(line) || "No Wi-Fi notes listed for this cruise line.";
    const gratuity = line.gratuity_percent != null
      ? `Typical drink gratuity around ${Number(line.gratuity_percent)}% is included in the pay-as-you-go estimate.`
      : "Gratuity information is not listed for this cruise line.";
    const packageNotes = line.specialty_dining_notes || "No package notes listed for this cruise line.";
    const general = line.general_notes || "Prices are typical onboard rates and may vary by ship, sailing and promotion.";

    return `
      <section class="dc-calc-info" aria-labelledby="dc-info-title">
        <h2 id="dc-info-title">Important package information</h2>
        <div class="dc-calc-info-grid">
          <article class="dc-calc-info-block">
            <h3>Wi-Fi</h3>
            <p>${escapeHtml(wifi)}</p>
          </article>
          <article class="dc-calc-info-block">
            <h3>Gratuities</h3>
            <p>${escapeHtml(gratuity)}</p>
          </article>
          <article class="dc-calc-info-block">
            <h3>Package notes</h3>
            <p>${escapeHtml(packageNotes)}</p>
          </article>
          <article class="dc-calc-info-block">
            <h3>Important to know</h3>
            <p>${escapeHtml(general)}</p>
          </article>
        </div>
      </section>
    `;
  }

  function renderQtyRows() {
    return DRINK_FIELDS.map(field => `
      <div class="dc-calc-qty-row" data-qty-key="${escapeHtml(field.key)}">
        <span class="dc-calc-qty-icon" aria-hidden="true">${field.icon}</span>
        <span class="dc-calc-qty-label">${escapeHtml(field.label)}</span>
        <div class="dc-calc-stepper">
          <button type="button" data-step="-1" aria-label="Decrease ${escapeHtml(field.label)}">−</button>
          <output data-qty-output>0</output>
          <button type="button" data-step="1" aria-label="Increase ${escapeHtml(field.label)}">+</button>
        </div>
      </div>
    `).join("");
  }

  function renderIncludedFare(line, lines) {
    return `
      <section class="dc-calc">
        ${renderTopBar(line, lines)}
        ${renderHeader(line)}
        <div class="dc-calc-included">
          <h2>Drinks are already included in your cruise fare.</h2>
          <p>A drinks-package comparison isn’t needed for this cruise line. Review the Wi-Fi and package notes below for anything that may still be useful.</p>
        </div>
        ${renderInfoPanel(line)}
      </section>
    `;
  }

  function renderCalculator(line, lines) {
    const wifiFree = isWifiEffectivelyFree(line);
    const wifiBlock = wifiFree
      ? `<p class="dc-calc-wifi-auto">Wi-Fi is already included for this cruise line.</p>`
      : `
        <div class="dc-calc-field">
          <span class="dc-calc-label" id="dc-wifi-label">Would you otherwise purchase Wi-Fi?</span>
          <div class="dc-calc-toggle" role="group" aria-labelledby="dc-wifi-label">
            <button type="button" data-wifi="yes" class="is-active">Yes, I would</button>
            <button type="button" data-wifi="no">No</button>
          </div>
        </div>
      `;

    return `
      <section class="dc-calc">
        ${renderTopBar(line, lines)}
        ${renderHeader(line)}

        <div class="dc-calc-grid" id="dc-calc-form">
          <section class="dc-calc-card" aria-labelledby="dc-package-title">
            <h2 id="dc-package-title">Your Package</h2>
            <div class="dc-calc-field">
              <label class="dc-calc-label" for="dc-package-price">Package price per person, per day (${escapeHtml(line.currency || "USD")})</label>
              <input class="dc-calc-input" id="dc-package-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="85.00">
            </div>
            <div class="dc-calc-field">
              <label class="dc-calc-label" for="dc-cruise-nights">How many nights is your cruise?</label>
              <input class="dc-calc-input" id="dc-cruise-nights" type="number" inputmode="numeric" min="1" step="1" value="7">
            </div>
            ${wifiBlock}
          </section>

          <section class="dc-calc-card" aria-labelledby="dc-day-title">
            <h2 id="dc-day-title">Your Typical Day</h2>
            <div class="dc-calc-qty-list" id="dc-qty-list">
              ${renderQtyRows()}
            </div>
          </section>
        </div>

        <div class="dc-calc-actions">
          <button class="dc-calc-button" id="dc-calc-submit" type="button">
            ${ICON_CALC}
            <span>Calculate my comparison</span>
          </button>
        </div>

        <div class="dc-calc-results" id="dc-calc-results" hidden></div>
        ${renderInfoPanel(line)}
      </section>
    `;
  }

  function readQuantities(root) {
    const qty = {};
    DRINK_FIELDS.forEach(field => {
      const row = root.querySelector(`[data-qty-key="${field.key}"]`);
      const output = row && row.querySelector("[data-qty-output]");
      qty[field.key] = Number(output && output.textContent) || 0;
    });
    return qty;
  }

  function bindQuantityControls(root) {
    root.querySelectorAll("[data-qty-key]").forEach(row => {
      const output = row.querySelector("[data-qty-output]");
      row.querySelectorAll("[data-step]").forEach(button => {
        button.addEventListener("click", () => {
          const step = Number(button.getAttribute("data-step")) || 0;
          output.textContent = String(Math.max(0, (Number(output.textContent) || 0) + step));
        });
      });
    });
  }

  function bindWifiToggle(root, state) {
    const buttons = root.querySelectorAll("[data-wifi]");
    if (!buttons.length) {
      state.includeWifi = false;
      return;
    }
    state.includeWifi = true;
    buttons.forEach(button => {
      button.addEventListener("click", () => {
        buttons.forEach(item => item.classList.toggle("is-active", item === button));
        state.includeWifi = button.getAttribute("data-wifi") === "yes";
      });
    });
  }

  function bindChangeLine(root) {
    const select = root.querySelector("#dc-change-line");
    if (!select) return;
    select.addEventListener("change", () => {
      const slug = String(select.value || "").trim();
      if (!slug) return;
      const url = new URL(CALCULATOR_PAGE_URL, window.location.origin);
      url.searchParams.set("line", slug);
      window.location.assign(url.toString());
    });
  }

  function renderResults(container, result) {
    container.hidden = false;
    const gratLabel = result.gratuityPercent
      ? `Drink gratuities (${result.gratuityPercent}%)`
      : "Drink gratuities";

    container.innerHTML = `
      <h2 class="dc-calc-results-title">Your results</h2>
      <div class="dc-calc-figures">
        <article class="dc-calc-figure is-package">
          <p class="dc-calc-figure-label">Package per day</p>
          <p class="dc-calc-figure-value">${escapeHtml(money(result.packageDailyTotal, result.currency))}</p>
        </article>
        <article class="dc-calc-figure is-payg">
          <p class="dc-calc-figure-label">Buy as you go per day</p>
          <p class="dc-calc-figure-value">${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</p>
        </article>
        <article class="dc-calc-figure is-diff">
          <p class="dc-calc-figure-label">Difference over ${escapeHtml(String(result.cruiseNights))} nights</p>
          <p class="dc-calc-figure-value">${escapeHtml(money(Math.abs(result.cruiseDifference), result.currency))}</p>
        </article>
      </div>

      <div class="dc-calc-results-body">
        <table class="dc-calc-breakdown">
          <thead>
            <tr>
              <th></th>
              <th>Package</th>
              <th>Buy as you go</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Drinks</td>
              <td>Included</td>
              <td>${escapeHtml(money(result.dailyDrinks, result.currency))}</td>
            </tr>
            <tr>
              <td>${escapeHtml(gratLabel)}</td>
              <td>Included</td>
              <td>${escapeHtml(money(result.dailyGratuities, result.currency))}</td>
            </tr>
            <tr>
              <td>Wi-Fi</td>
              <td>${result.wifiIncluded ? "Included" : "Not included"}</td>
              <td>${escapeHtml(money(result.wifiPrice, result.currency))}</td>
            </tr>
            <tr class="is-total">
              <td>Total per day</td>
              <td>${escapeHtml(money(result.packageDailyTotal, result.currency))}</td>
              <td>${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</td>
            </tr>
            <tr class="is-total">
              <td>Total for ${escapeHtml(String(result.cruiseNights))} nights</td>
              <td>${escapeHtml(money(result.totalPackage, result.currency))}</td>
              <td>${escapeHtml(money(result.totalBuyAsYouGo, result.currency))}</td>
            </tr>
          </tbody>
        </table>

        <aside class="dc-calc-recommendation is-${escapeHtml(result.recommendationKind)}">
          <div class="dc-calc-rec-icon" aria-hidden="true">${ICON_CHECK}</div>
          <strong>${escapeHtml(result.recommendationTitle)}</strong>
          <p>${escapeHtml(result.recommendationBody)}</p>
        </aside>
      </div>

      <p class="dc-calc-disclaimer">
        Average onboard prices are estimates and may vary by ship, sailing, itinerary and currency. This comparison is a guide only.
      </p>
    `;
  }

  function bindCalculator(root, line) {
    const state = { includeWifi: !isWifiEffectivelyFree(line) };
    bindQuantityControls(root);
    bindWifiToggle(root, state);
    bindChangeLine(root);

    const submit = root.querySelector("#dc-calc-submit");
    const results = root.querySelector("#dc-calc-results");
    if (!submit || !results) return;

    submit.addEventListener("click", () => {
      const packagePrice = Number(root.querySelector("#dc-package-price")?.value) || 0;
      const cruiseNights = Number(root.querySelector("#dc-cruise-nights")?.value) || 0;

      if (packagePrice <= 0) {
        results.hidden = false;
        results.innerHTML = `<p class="dc-calc-status is-error">Please enter the drinks package price per day.</p>`;
        return;
      }
      if (cruiseNights <= 0) {
        results.hidden = false;
        results.innerHTML = `<p class="dc-calc-status is-error">Please enter how many nights your cruise is.</p>`;
        return;
      }

      const result = calculateComparison(line, {
        packagePrice,
        cruiseNights,
        includeWifi: state.includeWifi,
        qty: readQuantities(root)
      });
      renderResults(results, result);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function loadLine(lineParam) {
    const response = await fetch(`${LINE_API_URL}?line=${encodeURIComponent(lineParam)}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.success || !payload.line) {
      throw new Error((payload && payload.message) || "Calculator rates are not available right now.");
    }
    return payload.line;
  }

  async function loadLines() {
    try {
      const response = await fetch(LINES_API_URL, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !payload.success || !Array.isArray(payload.lines)) return [];
      return payload.lines.map(line => ({
        ...line,
        cruise_line_slug: slugify(line.cruise_line_name)
      }));
    } catch (_error) {
      return [];
    }
  }

  async function init() {
    const mount = getMount();
    if (!mount) {
      console.error("[drinks-calculator] Mount element was not found.");
      return;
    }

    const lineParam = getLineParam();
    if (!lineParam) {
      mount.innerHTML = `
        <section class="dc-calc">
          <p class="dc-calc-status is-error">Choose a cruise line to open the calculator.</p>
          <p><a class="dc-calc-back" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a></p>
        </section>
      `;
      return;
    }

    mount.innerHTML = `<section class="dc-calc"><p class="dc-calc-status">Loading calculator…</p></section>`;

    try {
      const [line, lines] = await Promise.all([loadLine(lineParam), loadLines()]);
      if (line.drinks_included_in_fare) {
        mount.innerHTML = renderIncludedFare(line, lines);
        bindChangeLine(mount);
        return;
      }
      mount.innerHTML = renderCalculator(line, lines);
      bindCalculator(mount, line);
    } catch (error) {
      console.error("[drinks-calculator] Failed to load line", error);
      mount.innerHTML = `
        <section class="dc-calc">
          <p class="dc-calc-status is-error">${escapeHtml(error.message || "Unable to load this calculator.")}</p>
          <p><a class="dc-calc-back" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a></p>
        </section>
      `;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
