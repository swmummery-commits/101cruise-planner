/**
 * 101cruise public Drinks Calculator — V1.5
 *
 * Single-page V1 layout + V2 package / Wi-Fi / gratuity intelligence.
 * Mounts into: <div id="101cruise-drinks-calculator"></div>
 * URL: /drinks-calculator?line=<id|slug>
 *
 * Visitor inputs are temporary browser state only and are never stored.
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-drinks-calculator";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const INTRO_PAGE_URL = "https://101cruise.com.au/cruise-drinks-calculator";
  const CALCULATOR_PAGE_URL = "https://101cruise.com.au/drinks-calculator";
  const SCRIPT_EL = document.currentScript;
  const REQUEST_TIMEOUT_MS = 12000;
  const INPUT_DEBOUNCE_MS = 250;
  const OWN_PACKAGE_ID = "__own__";

  const ICON_CURRENCY = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10"></path><path d="M15 9.5c0-1.4-1.3-2-3-2s-3 .7-3 2 1.3 1.7 3 2.1 3 .8 3 2.1-1.3 2-3 2-3-.7-3-2"></path></svg>`;
  const ICON_WIFI = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5a9 9 0 0 1 14 0"></path><path d="M8.5 15.5a5 5 0 0 1 7 0"></path><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"></circle></svg>`;
  const ICON_DATE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4"></path><path d="M16 3v4"></path><path d="M4 10h16"></path></svg>`;

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
    return NETLIFY_ORIGIN;
  }

  const TOOLS_ORIGIN = getScriptOrigin();
  const LINES_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-lines`;
  const V2_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-v2`;

  let mount = null;
  let lines = [];
  let line = null;
  let packages = [];
  let debounceTimer = null;
  let detailsOpen = false;
  let trackedPageOpen = false;
  let trackedToolStarted = false;
  let trackedToolCompleted = false;

  function usageMeta() {
    const slug = line?.slug || getLineParam() || "";
    return slug ? { line_slug: String(slug).slice(0, 120), source: "public_drinks_calculator" } : { source: "public_drinks_calculator" };
  }

  function trackPublic(eventType) {
    try {
      if (!window.CruiseUsage) return;
      if (typeof window.getCruiseUsageContext !== "function") {
        window.getCruiseUsageContext = function () {
          return { surface: "public_tools", metadata: usageMeta() };
        };
      }
      if (eventType === "page_open" && typeof window.CruiseUsage.trackPageOpen === "function") {
        window.CruiseUsage.trackPageOpen("public_drinks_calculator", usageMeta());
        return;
      }
      if (typeof window.CruiseUsage.trackEvent === "function") {
        window.CruiseUsage.trackEvent("public_drinks_calculator", eventType, usageMeta());
      }
    } catch (_error) {
      /* never block the calculator on analytics */
    }
  }

  function maybeTrackCompletion() {
    if (trackedToolCompleted || !canCalculate()) return;
    trackedToolCompleted = true;
    trackPublic("tool_completed");
  }

  const state = {
    packageId: "",
    packagePrice: "",
    packageWifiIncluded: false,
    packageGratuitiesIncluded: false,
    nights: 7,
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
          throw new Error((payload && payload.message) || "Request failed");
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
    if (!pkg) return { wifiIncluded: false, gratuitiesIncluded: false };
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

  function applyPackageSelection(packageId) {
    state.packageId = packageId;
    const pkg = selectedPackage();
    if (!pkg) return;
    if (pkg.isOwn) return;
    if (pkg.typical_daily_price != null) {
      state.packagePrice = String(pkg.typical_daily_price);
    }
    state.packageWifiIncluded = pkg.wifi_included === true;
    state.packageGratuitiesIncluded = pkg.gratuities_included === true;
  }

  function autoSelectDefaultPackage() {
    // Start with no package selected. Keep a selection only if it is still valid.
    if (!state.packageId) return;
    if (state.packageId === OWN_PACKAGE_ID) return;
    if (!packages.some(pkg => String(pkg.id) === String(state.packageId))) {
      state.packageId = "";
      state.packagePrice = "";
    }
  }

  /**
   * V2 comparison engine (unchanged logic).
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
    DRINK_FIELDS.forEach(field => {
      const unit = priceOrNull(line, field.priceKey);
      const qty = Math.max(0, Math.floor(sanitizeNonNegative(state.qty[field.key])));
      if (unit == null) return;
      dailyDrinks += qty * unit;
    });

    const dailyDrinkGratuities = dailyDrinks * gratuityRate;
    const packageGratuities = flags.gratuitiesIncluded ? 0 : packagePrice * gratuityRate;

    let wifiOnBuyAsYouGo = 0;
    let wifiOnPackage = 0;
    let wifiDifferential = 0;
    let wifiExplanation = "Wi-Fi is not affecting this comparison.";

    if (wifiInFare) {
      wifiExplanation = "Wi-Fi is included in the cruise fare, so it cancels out of the comparison.";
    } else if (standaloneWifi != null && state.wouldBuyWifi) {
      // Always use the Admin Wi-Fi price on the buy-as-you-go side when the guest would buy Wi-Fi.
      wifiOnBuyAsYouGo = standaloneWifi;
      if (flags.wifiIncluded) {
        wifiOnPackage = 0;
        wifiDifferential = standaloneWifi;
        wifiExplanation =
          "Standalone Wi-Fi is added to the buy-as-you-go side only because the selected package includes Wi-Fi.";
      } else {
        // Package does not include Wi-Fi — same typical cost applies on both sides.
        wifiOnPackage = standaloneWifi;
        wifiDifferential = 0;
        wifiExplanation =
          "Wi-Fi would be purchased separately with either option. The typical Wi-Fi price from Admin is included on both sides.";
      }
    } else if (standaloneWifi != null) {
      wifiExplanation = "You indicated you would not normally buy Wi-Fi separately.";
    } else if (state.wouldBuyWifi) {
      wifiExplanation =
        "You would normally buy Wi-Fi, but a standalone Wi-Fi price is not listed for this cruise line.";
    }

    const packageDailyTotal = packagePrice + packageGratuities + wifiOnPackage;
    const buyAsYouGoDailyTotal = dailyDrinks + dailyDrinkGratuities + wifiOnBuyAsYouGo;
    const dailyDifference = buyAsYouGoDailyTotal - packageDailyTotal;
    const cruiseDifference = dailyDifference * nights;
    const totalPackage = packageDailyTotal * nights;
    const totalBuyAsYouGo = buyAsYouGoDailyTotal * nights;

    let recommendationKind = "borderline";
    let recommendationTitle = "You’re very close to break-even.";
    let recommendationLead = "Estimated difference";

    if (dailyDifference > 5) {
      recommendationKind = "excellent";
      recommendationTitle = "The package appears to offer better value.";
      recommendationLead = "Estimated saving";
    } else if (dailyDifference < -5) {
      recommendationKind = "not-recommended";
      recommendationTitle = "Buying drinks individually appears to cost less.";
      recommendationLead = "Estimated extra cost";
    }

    const reasons = [];
    if (dailyDrinks + dailyDrinkGratuities > packagePrice) {
      reasons.push("Drinks exceed package value");
    } else if (dailyDrinks + dailyDrinkGratuities < packagePrice) {
      reasons.push("Package price exceeds typical drink spend");
    }
    if (flags.wifiIncluded && wifiDifferential > 0) reasons.push("Wi-Fi adds value");
    if (flags.gratuitiesIncluded) reasons.push("Gratuities included");
    else if (packageGratuities > 0) reasons.push("Package gratuities added to package cost");

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
      wifiOnPackage,
      wifiDifferential,
      wifiExplanation,
      packageDailyTotal,
      buyAsYouGoDailyTotal,
      dailyDifference,
      cruiseDifference,
      totalPackage,
      totalBuyAsYouGo,
      recommendationKind,
      recommendationTitle,
      recommendationLead,
      reasons,
      flags,
      wifiInFare
    };
  }

  function canCalculate() {
    return Boolean(line) && sanitizeNonNegative(state.nights) > 0 && sanitizeNonNegative(state.packagePrice) > 0 && Boolean(selectedPackage());
  }

  function wifiStatusLabel(lineData) {
    if (lineData.wifi_included_in_fare) return "Included in fare";
    if (lineData.wifi_package_price != null) return "Available separately";
    const label = String(lineData.wifi_price_label || "").trim().toLowerCase();
    if (label === "free" || label === "included" || label === "complimentary") return "Included";
    return "Not listed";
  }

  function buildWifiInformation(lineData, pkg) {
    const parts = [];
    if (lineData.wifi_included_in_fare) {
      parts.push("Wi-Fi is recorded as included in the cruise fare for this line.");
    } else if (lineData.wifi_package_price != null) {
      parts.push(`Typical standalone Wi-Fi about ${money(lineData.wifi_package_price, lineData.currency)} per day.`);
    } else if (lineData.wifi_price_label) {
      parts.push(`Wi-Fi: ${lineData.wifi_price_label}.`);
    }
    if (pkg && !pkg.isOwn && pkg.wifi_included) {
      parts.push("The selected package includes Wi-Fi.");
    }
    if (lineData.wifi_notes) parts.push(lineData.wifi_notes);
    return parts.join(" ").trim();
  }

  function renderTopBar() {
    const options = (lines || [])
      .map(item => {
        const slug = item.cruise_line_slug || slugify(item.cruise_line_name);
        const selected =
          line &&
          (String(item.cruise_line_id) === String(line.cruise_line_id) ||
            slug === String(line.cruise_line_slug || slugify(line.cruise_line_name)));
        return `<option value="${escapeHtml(slug)}" ${selected ? "selected" : ""}>${escapeHtml(item.cruise_line_name)}</option>`;
      })
      .join("");

    return `
      <div class="dc-calc-topbar">
        <a class="dc-calc-back" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a>
        <div class="dc-calc-change-wrap">
          <label class="dc-calc-label dc-calc-visually-hidden" for="dc-change-line">Change cruise line</label>
          <select id="dc-change-line" class="dc-calc-change-select" aria-label="Change cruise line">
            <option value="">Change cruise line</option>
            ${options}
          </select>
        </div>
      </div>
    `;
  }

  function renderHeader() {
    const logo = line.logo_url
      ? `<img class="dc-calc-logo" src="${escapeHtml(line.logo_url)}" alt="${escapeHtml(line.cruise_line_name)} logo">`
      : `<div class="dc-calc-logo-fallback">${escapeHtml(line.cruise_line_name)}</div>`;

    return `
      <header class="dc-calc-header">
        ${logo}
        <div>
          <h1 class="dc-calc-heading">Is the Drinks Package Worth It?</h1>
          <p class="dc-calc-intro">Compare your onboard spending with your cruise line’s drinks packages in less than 30 seconds.</p>
          <p class="dc-calc-sub">Using typical onboard pricing for ${escapeHtml(line.cruise_line_name)}.</p>
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

  function packageDetailSections(pkg) {
    if (!pkg) return [];
    const sections = [];

    if (pkg.isOwn) {
      sections.push({
        title: "Custom package",
        body:
          "Enter the daily package price you have been quoted. Tick whether Wi-Fi and drink gratuities are included in that price so the comparison stays accurate."
      });
      if (line.general_notes) {
        sections.push({ title: "Important purchasing rules", body: line.general_notes });
      }
      if (line.specialty_dining_notes) {
        sections.push({ title: "Cruise line notes", body: line.specialty_dining_notes });
      }
      return sections;
    }

    if (pkg.notes) {
      sections.push({ title: "Package description & notes", body: pkg.notes });
    }

    const included = ["Drinks covered by this package (confirm exact inclusions for your sailing)"];
    if (pkg.wifi_included) included.push("Wi-Fi");
    if (pkg.gratuities_included) included.push("Drink gratuities");
    sections.push({ title: "What's included", body: `${included.join(". ")}.` });

    if (pkg.gratuities_included) {
      sections.push({
        title: "Gratuities",
        body: "Drink gratuities are included in this package price for the comparison."
      });
    } else if (line.gratuity_percent != null) {
      sections.push({
        title: "Gratuities",
        body: `Typical drink gratuity around ${Number(line.gratuity_percent)}% is applied when gratuities are not already included in the package price.`
      });
    } else {
      sections.push({
        title: "Gratuities",
        body: "Confirm whether drink gratuities are included in the package price for your sailing."
      });
    }

    if (line.general_notes) {
      sections.push({ title: "Important purchasing rules", body: line.general_notes });
    }
    if (line.specialty_dining_notes) {
      sections.push({ title: "Cruise line notes", body: line.specialty_dining_notes });
    }
    if (line.wifi_notes && pkg.wifi_included) {
      sections.push({ title: "Wi-Fi notes", body: line.wifi_notes });
    }

    return sections;
  }

  function renderPackageDetailPanel(pkg) {
    if (!pkg) return "";
    const sections = packageDetailSections(pkg);
    if (!sections.length) return "";
    const body = sections
      .map(
        section => `
          <div class="dc-calc-pkg-detail-section">
            <h4>${escapeHtml(section.title)}</h4>
            <p>${escapeHtml(section.body)}</p>
          </div>
        `
      )
      .join("");

    return `
      <div class="dc-calc-pkg-detail" data-pkg-detail aria-live="polite">
        <div class="dc-calc-pkg-detail-inner">
          <p class="dc-calc-pkg-detail-kicker">About this package</p>
          ${body}
        </div>
      </div>
    `;
  }

  function renderPackageCards() {
    const cards = packages
      .map(pkg => {
        const selected = String(state.packageId) === String(pkg.id);
        const currency = pkg.currency || line.currency || "USD";
        const priceLabel =
          pkg.typical_daily_price == null
            ? "Typical price not listed"
            : `${money(pkg.typical_daily_price, currency)}/day`;
        const tags = [];
        if (pkg.wifi_included) tags.push("Wi-Fi");
        if (pkg.gratuities_included) tags.push("Gratuities");
        return `
          <button type="button" class="dc-calc-pkg ${selected ? "is-selected" : ""}" data-package-id="${escapeHtml(pkg.id)}" aria-pressed="${selected ? "true" : "false"}">
            <span class="dc-calc-pkg-radio" aria-hidden="true"></span>
            <span class="dc-calc-pkg-copy">
              <strong>${escapeHtml(pkg.package_name)}</strong>
              <span class="dc-calc-pkg-price">${escapeHtml(priceLabel)}</span>
              ${tags.length ? `<span class="dc-calc-pkg-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>` : ""}
            </span>
          </button>
        `;
      })
      .join("");

    const ownSelected = state.packageId === OWN_PACKAGE_ID;
    return `
      <div class="dc-calc-pkg-list" role="listbox" aria-label="Package to compare">
        ${cards}
        <button type="button" class="dc-calc-pkg ${ownSelected ? "is-selected" : ""}" data-package-id="${OWN_PACKAGE_ID}" aria-pressed="${ownSelected ? "true" : "false"}">
          <span class="dc-calc-pkg-radio" aria-hidden="true"></span>
          <span class="dc-calc-pkg-copy">
            <strong>Enter my own package</strong>
            <span class="dc-calc-pkg-price">Custom price</span>
          </span>
        </button>
      </div>
    `;
  }

  function renderQtyRows() {
    return DRINK_FIELDS.map(field => {
      const unit = priceOrNull(line, field.priceKey);
      const unavailable = unit == null;
      return `
        <div class="dc-calc-qty-row" data-qty-key="${escapeHtml(field.key)}">
          <span class="dc-calc-qty-icon" aria-hidden="true">${field.icon}</span>
          <span class="dc-calc-qty-label">
            ${escapeHtml(field.label)}
            <span class="dc-calc-qty-avg">${unavailable ? "Pricing not available" : `avg ${money(unit, line.currency)}`}</span>
          </span>
          ${
            unavailable
              ? `<span class="dc-calc-qty-na">—</span>`
              : `<div class="dc-calc-stepper">
                  <button type="button" data-step="-1" aria-label="Decrease ${escapeHtml(field.label)}">−</button>
                  <output data-qty-output>${escapeHtml(state.qty[field.key] || 0)}</output>
                  <button type="button" data-step="1" aria-label="Increase ${escapeHtml(field.label)}">+</button>
                </div>`
          }
        </div>
      `;
    }).join("");
  }

  function renderInfoPanel() {
    const pkg = selectedPackage();
    const wifi = buildWifiInformation(line, pkg) || "No Wi-Fi notes listed for this cruise line.";
    const gratuity =
      line.gratuity_percent != null
        ? `Typical drink gratuity around ${Number(line.gratuity_percent)}% is used where gratuities are not already included.`
        : "Gratuity information is not listed for this cruise line.";
    const lastVerified = formatDisplayDate(
      (pkg && !pkg.isOwn && pkg.last_verified_at) || line.last_verified_at
    );
    const purchaseAdvice =
      "Cruise lines often offer better package pricing before departure. Check prices before you sail.";

    let packageNotesCard = "";
    if (pkg) {
      const packageNotes =
        (!pkg.isOwn && pkg.notes) ||
        line.specialty_dining_notes ||
        "No package notes listed for this selection.";
      packageNotesCard = `
        <article class="dc-calc-info-card">
          <h3>Package Notes</h3>
          <p>${escapeHtml(packageNotes)}</p>
        </article>
      `;
    }

    return `
      <section class="dc-calc-info" aria-labelledby="dc-info-title">
        <h2 id="dc-info-title">Important Package Information</h2>
        <div class="dc-calc-info-stack">
          <article class="dc-calc-info-card">
            <h3>Wi-Fi</h3>
            <p>${escapeHtml(wifi)}</p>
          </article>
          <article class="dc-calc-info-card">
            <h3>Gratuities</h3>
            <p>${escapeHtml(gratuity)}</p>
          </article>
          ${packageNotesCard}
          <article class="dc-calc-info-card">
            <h3>Purchase Advice</h3>
            <p>${escapeHtml(purchaseAdvice)}</p>
          </article>
          <article class="dc-calc-info-card">
            <h3>Last Verified</h3>
            <p>${escapeHtml(lastVerified)}</p>
          </article>
        </div>
      </section>
    `;
  }

  function renderResults() {
    if (!canCalculate()) {
      return `
        <div class="dc-calc-results" id="dc-calc-results" aria-live="polite">
          <p class="dc-calc-status">Choose a package and enter a price to see your live comparison.</p>
        </div>
      `;
    }

    maybeTrackCompletion();

    const result = calculateComparison();
    if (!result) {
      return `<div class="dc-calc-results" id="dc-calc-results"><p class="dc-calc-status is-error">Unable to calculate right now.</p></div>`;
    }

    const reasons =
      result.reasons.length > 0
        ? `<ul class="dc-calc-rec-reasons">${result.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
        : "";

    const gratLabel =
      result.gratuityPercent != null
        ? `Drink gratuities (${result.gratuityPercent}%)`
        : "Drink gratuities";

    const savingLine = `${money(Math.abs(result.cruiseDifference), result.currency)} over your ${result.nights}-night cruise`;

    return `
      <div class="dc-calc-results" id="dc-calc-results" aria-live="polite">
        <div class="dc-calc-figures">
          <article class="dc-calc-figure is-package">
            <p class="dc-calc-figure-label">Package cost / day</p>
            <p class="dc-calc-figure-value">${escapeHtml(money(result.packageDailyTotal, result.currency))}</p>
          </article>
          <article class="dc-calc-figure is-payg">
            <p class="dc-calc-figure-label">Buy as you go / day</p>
            <p class="dc-calc-figure-value">${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</p>
          </article>
          <article class="dc-calc-figure is-diff">
            <p class="dc-calc-figure-label">Difference / day</p>
            <p class="dc-calc-figure-value">${escapeHtml(money(result.dailyDifference, result.currency))}</p>
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
                <td>${result.flags.gratuitiesIncluded ? "Included" : escapeHtml(money(result.packageGratuities, result.currency))}</td>
                <td>${escapeHtml(money(result.dailyDrinkGratuities, result.currency))}</td>
              </tr>
              <tr>
                <td>Wi-Fi</td>
                <td>${
                  result.flags.wifiIncluded
                    ? "Included"
                    : result.wifiOnPackage > 0
                      ? escapeHtml(money(result.wifiOnPackage, result.currency))
                      : "Not in package"
                }</td>
                <td>${escapeHtml(money(result.wifiOnBuyAsYouGo, result.currency))}</td>
              </tr>
              <tr class="is-total">
                <td>Total per day</td>
                <td>${escapeHtml(money(result.packageDailyTotal, result.currency))}</td>
                <td>${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</td>
              </tr>
              <tr class="is-total">
                <td>Total for ${escapeHtml(String(result.nights))} nights</td>
                <td>${escapeHtml(money(result.totalPackage, result.currency))}</td>
                <td>${escapeHtml(money(result.totalBuyAsYouGo, result.currency))}</td>
              </tr>
            </tbody>
          </table>

          <aside class="dc-calc-recommendation is-${escapeHtml(result.recommendationKind)}">
            <strong>${escapeHtml(result.recommendationTitle)}</strong>
            <p class="dc-calc-rec-lead">${escapeHtml(result.recommendationLead)}</p>
            <p class="dc-calc-rec-saving">${escapeHtml(savingLine)}</p>
            ${
              reasons
                ? `<div class="dc-calc-hero-reason"><p class="dc-calc-hero-reason-label">Why?</p>${reasons}</div>`
                : ""
            }
            <p class="dc-calc-rec-estimate">This is still an estimate. Actual onboard prices may vary.</p>
          </aside>
        </div>

        <details class="dc-calc-details" ${detailsOpen ? "open" : ""}>
          <summary>Show calculation breakdown</summary>
          <ul class="dc-calc-details-list">
            <li><span>Package price</span><strong>${escapeHtml(money(result.packagePrice, result.currency))}</strong></li>
            <li><span>Drink spend</span><strong>${escapeHtml(money(result.dailyDrinks, result.currency))}</strong></li>
            <li><span>Drink gratuities</span><strong>${escapeHtml(money(result.dailyDrinkGratuities, result.currency))}</strong></li>
            <li><span>Wi-Fi (buy as you go)</span><strong>${escapeHtml(money(result.wifiOnBuyAsYouGo, result.currency))}</strong></li>
            <li><span>Wi-Fi (package side)</span><strong>${
              result.flags.wifiIncluded
                ? "Included"
                : escapeHtml(money(result.wifiOnPackage, result.currency))
            }</strong></li>
            <li><span>Package gratuities</span><strong>${escapeHtml(money(result.packageGratuities, result.currency))}</strong></li>
            <li><span>Daily total (package)</span><strong>${escapeHtml(money(result.packageDailyTotal, result.currency))}</strong></li>
            <li><span>Daily total (buy as you go)</span><strong>${escapeHtml(money(result.buyAsYouGoDailyTotal, result.currency))}</strong></li>
            <li><span>Cruise total difference</span><strong>${escapeHtml(money(result.cruiseDifference, result.currency))}</strong></li>
          </ul>
          <p class="dc-calc-details-note">${escapeHtml(result.wifiExplanation)}</p>
        </details>

        <p class="dc-calc-disclaimer">
          Average onboard prices are estimates and may vary by ship, sailing, itinerary and currency. This comparison is a guide only. Remember, drinks packages are almost always cheaper when purchased before you sail than once you're onboard.
        </p>
      </div>
    `;
  }

  function renderIncludedFare() {
    return `
      <section class="dc-calc">
        ${renderTopBar()}
        ${renderHeader()}
        <div class="dc-calc-included">
          <h2>Drinks are already included in your cruise fare.</h2>
          <p>A drinks-package comparison isn’t needed for this cruise line. Review the Wi-Fi and package notes below for anything that may still be useful.</p>
        </div>
        ${renderInfoPanel()}
      </section>
    `;
  }

  function renderCalculator() {
    const own = state.packageId === OWN_PACKAGE_ID;
    const pkg = selectedPackage();
    const showPriceField = own || (pkg && pkg.typical_daily_price == null) || Boolean(state.packageId);
    const wifiInFare = state.wifiInFare === true;
    const packageNotes = pkg ? renderPackageDetailPanel(pkg) : "";

    const ownFlags = own
      ? `
        <div class="dc-calc-checks dc-calc-own-flags">
          <label class="dc-calc-check">
            <input type="checkbox" id="dc-pkg-wifi" ${state.packageWifiIncluded ? "checked" : ""}>
            <span>This package includes Wi-Fi</span>
          </label>
          <label class="dc-calc-check">
            <input type="checkbox" id="dc-pkg-grat" ${state.packageGratuitiesIncluded ? "checked" : ""}>
            <span>This package price includes drink gratuities</span>
          </label>
        </div>
      `
      : "";

    return `
      <section class="dc-calc">
        ${renderTopBar()}
        ${renderHeader()}

        <section class="dc-calc-card dc-calc-cruise-setup" aria-label="Cruise setup" id="dc-calc-form">
          <div class="dc-calc-cruise-setup-grid">
            <div class="dc-calc-field">
              <label class="dc-calc-label" for="dc-cruise-nights">How many nights is your cruise?</label>
              <div class="dc-calc-nights-row">
                <button type="button" class="dc-calc-nights-btn" data-nights-delta="-1" aria-label="Decrease nights">−</button>
                <input class="dc-calc-input" id="dc-cruise-nights" type="number" inputmode="numeric" min="1" step="1" value="${escapeHtml(state.nights)}">
                <button type="button" class="dc-calc-nights-btn" data-nights-delta="1" aria-label="Increase nights">+</button>
              </div>
            </div>
            <div class="dc-calc-field">
              <span class="dc-calc-label">Wi-Fi</span>
              <div class="dc-calc-checks">
                <label class="dc-calc-check">
                  <input type="checkbox" id="dc-wifi-fare" ${wifiInFare ? "checked" : ""}>
                  <span>Wi-Fi is already included in my cruise fare</span>
                </label>
                ${
                  wifiInFare
                    ? `<p class="dc-calc-caveat">Because Wi-Fi is included in the fare, it cancels out of the comparison.</p>`
                    : `<label class="dc-calc-check">
                        <input type="checkbox" id="dc-wifi-buy" ${state.wouldBuyWifi ? "checked" : ""}>
                        <span>If Wi-Fi wasn’t included, I would normally purchase Wi-Fi separately</span>
                      </label>`
                }
              </div>
            </div>
          </div>
        </section>

        <section class="dc-calc-card dc-calc-package-section" aria-labelledby="dc-package-title">
          <h2 id="dc-package-title">Your Package</h2>
          <div class="dc-calc-package-layout">
            <aside class="dc-calc-package-notes-col" aria-label="Selected package notes">
              ${
                packageNotes ||
                `<div class="dc-calc-package-notes-empty">
                  <p>Select a package to see what’s included and any important notes.</p>
                </div>`
              }
            </aside>
            <div class="dc-calc-package-choices">
              <span class="dc-calc-label">Package to compare</span>
              ${renderPackageCards()}
              ${
                showPriceField
                  ? `<div class="dc-calc-field dc-calc-package-price-field">
                      <label class="dc-calc-label" for="dc-package-price">${own ? "Your package price per day" : "Typical price (editable)"} (${escapeHtml(line.currency || "USD")})</label>
                      <input class="dc-calc-input" id="dc-package-price" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(state.packagePrice)}" placeholder="0.00">
                      ${
                        !own && pkg && pkg.typical_daily_price != null
                          ? `<p class="dc-calc-caveat">Typical price — your sailing offer may differ.</p>`
                          : ""
                      }
                    </div>`
                  : ""
              }
              ${ownFlags}
            </div>
          </div>
        </section>

        <div class="dc-calc-workspace">
          <section class="dc-calc-card" aria-labelledby="dc-day-title">
            <h2 id="dc-day-title">Your Typical Day</h2>
            <p class="dc-calc-day-guide">
              ${
                state.packageId
                  ? "Now estimate what you'd typically drink each day and we'll compare the cost of buying drinks individually with the package you've selected."
                  : "Choose a package first, then estimate what you'd typically drink each day."
              }
            </p>
            <div class="dc-calc-qty-list" id="dc-qty-list">
              ${renderQtyRows()}
            </div>
            <p class="dc-calc-live">Results update automatically as you change your selections.</p>
          </section>

          <section class="dc-calc-results-panel" aria-label="Comparison results">
            ${renderResults()}
          </section>
        </div>

        ${renderInfoPanel()}
      </section>
    `;
  }

  let revealedPackageDetailId = null;

  function revealSelectedPackageDetail() {
    if (!mount) return;
    const panel = mount.querySelector("[data-pkg-detail]");
    if (!panel) {
      revealedPackageDetailId = null;
      return;
    }
    const currentId = String(state.packageId || "");
    if (currentId && currentId === revealedPackageDetailId) {
      panel.classList.add("is-open");
      return;
    }
    revealedPackageDetailId = currentId || null;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        panel.classList.add("is-open");
      });
    });
  }

  function renderApp() {
    if (!mount || !line) return;
    if (line.drinks_included_in_fare && (!packages || packages.length === 0)) {
      mount.innerHTML = renderIncludedFare();
      bindEvents();
      return;
    }
    mount.innerHTML = renderCalculator();
    bindEvents();
    revealSelectedPackageDetail();
  }

  function updateResultsOnly() {
    if (!mount) return;
    const resultsHost = mount.querySelector("#dc-calc-results");
    if (!resultsHost) {
      renderApp();
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderResults();
    const next = wrapper.firstElementChild;
    if (next) resultsHost.replaceWith(next);
    const details = mount.querySelector(".dc-calc-details");
    if (details) {
      details.addEventListener("toggle", () => {
        detailsOpen = details.open;
      });
    }
  }

  function scheduleLiveUpdate(immediate) {
    clearTimeout(debounceTimer);
    const run = () => {
      if (immediate) renderApp();
      else updateResultsOnly();
    };
    if (immediate) run();
    else debounceTimer = setTimeout(run, INPUT_DEBOUNCE_MS);
  }

  function bindEvents() {
    if (!mount) return;

    const lineSelect = mount.querySelector("#dc-change-line");
    if (lineSelect) {
      lineSelect.addEventListener("change", () => {
        const slug = String(lineSelect.value || "").trim();
        if (!slug) return;
        const url = new URL(CALCULATOR_PAGE_URL);
        url.searchParams.set("line", slug);
        window.location.assign(url.toString());
      });
    }

    mount.querySelectorAll("[data-package-id]").forEach(button => {
      button.addEventListener("click", () => {
        applyPackageSelection(button.getAttribute("data-package-id"));
        renderApp();
      });
    });

    const priceInput = mount.querySelector("#dc-package-price");
    if (priceInput) {
      priceInput.addEventListener("input", () => {
        state.packagePrice = priceInput.value;
        scheduleLiveUpdate(false);
      });
      priceInput.addEventListener("change", () => {
        state.packagePrice = priceInput.value;
        scheduleLiveUpdate(true);
      });
    }

    const nightsInput = mount.querySelector("#dc-cruise-nights");
    if (nightsInput) {
      nightsInput.addEventListener("input", () => {
        state.nights = nightsInput.value;
        scheduleLiveUpdate(false);
      });
      nightsInput.addEventListener("change", () => {
        state.nights = Math.max(1, Math.floor(sanitizeNonNegative(nightsInput.value)) || 1);
        scheduleLiveUpdate(true);
      });
    }

    mount.querySelectorAll("[data-nights-delta]").forEach(button => {
      button.addEventListener("click", () => {
        const delta = Number(button.getAttribute("data-nights-delta")) || 0;
        state.nights = Math.max(1, Math.floor(sanitizeNonNegative(state.nights)) + delta);
        const nightsInput = mount.querySelector("#dc-cruise-nights");
        if (nightsInput) nightsInput.value = String(state.nights);
        scheduleLiveUpdate(false);
      });
    });

    const pkgWifi = mount.querySelector("#dc-pkg-wifi");
    if (pkgWifi) {
      pkgWifi.addEventListener("change", () => {
        state.packageWifiIncluded = pkgWifi.checked;
        scheduleLiveUpdate(true);
      });
    }
    const pkgGrat = mount.querySelector("#dc-pkg-grat");
    if (pkgGrat) {
      pkgGrat.addEventListener("change", () => {
        state.packageGratuitiesIncluded = pkgGrat.checked;
        scheduleLiveUpdate(true);
      });
    }

    const wifiFare = mount.querySelector("#dc-wifi-fare");
    if (wifiFare) {
      wifiFare.addEventListener("change", () => {
        state.wifiInFare = wifiFare.checked;
        if (state.wifiInFare) state.wouldBuyWifi = false;
        scheduleLiveUpdate(true);
      });
    }
    const wifiBuy = mount.querySelector("#dc-wifi-buy");
    if (wifiBuy) {
      wifiBuy.addEventListener("change", () => {
        state.wouldBuyWifi = wifiBuy.checked;
        scheduleLiveUpdate(true);
      });
    }

    mount.querySelectorAll("[data-qty-key]").forEach(row => {
      const key = row.getAttribute("data-qty-key");
      const output = row.querySelector("[data-qty-output]");
      row.querySelectorAll("[data-step]").forEach(button => {
        button.addEventListener("click", () => {
          const step = Number(button.getAttribute("data-step")) || 0;
          state.qty[key] = Math.max(0, Math.floor(sanitizeNonNegative(state.qty[key])) + step);
          if (output) output.textContent = String(state.qty[key]);
          scheduleLiveUpdate(false);
        });
      });
    });

    const details = mount.querySelector(".dc-calc-details");
    if (details) {
      details.addEventListener("toggle", () => {
        detailsOpen = details.open;
      });
    }
  }

  function showFatalError() {
    if (!mount) return;
    mount.innerHTML = `
      <section class="dc-calc">
        <p class="dc-calc-status is-error">We couldn’t load the calculator information. Please try again shortly.</p>
        <p><button type="button" class="dc-calc-button" id="dc-calc-retry">Retry</button></p>
        <p><a class="dc-calc-back" href="${escapeHtml(INTRO_PAGE_URL)}">← Back to intro</a></p>
      </section>
    `;
    const retry = mount.querySelector("#dc-calc-retry");
    if (retry) {
      retry.addEventListener("click", () => {
        mount.removeAttribute("data-dc-calculator-ready");
        init();
      });
    }
  }

  async function init() {
    mount =
      document.getElementById(MOUNT_ID) ||
      document.querySelector("[data-dc-calculator]") ||
      document.getElementById("101cruise-drinks-calculator-v2") ||
      document.querySelector("[data-dc-calculator-v2]");
    if (!mount) {
      console.error("[drinks-calculator] Mount element was not found.");
      return;
    }

    if (mount.getAttribute("data-dc-calculator-ready") === "1") {
      return;
    }
    mount.setAttribute("data-dc-calculator-ready", "1");

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
      const [linesPayload, detailPayload] = await Promise.all([
        fetchJson(LINES_API_URL, REQUEST_TIMEOUT_MS),
        fetchJson(`${V2_API_URL}?line=${encodeURIComponent(lineParam)}`, REQUEST_TIMEOUT_MS)
      ]);

      if (!linesPayload || !linesPayload.success || !Array.isArray(linesPayload.lines)) {
        throw new Error("Unable to load cruise lines.");
      }
      if (!detailPayload || !detailPayload.success || !detailPayload.line) {
        throw new Error((detailPayload && detailPayload.message) || "Unable to load this calculator.");
      }

      lines = linesPayload.lines
        .slice()
        .sort((a, b) =>
          a.cruise_line_name.localeCompare(b.cruise_line_name, undefined, { sensitivity: "base" })
        );
      line = detailPayload.line;
      packages = Array.isArray(detailPayload.packages) ? detailPayload.packages : [];
      state.wifiInFare = line.wifi_included_in_fare === true;
      // If Admin has a standalone Wi-Fi price and it is not in the fare, assume the guest would buy Wi-Fi.
      state.wouldBuyWifi =
        !state.wifiInFare && priceOrNull(line, "wifi_package_price") != null;
      autoSelectDefaultPackage();
      if (!trackedPageOpen) {
        trackedPageOpen = true;
        trackPublic("page_open");
      }
      if (!trackedToolStarted) {
        trackedToolStarted = true;
        trackPublic("tool_started");
      }
      renderApp();
      maybeTrackCompletion();
    } catch (_error) {
      mount.removeAttribute("data-dc-calculator-ready");
      showFatalError();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
