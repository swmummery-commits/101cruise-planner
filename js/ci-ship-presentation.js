/**
 * Shared Cruise Intelligence ship presentation — My Cruise + public Featured Cruise pages.
 * Browser global: CiShipPresentation
 */
(function (root) {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

const SHIP_ROOM_COLORS = ["#8DD9BF", "#5BBFA3", "#245C4E", "#9AA7A3", "#6FA894", "#3D7A6A"];
const SHIP_NOT_LISTED = "Not listed";

const SHIP_SUMMARY_ICONS = {
  passengers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  staterooms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 18h20"/></svg>`,
  crew: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M12 12v3"/><path d="M9.5 16.5h5"/></svg>`,
  built: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>`,
  refurbished: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`
};

const SHIP_GLANCE_ICONS = {
  restaurants: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  bars: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8z"/></svg>`,
  pools: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M2 16c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M12 4v8"/><path d="M8 8h8"/></svg>`,
  hot_tubs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M7 12v4a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-4"/><path d="M9 7c.5-1 1.5-2 3-2s2.5 1 3 2"/><path d="M8 4c.5-1 1.5-2 4-2s3.5 1 4 2"/></svg>`,
  specialty_dining: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  spa: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  gym: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m17.5 6.5 1 1"/><path d="m6.5 6.5-1 1"/><path d="M12 12v9"/><path d="M8 9h8"/><path d="M9 22h6"/><circle cx="12" cy="5" r="2"/></svg>`,
  theatre: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`,
  casino: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><path d="M12 9v6"/></svg>`,
  kids_club: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`,
  shopping: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`
};

function getBookingShipName(cruise = null) {
  const booking = cruise?._preview_booking || customerBooking || {};
  return String(booking.cruise_ship || cruise?.ship_name || "").trim();
}

function getBookingCruiseLine(cruise = null) {
  const booking = cruise?._preview_booking || customerBooking || {};
  return String(booking.cruise_line || cruise?.cruise_line || "").trim();
}

function readFacilityValue(facilities, keys) {
  if (!facilities || typeof facilities !== "object" || Array.isArray(facilities)) return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(facilities, key) && facilities[key] !== undefined) {
      return facilities[key];
    }
  }
  return null;
}

function formatShipNumber(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return new Intl.NumberFormat("en-AU").format(Math.round(number));
}

function formatShipYear(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(value);
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return String(Math.round(number));
}

function formatShipStatValue(value, key) {
  if (value === null || value === undefined || value === "" || value === SHIP_NOT_LISTED) {
    return SHIP_NOT_LISTED;
  }
  if (key === "built" || key === "refurbished") return formatShipYear(value);
  return formatShipNumber(value);
}

function formatShipCountDisplay(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(value);
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return new Intl.NumberFormat("en-AU").format(Math.round(number));
}

function formatShipYesNoDisplay(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (value === 1) return "Yes";
    if (value === 0) return "No";
  }
  const text = String(value).trim().toLowerCase();
  if (["yes", "true", "y"].includes(text)) return "Yes";
  if (["no", "false", "n"].includes(text)) return "No";
  return SHIP_NOT_LISTED;
}

function humaniseShipRoomLabel(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function buildShipStateroomReconciliation(ship) {
  const reconcile = typeof CiStateroomReconciliation !== "undefined" ? CiStateroomReconciliation : null;
  if (!reconcile) {
    return {
      status: "invalid",
      authoritativeTotal: ship?.stateroom_count ?? null,
      rawBreakdownSum: 0,
      renderedBreakdownSum: 0,
      difference: null,
      renderedCategories: [],
      omittedOverlappingCategories: [],
      addedOtherCount: 0,
      canRenderDonut: false,
      publicMessage: "Detailed room-type mix unavailable"
    };
  }
  return reconcile.reconcileStateroomDisplay({
    stateroomCount: ship?.stateroom_count,
    stateroomBreakdown: ship?.stateroom_breakdown,
    legacyBreakdown: ship?.stateroom_types || ship?.cabin_type_summary || null
  });
}

function buildShipAccommodationFromReconciliation(reconciliation) {
  const colors = SHIP_ROOM_COLORS;
  return (reconciliation?.renderedCategories || []).map((room, index) => ({
    ...room,
    color: colors[index % colors.length]
  }));
}

function shipRoomCategoryRank(label) {
  const n = String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (n === "inside" || n === "interior") return 1;
  if (n === "oceanview" || n === "ocean view") return 2;
  if (n === "balcony" || n === "veranda") return 3;
  if (n === "suite" || n === "suites") return 4;
  return 100;
}

function sortShipRoomCategories(rooms) {
  return (rooms || [])
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const rankDiff = shipRoomCategoryRank(a.room.label) - shipRoomCategoryRank(b.room.label);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map(({ room }) => room);
}

function buildShipOnboardGlance(facilities) {
  const numericRows = [
    { label: "Dining Options", icon: "restaurants", keys: ["restaurants", "restaurant_count", "restaurant"] },
    { label: "Bars", icon: "bars", keys: ["bars", "bar_count", "bar"] },
    { label: "Pools", icon: "pools", keys: ["pools", "pool_count", "pool"] },
    { label: "Hot tubs", icon: "hot_tubs", keys: ["hot_tubs", "hotTubs", "hot_tub_count", "jacuzzis"] },
    { label: "Specialty dining", icon: "specialty_dining", keys: ["specialty_dining", "specialtyDining", "specialty_restaurants"] }
  ];

  const yesNoRows = [
    { label: "Spa", icon: "spa", keys: ["spa", "spa_wellness", "has_spa"] },
    { label: "Gym", icon: "gym", keys: ["gym", "fitness", "fitness_centre", "fitness_center", "has_gym"] },
    { label: "Theatre", icon: "theatre", keys: ["theatre", "theater", "has_theatre", "has_theater"] },
    { label: "Casino", icon: "casino", keys: ["casino", "has_casino"] },
    { label: "Kids club", icon: "kids_club", keys: ["kids_club", "kidsClub", "youth_programmes", "youth_programs", "has_kids_club"] },
    { label: "Shopping", icon: "shopping", keys: ["shopping", "shops", "has_shopping"] }
  ];

  return [
    ...numericRows.map((row) => ({
      label: row.label,
      icon: row.icon,
      display: formatShipCountDisplay(readFacilityValue(facilities, row.keys)),
      kind: "count"
    })),
    ...yesNoRows.map((row) => ({
      label: row.label,
      icon: row.icon,
      display: formatShipYesNoDisplay(readFacilityValue(facilities, row.keys)),
      kind: "yesno"
    }))
  ];
}

function buildShipChipList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function buildShipProfileFromBase44(ship, { shipName, cruiseLine } = {}) {
  const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const passengers = ship?.passenger_capacity;
  const crew = ship?.crew_count;
  const decks = ship?.deck_count;
  const stateroomReconciliation = buildShipStateroomReconciliation(ship);
  const staterooms = stateroomReconciliation.authoritativeTotal;
  const accommodation = buildShipAccommodationFromReconciliation(stateroomReconciliation);
  const ciFac = typeof CiShipFacilities !== "undefined" ? CiShipFacilities : null;
  const specScale = typeof CiShipSpecScale !== "undefined" ? CiShipSpecScale : null;
  const specifications = specScale ? specScale.buildShipSpecificationRows(ship) : [];
  const scaleFacts = specScale ? specScale.buildShipScaleRows(ship) : [];

  const exclusiveRaw = readFacilityValue(facilities, ["exclusive_areas", "exclusiveAreas", "exclusive"]);
  const specialtyRaw = readFacilityValue(facilities, ["specialty_features", "specialtyFeatures", "signature_features"]);
  const exclusiveAreas = ciFac
    ? ciFac.normalizeExclusiveAreasForDisplay(exclusiveRaw)
    : buildShipChipList(exclusiveRaw).map((name) => ({ name, description: "", legacyString: true }));
  const specialtyFeatures = ciFac
    ? ciFac.normalizeSpecialtyFeaturesForDisplay(specialtyRaw)
    : buildShipChipList(specialtyRaw).map((name) => ({ name, description: "", icon_key: "sparkles", legacyString: true }));

  return {
    name: ship?.name || shipName || "My ship",
    cruiseLine: cruiseLine || "",
    status: ship?.current_status || "Active",
    summary: {
      passengers,
      staterooms,
      crew,
      built: ship?.year_built,
      refurbished: ship?.year_refurbished
    },
    onboardGlance: buildShipOnboardGlance(facilities),
    specifications,
    accommodation,
    stateroomReconciliation,
    scaleFacts,
    exclusiveAreas,
    specialtyFeatures,
    deckPlanUrl: ship?.deck_plan_url || null
  };
}

async function fetchShipFromBase44(shipName, cruiseLine = "") {
  const params = new URLSearchParams();
  params.set("name", shipName);
  if (cruiseLine) params.set("cruise_line", cruiseLine);

  const response = await fetch(`/.netlify/functions/get-ship?${params.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json().catch(() => ({ success: false, error: "Invalid response" }));

  if (
    response.status === 404 ||
    response.status === 409 ||
    data.error === "SHIP_NOT_FOUND" ||
    data.error === "SHIP_AMBIGUOUS"
  ) {
    return { ok: false, notFound: true, source: data.source || null };
  }

  if (!response.ok || data.success === false || !data.ship) {
    return { ok: false, notFound: false, source: data.source || null };
  }

  if (data.source === "base44") {
    console.info("Ship lookup used Base44 fallback — missing Supabase Cruise Intelligence record");
  }

  return { ok: true, ship: data.ship, source: data.source || null };
}

function renderShipSummaryCard(ship) {
  const stats = [
    { key: "passengers", label: "Guests", value: ship.summary.passengers },
    ...(ship.summary.staterooms != null && ship.summary.staterooms !== ""
      ? [{ key: "staterooms", label: "Staterooms", value: ship.summary.staterooms }]
      : []),
    { key: "crew", label: "Crew", value: ship.summary.crew },
    { key: "built", label: "Built", value: ship.summary.built },
    { key: "refurbished", label: "Refurbished", value: ship.summary.refurbished }
  ];

  return `
    <section class="ship-summary-card" aria-label="Ship summary">
      <div class="ship-summary-grid">
        ${stats.map(stat => {
          const numeric = Number(stat.value);
          const isNumeric = stat.value !== null && stat.value !== undefined && stat.value !== "" && Number.isFinite(numeric);
          if (!isNumeric) {
            return `
              <div class="ship-summary-stat">
                <span class="ship-summary-icon" aria-hidden="true">${SHIP_SUMMARY_ICONS[stat.key]}</span>
                <div class="ship-summary-copy">
                  <strong class="ship-summary-value is-static">${escapeHtml(SHIP_NOT_LISTED)}</strong>
                  <span class="ship-summary-label">${escapeHtml(stat.label)}</span>
                </div>
              </div>
            `;
          }
          return `
            <div class="ship-summary-stat">
              <span class="ship-summary-icon" aria-hidden="true">${SHIP_SUMMARY_ICONS[stat.key]}</span>
              <div class="ship-summary-copy">
                <strong class="ship-summary-value" data-ship-stat="${stat.key}" data-ship-target="${numeric}">0</strong>
                <span class="ship-summary-label">${escapeHtml(stat.label)}</span>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderShipOnboardGlance(items) {
  const metrics = (items || []).filter(item => item.kind === "count");
  const statuses = (items || []).filter(item => item.kind !== "count");
  const focusIcons = new Set(["restaurants", "bars", "pools"]);

  const renderMetric = (item) => {
    const display = item.display || SHIP_NOT_LISTED;
    const isEmpty = display === SHIP_NOT_LISTED;
    const isFocus = focusIcons.has(item.icon) && !isEmpty;
    return `
      <div class="ship-glance-item is-metric ${isFocus ? "is-focus" : ""} ${isEmpty ? "is-empty" : ""}">
        <span class="ship-glance-icon" aria-hidden="true">${SHIP_GLANCE_ICONS[item.icon] || SHIP_GLANCE_ICONS.shopping}</span>
        ${isEmpty
          ? `<span class="ship-glance-empty">${escapeHtml(SHIP_NOT_LISTED)}</span>`
          : `<strong class="ship-glance-metric">${escapeHtml(display)}</strong>`}
        <span class="ship-glance-label">${escapeHtml(item.label)}</span>
      </div>
    `;
  };

  const renderStatus = (item) => {
    const display = item.display || SHIP_NOT_LISTED;
    const isEmpty = display === SHIP_NOT_LISTED;
    const valueClass = display === "Yes"
      ? "ship-glance-value ship-glance-yes"
      : display === "No"
        ? "ship-glance-value is-no"
        : "ship-glance-empty";

    return `
      <div class="ship-glance-item is-status ${isEmpty ? "is-empty" : ""}">
        <span class="ship-glance-icon" aria-hidden="true">${SHIP_GLANCE_ICONS[item.icon] || SHIP_GLANCE_ICONS.shopping}</span>
        <span class="ship-glance-label">${escapeHtml(item.label)}</span>
        <span class="${valueClass}">${escapeHtml(display)}</span>
      </div>
    `;
  };

  return `
    <div class="ship-glance">
      <div class="ship-glance-grid ship-glance-metrics">
        ${metrics.map(renderMetric).join("")}
      </div>
      <div class="ship-glance-grid ship-glance-status">
        ${statuses.map(renderStatus).join("")}
      </div>
    </div>
  `;
}

function renderShipHero(ship, opts) {
  opts = opts || {};
  const cruiseLineLogo = opts.cruiseLineLogo || "";
  const shipImage = opts.shipImage || "";
  const hasImage = Boolean(shipImage);
  return `
    <header class="ship-hero ${hasImage ? "has-image" : ""}">
      <div class="ship-hero-copy">
        ${cruiseLineLogo ? `<img class="ship-hero-line-logo" src="${escapeHtml(cruiseLineLogo)}" alt="${escapeHtml(ship.cruiseLine || "Cruise line")} logo">` : ""}
        <${opts.headingTag || "h1"} class="ship-identity-name">${escapeHtml(ship.name)}</${opts.headingTag || "h1"}>
        ${ship.cruiseLine ? `<p class="ship-hero-line ship-identity-line">${escapeHtml(ship.cruiseLine)}</p>` : ""}
      </div>
      ${hasImage ? `
        <div class="ship-hero-media" aria-hidden="true">
          <img class="ship-hero-image" src="${escapeHtml(shipImage)}" alt="">
        </div>
      ` : ""}
    </header>
  `;
}

const SPACE_RATIO_EXPLAINER = {
  intro: "Space ratio is a general guide to how much ship space is available per guest. Higher numbers usually indicate more room in public areas.",
  bands: [
    "Under 30 — Compact and lively",
    "30–40 — Standard spaciousness",
    "41–50 — Comfortably spacious",
    "51–75 — Very spacious",
    "Over 75 — Exceptionally spacious"
  ],
  outro: "This is a general comparison guide. Ship layout and the number of guests sailing can also affect how spacious a ship feels."
};

function renderSpaceRatioExplainerContent() {
  return `
    <p>${escapeHtml(SPACE_RATIO_EXPLAINER.intro)}</p>
    <ul>
      ${SPACE_RATIO_EXPLAINER.bands.map((band) => `<li>${escapeHtml(band)}</li>`).join("")}
    </ul>
    <p>${escapeHtml(SPACE_RATIO_EXPLAINER.outro)}</p>
  `;
}

function isMobileSpaceRatioView() {
  const maxWidth = typeof CiShipSpecScale !== "undefined" ? CiShipSpecScale.MOBILE_SPACE_RATIO_MAX_WIDTH : 760;
  return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
}

function portalSpaceRatioPopover(popover) {
  if (!popover || popover.parentElement === document.body) return;
  popover.__spaceRatioHome = {
    parent: popover.parentElement,
    next: popover.nextSibling
  };
  document.body.appendChild(popover);
  popover.classList.add("ship-space-ratio-popover--portaled");
}

function restoreSpaceRatioPopover(popover) {
  if (!popover?.__spaceRatioHome) return;
  const { parent, next } = popover.__spaceRatioHome;
  popover.classList.remove("ship-space-ratio-popover--portaled");
  if (next && next.parentElement === parent) {
    parent.insertBefore(popover, next);
  } else {
    parent.appendChild(popover);
  }
  delete popover.__spaceRatioHome;
}

function positionSpaceRatioPopover(trigger, popover) {
  const margin = 12;
  const gap = 8;
  const maxWidth = 320;
  portalSpaceRatioPopover(popover);
  popover.hidden = false;
  popover.style.position = "fixed";
  popover.style.width = `${Math.min(maxWidth, window.innerWidth - margin * 2)}px`;
  popover.style.top = "0px";
  popover.style.left = "0px";

  const group = trigger.closest(".ship-stat-space-ratio-group");
  const column = trigger.closest(".ship-info-card");
  const grid = trigger.closest(".ship-info-grid");
  const roomTypesCard = grid?.querySelector(".ship-info-card:nth-child(2)");
  const triggerRect = trigger.getBoundingClientRect();
  const anchorRect = (group || trigger).getBoundingClientRect();
  const columnRect = column?.getBoundingClientRect() || anchorRect;
  const avoidRects = roomTypesCard ? [roomTypesCard.getBoundingClientRect()] : [];
  const popoverRect = popover.getBoundingClientRect();
  const compute = typeof CiShipSpecScale !== "undefined" ? CiShipSpecScale.computeSpaceRatioPopoverPosition : null;
  const coords = compute
    ? compute({
        triggerRect,
        anchorRect,
        columnRect,
        avoidRects,
        popoverWidth: popoverRect.width,
        popoverHeight: popoverRect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin,
        gap
      })
    : { top: anchorRect.bottom + gap, left: columnRect.right - popoverRect.width, placement: "below" };

  popover.style.top = `${coords.top}px`;
  popover.style.left = `${coords.left}px`;
  popover.dataset.placement = coords.placement;
}

function renderShipStatRow(row) {
  if (row.kind === "space_ratio") {
    const explainerContent = renderSpaceRatioExplainerContent();
    return `
      <div class="ship-stat-space-ratio-group">
        <div class="ship-stat-row ship-stat-row--space-ratio">
          <span class="ship-stat-label">
            ${escapeHtml(row.label)}
            <span class="ship-space-ratio-control">
              <button
                type="button"
                class="ship-space-ratio-trigger"
                data-ship-space-ratio-trigger
                aria-label="About space ratio"
                aria-expanded="false"
              >
                <span aria-hidden="true">i</span>
              </button>
              <div
                class="ship-space-ratio-popover"
                data-ship-space-ratio-popover
                role="dialog"
                aria-label="About space ratio"
                hidden
              >
                ${explainerContent}
              </div>
            </span>
          </span>
          <span class="ship-stat-value-stack">
            <strong>${escapeHtml(row.value)}</strong>
            ${row.interpretation ? `<span class="ship-space-ratio-interpretation">${escapeHtml(row.interpretation)}</span>` : ""}
          </span>
        </div>
        <div
          class="ship-space-ratio-inline-panel"
          data-ship-space-ratio-inline
          role="region"
          aria-label="About space ratio"
          hidden
        >
          ${explainerContent}
        </div>
      </div>
    `;
  }

  return `
    <div class="ship-stat-row">
      <span class="ship-stat-label">${escapeHtml(row.label)}</span>
      <strong class="ship-stat-value">${escapeHtml(row.value)}</strong>
    </div>
  `;
}

function renderShipStatRows(rows) {
  if (!rows?.length) return "";
  return `
    <div class="ship-stat-list">
      ${rows.map((row) => renderShipStatRow(row)).join("")}
    </div>
  `;
}

function renderShipSpecifications(specs) {
  return renderShipStatRows(specs);
}

function renderShipScaleFacts(facts) {
  return renderShipStatRows(facts);
}

function bindShipSpaceRatioExplainer() {
  const triggers = Array.from(document.querySelectorAll("[data-ship-space-ratio-trigger]"));
  if (!triggers.length) return;

  let openTrigger = null;
  let openPopover = null;
  let openInline = null;

  const closePopover = () => {
    if (openPopover) {
      openPopover.hidden = true;
      openPopover.style.top = "";
      openPopover.style.left = "";
      openPopover.style.width = "";
      restoreSpaceRatioPopover(openPopover);
    }
    if (openInline) openInline.hidden = true;
    if (openTrigger) openTrigger.setAttribute("aria-expanded", "false");
    openTrigger = null;
    openPopover = null;
    openInline = null;
  };

  const openExplainer = (trigger, popover, inlinePanel) => {
    closePopover();
    openTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    if (isMobileSpaceRatioView()) {
      inlinePanel.hidden = false;
      openInline = inlinePanel;
      return;
    }
    openPopover = popover;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => positionSpaceRatioPopover(trigger, popover));
    });
  };

  const repositionOpenPopover = () => {
    if (!openTrigger || !openPopover || openPopover.hidden || isMobileSpaceRatioView()) return;
    positionSpaceRatioPopover(openTrigger, openPopover);
  };

  if (!window.__shipSpaceRatioExplainerBound) {
    window.__shipSpaceRatioExplainerBound = true;
    document.addEventListener("click", (event) => {
      if (!openTrigger) return;
      const target = event.target;
      if (
        openPopover?.contains(target) ||
        openInline?.contains(target) ||
        openTrigger.contains(target)
      ) {
        return;
      }
      closePopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePopover();
    });
    window.addEventListener("resize", repositionOpenPopover);
    window.addEventListener("scroll", repositionOpenPopover, true);
  }

  triggers.forEach((trigger) => {
    const group = trigger.closest(".ship-stat-space-ratio-group");
    const control = trigger.closest(".ship-space-ratio-control");
    const popover = control?.querySelector("[data-ship-space-ratio-popover]");
    const inlinePanel = group?.querySelector("[data-ship-space-ratio-inline]");
    if (!popover || !inlinePanel) return;

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = openTrigger === trigger && (
        (openPopover && !openPopover.hidden) ||
        (openInline && !openInline.hidden)
      );
      if (isOpen) {
        closePopover();
        return;
      }
      openExplainer(trigger, popover, inlinePanel);
    });

    popover.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
}

function renderShipFeatureIcon(iconKey) {
  const icons = typeof CiShipFeatureIcons !== "undefined" ? CiShipFeatureIcons : null;
  if (icons && icons.renderFeatureIconHtml) {
    return icons.renderFeatureIconHtml(iconKey, "ship-feature-icon");
  }
  return `<span class="ship-feature-icon" aria-hidden="true"></span>`;
}

function renderShipFeatureListItem(item) {
  const name = item && (item.name || item.label || (typeof item === "string" ? item : ""));
  if (!name) return "";
  const description = item && item.description ? String(item.description).trim() : "";
  const icons = typeof CiShipFeatureIcons !== "undefined" ? CiShipFeatureIcons : null;
  const iconKey = icons
    ? icons.resolveShipFeatureIconKey(name, item && item.icon_key)
    : (item && item.icon_key) || "sparkles";
  return `
    <li class="ship-feature-item">
      ${renderShipFeatureIcon(iconKey)}
      <div class="ship-feature-copy">
        <span class="ship-feature-label">${escapeHtml(String(name))}</span>
        ${description ? `<p class="ship-feature-description planner-muted">${escapeHtml(description)}</p>` : ""}
      </div>
    </li>`;
}

function renderShipFeatureColumn(title, intro, items, modifierClass) {
  const list = Array.isArray(items) ? items.filter((item) => item && (item.name || item.label || typeof item === "string")) : [];
  const columnClass = modifierClass ? `ship-feature-column ${modifierClass}` : "ship-feature-column";
  return `
    <div class="${columnClass}">
      <h3>${escapeHtml(title)}</h3>
      <p class="ship-section-intro">${escapeHtml(intro)}</p>
      ${list.length
        ? `<ul class="ship-feature-list">${list.map(renderShipFeatureListItem).join("")}</ul>`
        : `<p class="ship-feature-unavailable planner-muted">${escapeHtml(SHIP_NOT_LISTED)}</p>`}
    </div>`;
}

function renderShipDeckPlansSubsection(ship) {
  return `
    <div class="ship-deck-subsection ship-reveal-block" style="--ship-delay:420ms">
      <div class="ship-deck-copy">
        <h3>Deck Plans</h3>
        ${
          ship?.deckPlanUrl
            ? `<a class="planner-button secondary ship-deck-button ship-deck-button--external" href="${escapeHtml(
                ship.deckPlanUrl
              )}" target="_blank" rel="noopener noreferrer">
          <span class="ship-deck-button-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 11h18"/></svg>
          </span>
          <span>Explore ${escapeHtml(String(ship.name || "Ship").trim())} Deck Plans</span>
          <span class="ship-deck-external-icon" aria-hidden="true" title="Opens in a new tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg>
          </span>
          <span class="sr-only"> (opens in a new tab)</span>
        </a>
        <p class="ship-muted">Explore the official deck plans and get to know every level before you sail.</p>`
            : `<p class="planner-muted">Deck plans are not yet available for this ship.</p>`
        }
      </div>
    </div>`;
}

function renderShipFeatureExperiences(exclusiveAreas, specialtyFeatures, ship) {
  const hasExclusive = Array.isArray(exclusiveAreas) && exclusiveAreas.length > 0;
  const hasSpecialty = Array.isArray(specialtyFeatures) && specialtyFeatures.length > 0;
  const deckPlansHtml = renderShipDeckPlansSubsection(ship || {});

  if (!hasExclusive && !hasSpecialty) {
    return `
      <section class="ship-section-card ship-feature-experiences ship-reveal-block" style="--ship-delay:280ms">
        <div class="ship-feature-experiences-grid ship-feature-experiences-grid--deck-only">
          ${deckPlansHtml}
        </div>
      </section>`;
  }

  return `
    <section class="ship-section-card ship-feature-experiences ship-reveal-block" style="--ship-delay:280ms">
      <div class="ship-feature-experiences-grid">
        ${renderShipFeatureColumn(
          "Exclusive Areas",
          "Quiet corners and elevated spaces made for your voyage.",
          exclusiveAreas,
          "ship-feature-column--exclusive"
        )}
        <div class="ship-feature-column-divider" aria-hidden="true"></div>
        ${renderShipFeatureColumn(
          "Specialty Features",
          "Signature experiences unique to this ship.",
          specialtyFeatures,
          "ship-feature-column--specialty"
        )}
        ${deckPlansHtml}
      </div>
    </section>`;
}

function renderShipRoomTypesUnavailable(message, detail) {
  return `
    <div class="ship-room-types-unavailable">
      <p class="ship-room-types-unavailable-title">${escapeHtml(message || "Detailed room-type mix unavailable")}</p>
      <p class="ship-room-types-unavailable-detail">${escapeHtml(
        detail || "The available room categories do not currently reconcile with the ship\u2019s published stateroom total."
      )}</p>
    </div>
  `;
}

function renderShipAccommodationChart(reconciliation, rooms) {
  if (!reconciliation?.canRenderDonut || !rooms.length) {
    return renderShipRoomTypesUnavailable(
      reconciliation?.publicMessage || "Detailed room-type mix unavailable",
      reconciliation?.status === "no_breakdown"
        ? "Room-type categories have not been listed for this ship yet."
        : undefined
    );
  }

  const showCentreTotal = reconciliation.centreMode === "total";
  const categorySum = rooms.reduce((sum, room) => sum + Number(room.value || 0), 0) || 1;
  const denominator = showCentreTotal ? Number(reconciliation.authoritativeTotal) : categorySum;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = rooms.map(room => {
    const portion = Number(room.value || 0) / denominator;
    const length = circumference * portion;
    const segment = {
      ...room,
      dasharray: `${length} ${circumference - length}`,
      dashoffset: -offset
    };
    offset += length;
    return segment;
  });

  const centreHtml = showCentreTotal
    ? `<strong>${formatShipStatValue(reconciliation.authoritativeTotal)}</strong><span>Staterooms</span>`
    : "";

  return `
    <div class="ship-accommodation-layout">
      <div class="ship-donut-wrap" aria-hidden="true">
        <svg class="ship-donut-chart" viewBox="0 0 140 140" role="presentation">
          <circle class="ship-donut-track" cx="70" cy="70" r="${radius}"></circle>
          ${segments.map((segment, index) => `
            <circle
              class="ship-donut-segment"
              cx="70"
              cy="70"
              r="${radius}"
              stroke="${escapeHtml(segment.color)}"
              stroke-dasharray="${segment.dasharray}"
              stroke-dashoffset="${segment.dashoffset}"
              style="--ship-donut-delay:${0.3 + index * 0.55}s"
            ></circle>
          `).join("")}
        </svg>
        <div class="ship-donut-centre${showCentreTotal ? "" : " is-blank"}">${centreHtml}</div>
      </div>
      <ul class="ship-room-legend">
        ${rooms.map(room => `
          <li>
            <span class="ship-room-swatch" style="background:${escapeHtml(room.color)}"></span>
            <span class="ship-room-label">${escapeHtml(room.label)}</span>
            <strong>${formatShipStatValue(room.value)}</strong>
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateShipSummaryStats() {
  return new Promise(resolve => {
    const nodes = Array.from(document.querySelectorAll("[data-ship-stat]"));
    if (!nodes.length) {
      resolve();
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      nodes.forEach(node => {
        const target = Number(node.getAttribute("data-ship-target") || 0);
        const key = node.getAttribute("data-ship-stat");
        node.textContent = formatShipStatValue(target, key);
      });
      resolve();
      return;
    }

    const duration = 3000;
    const start = performance.now();
    let remaining = nodes.length;

    nodes.forEach((node, index) => {
      const target = Number(node.getAttribute("data-ship-target") || 0);
      const key = node.getAttribute("data-ship-stat");
      const finishBias = 150 + (index / Math.max(nodes.length - 1, 1)) * 100;
      let lastShown = -1;

      const tick = now => {
        const elapsed = Math.max(0, now - start);
        const progress = Math.min(1, elapsed / (duration + finishBias));
        const value = Math.round(target * easeOutCubic(progress));
        if (value !== lastShown) {
          lastShown = value;
          node.textContent = formatShipStatValue(value, key);
        }
        if (progress < 1) {
          requestAnimationFrame(tick);
          return;
        }
        node.textContent = formatShipStatValue(target, key);
        remaining -= 1;
        if (remaining <= 0) resolve();
      };

      requestAnimationFrame(tick);
    });
  });
}









  function renderContentStage(profile) {
    return `
      <div class="ship-content-stage">
        <section class="ship-section-card ship-glance-section ship-reveal-block" style="--ship-delay:0ms">
          <h3>Onboard at a Glance</h3>
          <p class="ship-section-intro">Everything that makes life on board feel effortless.</p>
          ${renderShipOnboardGlance(profile.onboardGlance)}
        </section>

        <div class="ship-info-grid ship-reveal-block" style="--ship-delay:70ms">
          <section class="ship-section-card ship-info-card">
            <h3>Ship Specifications</h3>
            ${renderShipSpecifications(profile.specifications)}
          </section>

          <section class="ship-section-card ship-info-card">
            <h3>Room Types</h3>
            ${renderShipAccommodationChart(profile.stateroomReconciliation, profile.accommodation)}
          </section>

          <section class="ship-section-card ship-info-card">
            <h3>Ship Scale</h3>
            ${renderShipScaleFacts(profile.scaleFacts)}
          </section>
        </div>

        ${renderShipFeatureExperiences(profile.exclusiveAreas, profile.specialtyFeatures, profile)}
      </div>`;
  }

  function renderPresentationHtml(profile, options) {
    options = options || {};
    if (!profile) return renderUnavailableHtml(options.unavailableMessage);
    const mode = options.mode === "public" ? "public" : "portal";
    return (
      renderShipHero(profile, {
        cruiseLineLogo: options.cruiseLineLogo || "",
        shipImage: options.shipImage || "",
        headingTag: mode === "public" ? "h2" : "h1"
      }) +
      renderShipSummaryCard(profile) +
      renderContentStage(profile)
    );
  }

  function renderUnavailableHtml(message) {
    return `<div class="ci-ship-unavailable"><p class="ship-section-intro">${escapeHtml(message || "Detailed ship information is not available yet.")}</p></div>`;
  }

  async function fetchShip(shipName, cruiseLine) {
    const params = new URLSearchParams();
    params.set("name", shipName);
    if (cruiseLine) params.set("cruise_line", cruiseLine);
    const response = await fetch(`/.netlify/functions/get-ship?${params.toString()}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json().catch(() => ({ success: false, error: "Invalid response" }));
    if (response.status === 404 || response.status === 409 || data.error === "SHIP_NOT_FOUND" || data.error === "SHIP_AMBIGUOUS") {
      return { ok: false, notFound: true, source: data.source || null };
    }
    if (!response.ok || data.success === false || !data.ship) {
      return { ok: false, notFound: false, source: data.source || null };
    }
    return { ok: true, ship: data.ship, source: data.source || null };
  }

  function findShipRoot(container) {
    if (!container) return null;
    return container.classList && container.classList.contains("ship-page")
      ? container
      : container.querySelector(".ship-page") || container;
  }

  function mountPresentation(container, profile, options) {
    options = options || {};
    if (!container) return null;
    const inner = profile
      ? renderPresentationHtml(profile, options)
      : renderUnavailableHtml(options.unavailableMessage);
    const mode = options.mode === "public" ? "public" : "portal";
    if (mode === "public") {
      container.innerHTML = `<div class="ci-ship-presentation ship-page" data-ci-ship-mode="public">${inner}</div>`;
    } else {
      container.innerHTML = inner;
    }
    const page = findShipRoot(container);
    if (page && !options.skipAnimation) {
      initialiseShipPageMotion(page);
    }
    if (page) bindShipSpaceRatioExplainer(page);
    return page;
  }

  function initialiseShipPageMotionScoped(page) {
    return initialiseShipPageMotion(page);
  }

  async function initialiseShipPageMotion(pageEl) {
    const page = pageEl || (typeof document !== "undefined" ? document.querySelector(".ship-page") : null);
    if (!page) return;
    const reducedMotion = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(function () { page.classList.add("is-ready"); });
    if (reducedMotion) {
      await animateShipSummaryStats(page);
      revealShipContentSections(page);
      return;
    }
    await animateShipSummaryStats(page);
    revealShipContentSections(page);
  }

  async function animateShipSummaryStats(pageEl) {
    const scope = pageEl || document;
    const nodes = Array.from(scope.querySelectorAll("[data-ship-stat]"));
    if (!nodes.length) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      nodes.forEach(function (node) {
        node.textContent = formatShipStatValue(Number(node.getAttribute("data-ship-target") || 0), node.getAttribute("data-ship-stat"));
      });
      return;
    }
    const duration = 3000;
    const start = performance.now();
    await Promise.all(nodes.map(function (node, index) {
      const target = Number(node.getAttribute("data-ship-target") || 0);
      const key = node.getAttribute("data-ship-stat");
      const finishBias = 150 + (index / Math.max(nodes.length - 1, 1)) * 100;
      return new Promise(function (resolve) {
        let lastShown = -1;
        const tick = function (now) {
          const elapsed = Math.max(0, now - start);
          const progress = Math.min(1, elapsed / (duration + finishBias));
          const value = Math.round(target * (1 - Math.pow(1 - progress, 3)));
          if (value !== lastShown) {
            lastShown = value;
            node.textContent = formatShipStatValue(value, key);
          }
          if (progress < 1) { requestAnimationFrame(tick); return; }
          node.textContent = formatShipStatValue(target, key);
          resolve();
        };
        requestAnimationFrame(tick);
      });
    }));
  }

  function revealShipContentSections(pageEl) {
    const page = pageEl || document.querySelector(".ship-page");
    if (!page) return;
    page.classList.add("is-content-ready");
    requestAnimationFrame(function () { setupShipDonutAnimation(page); });
  }

  function setupShipDonutAnimation(pageEl) {
    const wrap = (pageEl || document).querySelector(".ship-donut-wrap");
    if (!wrap) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) { animateShipDonutChart(pageEl); return; }
    const observer = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      observer.disconnect();
      animateShipDonutChart(pageEl);
    }, { threshold: 0.35, rootMargin: "0px 0px -8% 0px" });
    observer.observe(wrap);
  }

  function animateShipDonutChart(pageEl) {
    const segments = Array.from((pageEl || document).querySelectorAll(".ship-donut-segment"));
    if (!segments.length) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    segments.forEach(function (segment) {
      const finalDasharray = segment.getAttribute("stroke-dasharray") || "";
      const parts = finalDasharray.split(/\s+/);
      const length = Number(parts[0] || 0);
      const gap = Number(parts[1] || 0);
      if (reducedMotion) { segment.style.opacity = "1"; return; }
      segment.style.strokeDasharray = "0 " + (length + gap);
      segment.style.opacity = "0";
      requestAnimationFrame(function () {
        const delay = getComputedStyle(segment).getPropertyValue("--ship-donut-delay") || "0.3s";
        segment.style.transition = "stroke-dasharray 15s cubic-bezier(0.22, 0.61, 0.36, 1) " + delay + ", opacity 1.4s ease " + delay;
        segment.style.strokeDasharray = finalDasharray;
        segment.style.opacity = "1";
      });
    });
  }

  function bindShipSpaceRatioExplainer(pageEl) {
    const scope = pageEl || document;
    const triggers = Array.from(scope.querySelectorAll("[data-ship-space-ratio-trigger]"));
    if (!triggers.length) return;
    bindShipSpaceRatioExplainerImpl(scope);
  }

  function bindShipSpaceRatioExplainerImpl(scope) {
    const triggers = Array.from(scope.querySelectorAll("[data-ship-space-ratio-trigger]"));
    if (!triggers.length) return;
    let openTrigger = null, openPopover = null, openInline = null;
    const closePopover = function () {
      if (openPopover) { openPopover.hidden = true; openPopover.style.top = ""; openPopover.style.left = ""; openPopover.style.width = ""; restoreSpaceRatioPopover(openPopover); }
      if (openInline) openInline.hidden = true;
      if (openTrigger) openTrigger.setAttribute("aria-expanded", "false");
      openTrigger = openPopover = openInline = null;
    };
    const openExplainer = function (trigger, popover, inlinePanel) {
      closePopover();
      openTrigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      if (isMobileSpaceRatioView()) { inlinePanel.hidden = false; openInline = inlinePanel; return; }
      openPopover = popover;
      requestAnimationFrame(function () { requestAnimationFrame(function () { positionSpaceRatioPopover(trigger, popover); }); });
    };
    const repositionOpenPopover = function () {
      if (!openTrigger || !openPopover || openPopover.hidden || isMobileSpaceRatioView()) return;
      positionSpaceRatioPopover(openTrigger, openPopover);
    };
    if (!root.__shipSpaceRatioExplainerBound) {
      root.__shipSpaceRatioExplainerBound = true;
      document.addEventListener("click", function (event) {
        if (!openTrigger) return;
        const target = event.target;
        if (openPopover && openPopover.contains(target)) return;
        if (openInline && openInline.contains(target)) return;
        if (openTrigger.contains(target)) return;
        closePopover();
      });
      document.addEventListener("keydown", function (event) { if (event.key === "Escape") closePopover(); });
      window.addEventListener("resize", repositionOpenPopover);
      window.addEventListener("scroll", repositionOpenPopover, true);
    }
    triggers.forEach(function (trigger) {
      const group = trigger.closest(".ship-stat-space-ratio-group");
      const control = trigger.closest(".ship-space-ratio-control");
      const popover = control && control.querySelector("[data-ship-space-ratio-popover]");
      const inlinePanel = group && group.querySelector("[data-ship-space-ratio-inline]");
      if (!popover || !inlinePanel) return;
      trigger.addEventListener("click", function (event) {
        event.stopPropagation();
        const isOpen = openTrigger === trigger && ((openPopover && !openPopover.hidden) || (openInline && !openInline.hidden));
        if (isOpen) { closePopover(); return; }
        openExplainer(trigger, popover, inlinePanel);
      });
      popover.addEventListener("click", function (event) { event.stopPropagation(); });
    });
  }

  root.CiShipPresentation = {
    NOT_LISTED: SHIP_NOT_LISTED,
    buildProfile: buildShipProfileFromBase44,
    fetchShip: fetchShip,
    renderPresentationHtml: renderPresentationHtml,
    renderUnavailableHtml: renderUnavailableHtml,
    mountPresentation: mountPresentation,
    initialiseMotion: initialiseShipPageMotion,
    bindSpaceRatioExplainer: bindShipSpaceRatioExplainer
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
